import type { PoolClient } from 'pg';
import { pool } from '../db.js';
import { enqueue } from '../queue.js';
import { downloadImage, getImages, getFile, type FileResponse } from '../figma/client.js';
import { parseFile, thumbScale } from '../figma/parse.js';
import { getStorage } from '../storage/index.js';

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

/** 分块多行 INSERT，绕开 65535 参数上限。 */
async function batchInsert(
  client: PoolClient,
  sqlHead: string,
  rows: unknown[][],
  chunkSize = 400
) {
  const cols = sqlHead.match(/\(([^)]+)\)/)?.[1].split(',').length ?? 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values: unknown[] = [];
    const tuples = chunk.map((row, r) => {
      const ph = row.map((_, c) => `$${r * cols + c + 1}`);
      values.push(...row);
      return `(${ph.join(',')})`;
    });
    await client.query(`${sqlHead} VALUES ${tuples.join(',')}`, values as unknown[]);
  }
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
            ]);
          }
        }
        if (nodeRows.length > 0) {
          await batchInsert(
            client,
            `INSERT INTO nodes (file_id, frame_id, node_id, parent_id, name, type, x, y, width, height, visible, props)`,
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
