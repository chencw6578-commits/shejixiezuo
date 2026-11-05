import multer from 'multer';
import { Router } from 'express';
import { pool } from '../db.js';
import { enqueue } from '../queue.js';
import { importSketch } from '../sketch/import.js';
import { importPsd } from '../psd/import.js';

export const uploadsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 300 * 1024 * 1024 },
});

const EXTS: Record<string, 'sketch' | 'psd'> = {
  '.sketch': 'sketch',
  '.psd': 'psd',
};

async function setStatus(fileId: string, status: string, error?: string) {
  await pool.query('UPDATE design_files SET status = $2, error = $3 WHERE id = $1', [fileId, status, error ?? null]);
}

/** 上传 .sketch / .psd 文件导入（可指定所属项目，表单字段 projectId） */
uploadsRouter.post('/', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: '未收到文件' });
  const ext = (file.originalname.match(/\.(sketch|psd)$/i) ?? [])[0]?.toLowerCase();
  const source = ext ? EXTS[ext] : null;
  if (!source) return res.status(400).json({ error: '仅支持 .sketch / .psd 文件' });

  const projectId = typeof req.body?.projectId === 'string' && req.body.projectId ? req.body.projectId : null;
  if (projectId) {
    const p = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    if (!p.rows[0]) return res.status(404).json({ error: '项目不存在' });
  }

  const name = file.originalname.replace(/\.(sketch|psd)$/i, '');
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO design_files (figma_key, name, status, source, project_id) VALUES ($1, $2, 'processing', $3, $4) RETURNING id`,
    [file.originalname, name, source, projectId]
  );
  const fileId = rows[0].id;

  void enqueue(async () => {
    try {
      const r = source === 'sketch' ? await importSketch(fileId, file.buffer) : await importPsd(fileId, file.buffer, name);
      await setStatus(fileId, 'ready');
      console.log(`[upload] ${source} ${file.originalname}: ${r.frames} frames, ${r.nodes} nodes`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[upload] ${source} ${file.originalname} failed:`, message);
      await setStatus(fileId, 'failed', message).catch(() => {});
    }
  });

  res.json({ id: fileId, name, status: 'processing', source });
});
