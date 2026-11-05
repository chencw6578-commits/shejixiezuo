import { Router } from 'express';
import { pool } from '../db.js';
import { parseFileKey, getFileMeta } from '../figma/client.js';
import { enqueueImport } from '../jobs/importFile.js';
import { isFigmaConfigured } from '../config.js';

export const filesRouter = Router();

/** 导入 Figma 文件 */
filesRouter.post('/', async (req, res) => {
  const { url } = req.body ?? {};
  if (!isFigmaConfigured()) {
    return res.status(503).json({ error: '服务端未配置 FIGMA_TOKEN，请先在 .env 中设置' });
  }
  const figmaKey = typeof url === 'string' ? parseFileKey(url) : null;
  if (!figmaKey) {
    return res.status(400).json({ error: '无法识别的 Figma 链接，请粘贴形如 https://www.figma.com/design/... 的链接' });
  }
  let name = figmaKey;
  let version: string | null = null;
  try {
    const meta = await getFileMeta(figmaKey);
    name = meta.name;
    version = meta.version ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(502).json({ error: `获取 Figma 文件失败：${message}` });
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO design_files (figma_key, name, version, status) VALUES ($1, $2, $3, 'pending') RETURNING id`,
    [figmaKey, name, version]
  );
  const id = rows[0].id;
  void enqueueImport(id, figmaKey);
  res.json({ id, name, status: 'pending' });
});

/** 文件列表 */
filesRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT f.id, f.name, f.status, f.error, f.source, f.created_at,
            (SELECT count(*) FROM frames fr WHERE fr.file_id = f.id) AS frame_count
     FROM design_files f ORDER BY f.created_at DESC LIMIT 100`
  );
  res.json(rows);
});

/** 文件详情（含画板列表） */
filesRouter.get('/:id', async (req, res) => {
  const file = (
    await pool.query(
      `SELECT id, figma_key, name, version, status, error, created_at FROM design_files WHERE id = $1`,
      [req.params.id]
    )
  ).rows[0];
  if (!file) return res.status(404).json({ error: '文件不存在' });
  const frames = (
    await pool.query(
      `SELECT id, node_id, name, page_name, width, height, thumb_url, sort_order
       FROM frames WHERE file_id = $1 ORDER BY sort_order, name`,
      [req.params.id]
    )
  ).rows;
  res.json({ ...file, frames });
});

/** 画板详情（含全部图层，平铺，客户端组树） */
filesRouter.get('/:id/frames/:frameId', async (req, res) => {
  const frame = (
    await pool.query(
      `SELECT id, file_id, node_id, name, page_name, width, height, thumb_url
       FROM frames WHERE id = $1 AND file_id = $2`,
      [req.params.frameId, req.params.id]
    )
  ).rows[0];
  if (!frame) return res.status(404).json({ error: '画板不存在' });
  const nodes = (
    await pool.query(
      `SELECT id, node_id, parent_id, name, type, x, y, width, height, props
       FROM nodes WHERE frame_id = $1 ORDER BY id`,
      [req.params.frameId]
    )
  ).rows;
  res.json({ frame, nodes });
});

/** 手动同步：版本有变化才重新导入 */
filesRouter.post('/:id/sync', async (req, res) => {
  const file = (
    await pool.query<{ id: string; figma_key: string; version: string | null; status: string }>(
      'SELECT id, figma_key, version, status FROM design_files WHERE id = $1',
      [req.params.id]
    )
  ).rows[0];
  if (!file) return res.status(404).json({ error: '文件不存在' });
  if (file.status === 'pending' || file.status === 'processing') {
    return res.status(409).json({ error: '文件正在处理中，请稍候' });
  }
  try {
    const meta = await getFileMeta(file.figma_key);
    if (file.status === 'ready' && meta.version === file.version) {
      return res.json({ updated: false, version: meta.version });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(502).json({ error: `获取 Figma 文件失败：${message}` });
  }
  await pool.query("UPDATE design_files SET status = 'pending', error = NULL WHERE id = $1", [file.id]);
  void enqueueImport(file.id, file.figma_key);
  res.json({ updated: true });
});

/** 设计规范聚合：色板 / 渐变 / 字体 */
filesRouter.get('/:id/spec', async (req, res) => {
  const file = (
    await pool.query('SELECT id, name FROM design_files WHERE id = $1', [req.params.id])
  ).rows[0];
  if (!file) return res.status(404).json({ error: '文件不存在' });

  const { rows } = await pool.query<{ props: {
    fills?: { type: string; visible: boolean; color?: { hex: string; rgba: string; alpha: number }; css?: string }[];
    text?: { family?: string; size?: number; weight?: number; lineHeight?: number };
  } }>('SELECT props FROM nodes WHERE file_id = $1', [req.params.id]);

  const colors = new Map<string, { hex: string; rgba: string; alpha: number; count: number }>();
  const gradients = new Map<string, { css: string; count: number }>();
  const fonts = new Map<string, { family: string; size: number; weight: number; count: number }>();
  let imageFillCount = 0;

  for (const { props } of rows) {
    for (const f of props.fills ?? []) {
      if (!f.visible) continue;
      if (f.type === 'solid' && f.color) {
        const c = colors.get(f.color.hex) ?? { ...f.color, count: 0 };
        c.count++;
        colors.set(f.color.hex, c);
      } else if (f.type === 'gradient' && f.css) {
        const g = gradients.get(f.css) ?? { css: f.css, count: 0 };
        g.count++;
        gradients.set(f.css, g);
      } else if (f.type === 'image') {
        imageFillCount++;
      }
    }
    const t = props.text;
    if (t?.family && t.size) {
      const key = `${t.family}|${t.size}|${t.weight ?? 400}`;
      const f = fonts.get(key) ?? { family: t.family, size: t.size, weight: t.weight ?? 400, count: 0 };
      f.count++;
      fonts.set(key, f);
    }
  }

  const byCountDesc = <T extends { count: number }>(m: Map<string, T>) =>
    [...m.values()].sort((a, b) => b.count - a.count);

  res.json({
    colors: byCountDesc(colors).slice(0, 80),
    gradients: byCountDesc(gradients).slice(0, 24),
    fonts: byCountDesc(fonts).slice(0, 40),
    stats: { nodeCount: rows.length, imageFillCount },
  });
});

filesRouter.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM design_files WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});
