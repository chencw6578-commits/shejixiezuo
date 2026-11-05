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
    `SELECT f.id, f.name, f.status, f.error, f.created_at,
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

filesRouter.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM design_files WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});
