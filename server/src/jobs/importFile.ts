import type { PoolClient } from 'pg';
import { pool } from '../db.js';
import { enqueue } from '../queue.js';
import { downloadImage, getImages, getFile, type FileResponse } from '../figma/client.js';
import { parseFile, thumbScale } from '../figma/parse.js';
import { getStorage } from '../storage/index.js';
import { batchInsert } from '../util/batchInsert.js';

interface FrameRow {
  nodeId: string;
  name: string;
  pageName: string;
  width: number;
  height: number;
  sortOrder: number;
  layers: unknown[];
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
};

async function updateStatus(
  fileId: string,
  status: string,
  error?: string
) {
  await pool.query('UPDATE design_files SET status = $2, error = $3 WHERE id = $1', [
    fileId,
    status,
    error ?? null,
  ]);
}

async function processImport(fileId: string, figmaKey: string): Promise<void> {
  try {
    await updateStatus(fileId, 'processing');

    const file: FileResponse = await getFile(figmaKey);
    const frames: FrameRow[] = parseFile(file) as FrameRow[];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE design_files SET raw = $2, version = $3, name = $4 WHERE id = $1', [
        fileId,
        JSON.stringify(file),
        file.version,
        file.name,
      ]);
      await client.query('DELETE FROM frames WHERE file_id = $1', [fileId]);

      if (frames.length > 0) {
        // 画板
        await batchInsert(
          client,
          `INSERT INTO frames (file_id, node_id, name, page_name, width, height, sort_order)`,
          frames.map((f) => [fileId, f.nodeId, f.name, f.pageName, f.width, f.height, f.sortOrder])
        );
        const { rows } = await client.query<{ id: string; node_id: string }>(
          'SELECT id, node_id FROM frames WHERE file_id = $1',
          [fileId]
        );
        const frameIdByNode = new Map(rows.map((r) => [r.node_id, r.id]));

        // 图层
        const nodeRows: unknown[][] = [];
        for (const f of frames) {
          const frameId = frameIdByNode.get(f.nodeId);
          if (!frameId) continue;
          for (const layer of f.layers as {
            nodeId: string; parentId: string; name: string; type: string;
            x: number; y: number; width: number; height: number; props: unknown;
          }[]) {
            nodeRows.push([
              fileId, frameId, layer.nodeId, layer.parentId, layer.name, layer.type,
              layer.x, layer.y, layer.width, layer.height, true,
              JSON.stringify(layer.props ?? {}),
              null,
            ]);
          }
        }
        if (nodeRows.length > 0) {
          await batchInsert(
            client,
            `INSERT INTO nodes (file_id, frame_id, node_id, parent_id, name, type, x, y, width, height, visible, props, render_url)`,
            nodeRows
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await generateThumbnails(fileId, figmaKey, frames);
    await generateNodeRenders(fileId, figmaKey, frames);
    await updateStatus(fileId, 'ready');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[import] file ${fileId} failed:`, message);
    await updateStatus(fileId, 'failed', message).catch(() => {});
    throw err;
  }
}

/** 生成画板缩略图（渲染 PNG），按倍率分组调用 images API。 */
async function generateThumbnails(fileId: string, figmaKey: string, frames: FrameRow[]) {
  if (frames.length === 0) return;
  const storage = await getStorage();

  // 按导出倍率分组，减少 API 调用
  const byScale = new Map<number, FrameRow[]>();
  for (const f of frames) {
    const scale = thumbScale(f.width, f.height);
    const list = byScale.get(scale) ?? [];
    list.push(f);
    byScale.set(scale, list);
  }

  for (const [scale, group] of byScale) {
    // images API 单次 id 数量上限，分块
    for (let i = 0; i < group.length; i += 50) {
      const chunk = group.slice(i, i + 50);
      const res = await getImages(figmaKey, chunk.map((f) => f.nodeId), 'png', scale);
      await Promise.all(
        chunk.map(async (f) => {
          const url = res.images[f.nodeId];
          if (!url) return;
          try {
            const buf = await downloadImage(url);
            const key = `files/${fileId}/frames/${f.nodeId}@${scale}x.png`;
            const storedUrl = await storage.put(key, buf, CONTENT_TYPES.png);
            await pool.query('UPDATE frames SET thumb_url = $2 WHERE file_id = $1 AND node_id = $3', [
              fileId, storedUrl, f.nodeId,
            ]);
          } catch (err) {
            console.warn(`[import] thumbnail failed for ${f.nodeId}:`, err);
          }
        })
      );
    }
  }
}

/** 提交导入任务。 */
export function enqueueImport(fileId: string, figmaKey: string): Promise<void> {
  return enqueue(() => processImport(fileId, figmaKey));
}

/** 需要 SVG 渲染的矢量类节点：CSS 无法表达形状本身。 */
const SVG_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'LINE', 'REGULAR_POLYGON', 'STAR']);

interface RenderJob {
  nodeId: string;
  format: 'svg' | 'png';
  scale: number;
}

/** 挑出 CSS 近似不够的节点：矢量类导 SVG，图片填充导位图。 */
function collectRenderJobs(frames: FrameRow[]): RenderJob[] {
  const jobs = new Map<string, RenderJob>();
  for (const f of frames) {
    for (const layer of f.layers as {
      nodeId: string; type: string; width: number; height: number; props: { hasImageFill?: boolean };
    }[]) {
      if (SVG_TYPES.has(layer.type)) {
        jobs.set(layer.nodeId, { nodeId: layer.nodeId, format: 'svg', scale: 1 });
      } else if (layer.props?.hasImageFill) {
        // 位图按节点尺寸选倍率，避免超出 Figma 渲染上限
        jobs.set(layer.nodeId, {
          nodeId: layer.nodeId,
          format: 'png',
          scale: thumbScale(layer.width, layer.height),
        });
      }
    }
  }
  return [...jobs.values()];
}

/**
 * 生成节点渲染资产：矢量节点导 SVG（无限缩放、自带描边），
 * 图片填充节点按倍率导 PNG 落 storage，写入 nodes.render_url 供前端替代占位框。
 */
async function generateNodeRenders(fileId: string, figmaKey: string, frames: FrameRow[]) {
  const jobs = collectRenderJobs(frames);
  if (jobs.length === 0) return;
  const storage = await getStorage();

  const run = async (format: 'svg' | 'png', scale: number, group: RenderJob[]) => {
    for (let i = 0; i < group.length; i += 50) {
      const chunk = group.slice(i, i + 50);
      const res = await getImages(figmaKey, chunk.map((j) => j.nodeId), format, scale);
      await Promise.all(
        chunk.map(async (j) => {
          const url = res.images[j.nodeId];
          if (!url) return;
          try {
            const buf = await downloadImage(url);
            const ext = format === 'svg' ? 'svg' : 'png';
            const key =
              format === 'svg'
                ? `files/${fileId}/nodes/${j.nodeId}.svg`
                : `files/${fileId}/nodes/${j.nodeId}@${scale}x.png`;
            const storedUrl = await storage.put(key, buf, CONTENT_TYPES[ext]);
            await pool.query(
              'UPDATE nodes SET render_url = $2 WHERE file_id = $1 AND node_id = $3',
              [fileId, storedUrl, j.nodeId]
            );
          } catch (err) {
            console.warn(`[import] node render failed for ${j.nodeId}:`, err);
          }
        })
      );
    }
  };

  const svgJobs = jobs.filter((j) => j.format === 'svg');
  const pngByScale = new Map<number, RenderJob[]>();
  for (const j of jobs.filter((j) => j.format === 'png')) {
    const list = pngByScale.get(j.scale) ?? [];
    list.push(j);
    pngByScale.set(j.scale, list);
  }

  // svg 一次全量（无倍率维度）；png 按倍率分批
  await run('svg', 1, svgJobs);
  for (const [scale, group] of pngByScale) await run('png', scale, group);
}
