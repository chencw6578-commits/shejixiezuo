import { createRequire } from 'node:module';
import { writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pool } from '../db.js';
import { getStorage } from '../storage/index.js';
import { batchInsert } from '../util/batchInsert.js';

const require = createRequire(import.meta.url);

interface TreeNode {
  name(): string;
  isGroup(): boolean;
  isRoot(): boolean;
  children(): TreeNode[];
  coords(): { left: number; top: number; right: number; bottom: number } | null;
  get(key: string): unknown;
}

/**
 * PSD 导入（尽力而为）：
 * - 画板 = 整张画布（PSD 无画板概念），底图用 PSD 内嵌的合并渲染位图
 * - 图层树取 name/type/包围盒/透明度/文本内容，颜色通道暂不解析
 */
export async function importPsd(fileId: string, buf: Buffer, fileName: string): Promise<{ frames: number; nodes: number }> {
  const PSD = require('psd');
  const { PNG } = require('pngjs');

  // psd.js 无 fromBuffer，写临时文件后用 open() 解析
  const tmpPath = path.join(os.tmpdir(), `designhub-${fileId}.psd`);
  await writeFile(tmpPath, buf);
  try {
    const psd = (await PSD.open(tmpPath)) as {
      parse(): Promise<void>;
      header?: { width: number; height: number };
      image: { toPng(): { width: number; height: number } };
      tree(): TreeNode;
    };
    await psd.parse();

    // 合成图 → PNG
    const png = psd.image.toPng();
    const pngBuf = PNG.sync.write(png as never);
    const width = Number(psd.header?.width ?? png.width);
    const height = Number(psd.header?.height ?? png.height);

    const storage = await getStorage();
    const thumbUrl = await storage.put(`files/${fileId}/frames/psd-composite.png`, pngBuf, 'image/png');

    // 遍历图层树
    const tree = psd.tree();
    return await insertPsdData(fileId, tree, fileName, width, height, thumbUrl);
  } finally {
    await rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

async function insertPsdData(
  fileId: string,
  tree: TreeNode,
  fileName: string,
  width: number,
  height: number,
  thumbUrl: string
): Promise<{ frames: number; nodes: number }> {
  const flat: { id: string; parentId: string | null; name: string; type: string; x: number; y: number; w: number; h: number; opacity: number; text?: Record<string, unknown> }[] = [];
  const walk = (node: TreeNode, parentId: string | null) => {
    for (const child of node.children() ?? []) {
      try {
        const c = child.coords();
        const id = `psd:${flat.length}`;
        const text = extractText(child);
        flat.push({
          id, parentId,
          name: child.name() || '图层',
          type: child.isGroup() ? 'GROUP' : text ? 'TEXT' : 'LAYER',
          x: c?.left ?? 0, y: c?.top ?? 0,
          w: c ? c.right - c.left : 0, h: c ? c.bottom - c.top : 0,
          opacity: Number(child.get('fillOpacity') ?? child.get('opacity') ?? 1),
          text,
        });
        if (child.isGroup()) walk(child, id);
      } catch {
        // 单个图层解析失败不影响整体
      }
    }
  };
  walk(tree, null);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM frames WHERE file_id = $1', [fileId]);
    await batchInsert(
      client,
      `INSERT INTO frames (file_id, node_id, name, page_name, width, height, thumb_url, sort_order)`,
      [[fileId, 'psd:canvas', fileName, 'PSD', width, height, thumbUrl, 0]]
    );
    const { rows: fr } = await client.query<{ id: string }>('SELECT id FROM frames WHERE file_id = $1', [fileId]);
    const frameRowId = fr[0].id;

    await batchInsert(
      client,
      `INSERT INTO nodes (file_id, frame_id, node_id, parent_id, name, type, x, y, width, height, visible, props)`,
      flat.map((l) => [
        fileId, frameRowId, l.id, l.parentId ?? 'psd:canvas', l.name, l.type,
        l.x, l.y, l.w, l.h, true,
        JSON.stringify({ opacity: l.opacity, ...(l.text ? { text: l.text } : {}) }),
      ])
    );
    await client.query('COMMIT');
    return { frames: 1, nodes: flat.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function extractText(node: TreeNode): Record<string, unknown> | undefined {
  try {
    // psd.js 文本图层：get('text') 返回 { value/textValue, font/fonts, size... }，不同版本字段名有差异，做防御式读取
    const t = node.get('text') as Record<string, unknown> | undefined;
    const content = (t?.value ?? t?.textValue) as string | undefined;
    if (!content) return undefined;
    const fonts = (t?.font ?? t?.fonts) as unknown;
    const family = Array.isArray(fonts) ? String(fonts[0]) : typeof fonts === 'string' ? fonts : undefined;
    const size = Number((t?.size as number | number[] | undefined) ?? (Array.isArray(t?.sizes) ? (t?.sizes as number[])[0] : undefined)) || undefined;
    return { content: String(content), family, size };
  } catch {
    return undefined;
  }
}
