import { Router } from 'express';
import { pool } from '../db.js';
import { downloadImage, getImages } from '../figma/client.js';
import { getStorage } from '../storage/index.js';

export const assetsRouter = Router();

const FORMATS = new Set(['PNG', 'SVG', 'PDF', 'JPG']);
const CONTENT_TYPES: Record<string, string> = {
  PNG: 'image/png',
  SVG: 'image/svg+xml',
  JPG: 'image/jpeg',
  PDF: 'application/pdf',
};

const safeName = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'asset';

/** 导出单个图层切图 */
assetsRouter.post('/export', async (req, res) => {
  const { fileId, nodeId, format = 'PNG', scale = 2, name } = req.body ?? {};
  if (!fileId || !nodeId) return res.status(400).json({ error: '缺少 fileId 或 nodeId' });
  if (!FORMATS.has(format)) return res.status(400).json({ error: `不支持的格式: ${format}` });
  const s = Number(scale);
  if (!(s >= 0.5 && s <= 4)) return res.status(400).json({ error: 'scale 取值范围 0.5-4' });

  const file = (
    await pool.query<{ figma_key: string }>(
      'SELECT figma_key FROM design_files WHERE id = $1',
      [fileId]
    )
  ).rows[0];
  if (!file) return res.status(404).json({ error: '文件不存在' });

  const ext = format.toLowerCase();
  const result = await getImages(file.figma_key, [nodeId], ext as 'png' | 'svg' | 'pdf' | 'jpg', s);
  const url = result.images[nodeId];
  if (!url) {
    return res.status(502).json({ error: `Figma 导出失败：${result.err ?? '节点不可导出'}` });
  }
  const buf = await downloadImage(url);
  const storage = await getStorage();
  const key = `assets/${fileId}/${Date.now()}-${safeName(name ?? nodeId)}${s !== 1 ? `@${s}x` : ''}.${ext}`;
  const storedUrl = await storage.put(key, buf, CONTENT_TYPES[format]);

  const { rows } = await pool.query(
    `INSERT INTO assets (file_id, node_id, name, format, scale, url)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, url, format, scale, created_at`,
    [fileId, nodeId, name ?? nodeId, format, s, storedUrl]
  );
  res.json({ ...rows[0], size: buf.length });
});

/** 某文件的切图历史 */
assetsRouter.get('/file/:fileId', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, node_id, name, format, scale, url, created_at
     FROM assets WHERE file_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [req.params.fileId]
  );
  res.json(rows);
});
