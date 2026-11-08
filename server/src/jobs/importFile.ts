import type { PoolClient } from 'pg';
import { pool } from '../db.js';
import { enqueue } from '../queue.js';
import {
  downloadImage,
  getFile,
  getFileDepth,
  getImages,
  getNodes,
  FigmaApiError,
  type FigmaNode,
} from '../figma/client.js';
import {
  childrenOf,
  isArtboardType,
  parseFile,
  parseNodeSubtree,
  thumbScale,
  type ParsedFrame,
} from '../figma/parse.js';
import { config } from '../config.js';
import { getStorage } from '../storage/index.js';
import { batchInsert } from '../util/batchInsert.js';

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
};

/** /nodes 单次请求最多带多少个节点 id（几百个画板的大文件必须分批） */
const NODE_BATCH = 30;

/** 一次导入所需的上下文：可选节点（链接里的 node-id）与用户个人令牌 */
export interface ImportOptions {
  nodeId?: string | null;
  /** 用户个人令牌；为空时用服务端 FIGMA_TOKEN */
  token?: string;
  /** POST 预检阶段已经拉好并解析完的结果：直接落库，避免二次请求 Figma */
  prefetched?: PrefetchedImport;
}

/** 一次导入的解析结果 */
export interface PrefetchedImport {
  name: string;
  version: string | null;
  frames: ParsedFrame[];
  raw: unknown;
}

/** 把令牌从错误信息里抹掉，保证日志/数据库里不出现完整令牌 */
function sanitize(message: string, userToken?: string): string {
  const tokens = [(config.figmaToken ?? '').trim(), (userToken ?? '').trim()];
  let out = message;
  for (const t of tokens) {
    if (t && t.length >= 8) out = out.split(t).join('***');
  }
  return out;
}

/** 生成可反馈给用户的错误编号：只用于文案与日志关联，不含堆栈 */
export function newErrorId(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

/** 未知错误的统一可读文案（原生 TypeError 等不直接展示给用户） */
export function userFacingFailure(errId: string): string {
  return `导入失败，已记录错误编号 ${errId}，请稍后重试或把这个编号反馈给我们`;
}

/** 已知的 Figma 错误自带可操作文案，其余一律编号化 */
function isKnownError(err: unknown): boolean {
  return err instanceof FigmaApiError || (err as { name?: string } | null)?.name === 'TimeoutError';
}

async function updateStatus(fileId: string, status: string, error?: string) {
  await pool.query('UPDATE design_files SET status = $2, error = $3 WHERE id = $1', [
    fileId,
    status,
    error ?? null,
  ]);
}

/**
 * 只请求需要的节点并解析：
 * - 带 node-id：GET /files/:key/nodes?ids=<nodeId>，解析该子树
 * - 不带：先 depth=2 拿到页面/画板 id，再 GET nodes?ids=<画板 id>
 * 任何 Figma 错误都抛出 FigmaApiError，由路由映射成可操作提示。
 */
export async function fetchImportData(
  figmaKey: string,
  opts: ImportOptions = {}
): Promise<PrefetchedImport> {
  const token = (opts.token ?? '').trim() || undefined;

  if (opts.nodeId) {
    const res = await getNodes(figmaKey, [opts.nodeId], token);
    const entry = res.nodes?.[opts.nodeId];
    if (!entry?.document) throw new FigmaApiError(404, '指定画板不存在或不可访问');
    const doc = entry.document;
    return {
      name: res.name || figmaKey,
      version: res.version ?? null,
      frames: parseNodeSubtree(doc, doc.name || figmaKey),
      raw: { name: res.name, version: res.version, nodes: { [opts.nodeId]: doc } },
    };
  }

  // 先浅拉一层（页面 + 页面下一层画板/SECTION），只把真正需要的画板节点拉全
  let shallow: { name: string; version: string; document: FigmaNode };
  try {
    shallow = await getFileDepth(figmaKey, 2, token);
  } catch (err) {
    if (err instanceof FigmaApiError && err.status !== 0) throw err;
    shallow = await getFile(figmaKey, token);
  }

  const pages = childrenOf(shallow.document).filter(
    (p) => p.type === 'PAGE' || p.type === 'CANVAS'
  );
  const ids: string[] = [];
  for (const page of pages) {
    for (const child of childrenOf(page)) {
      if (child.visible === false) continue;
      // SECTION 自身不是画板，但它的子树里可能有画板，整段取回后代解析
      if (child.type === 'SECTION' || isArtboardType(child.type)) ids.push(child.id);
    }
  }

  if (!ids.length) {
    // 没有可识别画板（或结构异常）：退回完整文件，保持原有行为
    const full = await getFile(figmaKey, token);
    return {
      name: full.name,
      version: full.version ?? null,
      frames: parseFile(full),
      raw: full,
    };
  }

  // 大文件按 node id 分批拉取：一次请求太多画板容易超过响应时间
  const merged: Record<string, { document: FigmaNode } | null> = {};
  for (let i = 0; i < ids.length; i += NODE_BATCH) {
    const chunk = ids.slice(i, i + NODE_BATCH);
    const part = await getNodes(figmaKey, chunk, token);
    Object.assign(merged, part.nodes ?? {});
  }
  const document: FigmaNode = {
    ...shallow.document,
    children: pages.map((page) => ({
      ...page,
      children: childrenOf(page).map((child) => merged[child.id]?.document ?? child),
    })),
  };
  const synthesized = {
    name: shallow.name,
    version: shallow.version ?? '',
    document,
  };
  return {
    name: shallow.name,
    version: shallow.version ?? null,
    frames: parseFile(synthesized),
    raw: synthesized,
  };
}

async function processImport(fileId: string, figmaKey: string, opts: ImportOptions = {}): Promise<void> {
  try {
    await updateStatus(fileId, 'processing');

    const data: PrefetchedImport = opts.prefetched ?? (await fetchImportData(figmaKey, opts));

    await writeFrames(fileId, data);
    await generateThumbnails(fileId, figmaKey, data.frames, opts.token);
    await generateNodeRenders(fileId, figmaKey, data.frames, opts.token);
    await updateStatus(fileId, 'ready');
  } catch (err) {
    const known = isKnownError(err);
    const message = known
      ? sanitize(err instanceof Error ? err.message : String(err), opts.token)
      : userFacingFailure(newErrorId());
    // 完整堆栈只进后端日志（令牌已脱敏），数据库只存可读文案
    if (known) {
      console.error(`[import] file ${fileId} figma=${figmaKey} failed: ${message}`);
    } else {
      console.error(`[import] file ${fileId} figma=${figmaKey} failed: ${message}`, err);
    }
    await updateStatus(fileId, 'failed', message).catch(() => {});
    throw err;
  }
}

/** 把解析结果写入 frames/nodes（事务内替换该文件的画板与节点，失败整体回滚） */
export async function writeFrames(
  fileId: string,
  data: PrefetchedImport
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE design_files SET raw = $2, version = $3, name = $4 WHERE id = $1', [
      fileId,
      JSON.stringify(data.raw ?? {}),
      data.version,
      data.name,
    ]);
    await client.query('DELETE FROM frames WHERE file_id = $1', [fileId]);

    if (data.frames.length > 0) {
      await batchInsert(
        client,
        `INSERT INTO frames (file_id, node_id, name, page_name, width, height, sort_order)`,
        data.frames.map((f) => [fileId, f.nodeId, f.name, f.pageName, f.width, f.height, f.sortOrder])
      );
      const { rows } = await client.query<{ id: string; node_id: string }>(
        'SELECT id, node_id FROM frames WHERE file_id = $1',
        [fileId]
      );
      const frameIdByNode = new Map(rows.map((r) => [r.node_id, r.id]));

      const nodeRows: unknown[][] = [];
      for (const f of data.frames) {
        const frameId = frameIdByNode.get(f.nodeId);
        if (!frameId) continue;
        for (const layer of f.layers) {
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
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 生成画板缩略图（渲染 PNG），按倍率分组调用 images API。 */
async function generateThumbnails(
  fileId: string,
  figmaKey: string,
  frames: ParsedFrame[],
  userToken?: string
) {
  if (frames.length === 0) return;
  const storage = await getStorage();
  const token = (userToken ?? '').trim() || undefined;

  // 按导出倍率分组，减少 API 调用
  const byScale = new Map<number, ParsedFrame[]>();
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
      let res;
      try {
        res = await getImages(figmaKey, chunk.map((f) => f.nodeId), 'png', scale, token);
      } catch (err) {
        // 缩略图失败不影响导入成功
        console.warn('[import] thumbnails skipped:', sanitize(err instanceof Error ? err.message : String(err), token));
        return;
      }
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

/** 提交导入任务。失败已在 processImport 里落库并记日志，这里吞掉 rejection 避免未捕获异常杀进程。 */
export function enqueueImport(
  fileId: string,
  figmaKey: string,
  opts: ImportOptions = {}
): Promise<void> {
  return enqueue(() => processImport(fileId, figmaKey, opts)).then(
    () => undefined,
    () => undefined
  );
}

/** 需要 SVG 渲染的矢量类节点：CSS 无法表达形状本身。 */
const SVG_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'LINE', 'REGULAR_POLYGON', 'STAR']);

interface RenderJob {
  nodeId: string;
  format: 'svg' | 'png';
  scale: number;
}

/** 挑出 CSS 近似不够的节点：矢量类导 SVG，图片填充导位图。 */
function collectRenderJobs(frames: ParsedFrame[]): RenderJob[] {
  const jobs = new Map<string, RenderJob>();
  for (const f of frames) {
    for (const layer of f.layers) {
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
async function generateNodeRenders(
  fileId: string,
  figmaKey: string,
  frames: ParsedFrame[],
  userToken?: string
) {
  const jobs = collectRenderJobs(frames);
  if (jobs.length === 0) return;
  const storage = await getStorage();
  const token = (userToken ?? '').trim() || undefined;

  const run = async (format: 'svg' | 'png', scale: number, group: RenderJob[]) => {
    for (let i = 0; i < group.length; i += 50) {
      const chunk = group.slice(i, i + 50);
      const res = await getImages(figmaKey, chunk.map((j) => j.nodeId), format, scale, token);
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
