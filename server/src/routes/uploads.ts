import multer from 'multer';
import { Router } from 'express';
import { pool } from '../db.js';
import { enqueue } from '../queue.js';
import { importSketch } from '../sketch/import.js';
import { importPsd } from '../psd/import.js';
import { getStorage } from '../storage/index.js';

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
  const ext = (file.originalname.match(/\.(sketch|psd|fig)$/i) ?? [])[0]?.toLowerCase();
  const source = ext ? EXTS[ext] : null;
  if (!source) {
    if (/\.fig$/i.test(file.originalname)) {
      return res.status(400).json({
        error:
          '.fig 是 Figma 私有二进制格式（无公开解析规范），无法直接解析。请改用 Figma 导入：在首页粘贴文件链接（需配置 FIGMA_TOKEN），即可获得完整图层数据。',
      });
    }
    return res.status(400).json({ error: '仅支持 .sketch / .psd 文件' });
  }

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

// ---------- 剪贴板导入 ----------

/** 粘贴图片导入：一张图 = 一个画板（图层树为单个图片填充背景，支持标注/评论/切图整图导出） */
uploadsRouter.post('/image', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: '未收到图片' });
    if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.mimetype)) {
      return res.status(400).json({ error: '剪贴板里不是图片，仅支持 PNG/JPG/WebP/GIF' });
    }
    const projectId = typeof req.body?.projectId === 'string' && req.body.projectId ? req.body.projectId : null;
    if (projectId) {
      const p = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
      if (!p.rows[0]) return res.status(404).json({ error: '项目不存在' });
    }
    const width = Math.max(1, Math.round(Number(req.body?.width) || 800));
    const height = Math.max(1, Math.round(Number(req.body?.height) || 600));
    const name =
      (typeof req.body?.name === 'string' && req.body.name.trim()) ||
      `剪贴板导入 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;

    const figmaKey = `CLIP-${Date.now().toString(36)}`;
    const { rows: [f] } = await pool.query<{ id: string }>(
      `INSERT INTO design_files (figma_key, name, version, status, source, project_id)
       VALUES ($1, $2, 'clip-v1', 'ready', 'image', $3) RETURNING id`,
      [figmaKey, name, projectId]
    );

    const storage = await getStorage();
    const ext = file.mimetype === 'image/jpeg' ? 'jpg' : (file.mimetype.split('/')[1] ?? 'png');
    const url = await storage.put(`files/${f.id}/frames/${figmaKey}@1x.${ext}`, file.buffer, file.mimetype);

    const { rows: [fr] } = await pool.query<{ id: string }>(
      `INSERT INTO frames (file_id, node_id, name, page_name, width, height, thumb_url, sort_order)
       VALUES ($1, $2, $3, '剪贴板', $4, $5, $6, 0) RETURNING id`,
      [f.id, `${figmaKey}:frame`, name, width, height, url]
    );
    await pool.query(
      `INSERT INTO nodes (file_id, frame_id, node_id, parent_id, name, type, x, y, width, height, visible, props)
       VALUES ($1, $2, $3, NULL, '导入图片', 'RECTANGLE', 0, 0, $4, $5, TRUE, $6)`,
      [f.id, fr.id, `${figmaKey}:image`, width, height,
       JSON.stringify({ fills: [{ type: 'IMAGE', visible: true, imageRef: url, scaleMode: 'FILL' }], exportPresets: [{ format: 'PNG', suffix: '@2x', scale: 2 }] })]
    );
    res.json({ id: f.id, name, frames: 1 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[upload/image] failed:', message);
    res.status(500).json({ error: message });
  }
});

/** 解析 Figma 图层剪贴板：text/html 中的 figmeta 段（base64 JSON）含 fileKey/fileName。
 *  矢量图层数据在 figma 段（kiwi 私有二进制）中，暂不解析——引导走 API 导入。 */
uploadsRouter.post('/figma-clipboard', async (req, res) => {
  const html = (req.body as { html?: string }).html ?? '';
  const m = html.match(/<!--\(figmeta\)([\s\S]*?)\(\/figmeta\)-->/);
  if (!m) return res.status(400).json({ error: '剪贴板中没有 Figma 数据（可先在 Figma 里复制图层/页面）' });
  try {
    const meta = JSON.parse(Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf8')) as {
      fileKey?: string;
      fileName?: string;
    };
    if (!meta.fileKey) return res.status(400).json({ error: 'figmeta 中缺少 fileKey' });
    const url = `https://www.figma.com/file/${meta.fileKey}${meta.fileName ? `/${encodeURIComponent(meta.fileName)}` : ''}`;
    res.json({ fileKey: meta.fileKey, fileName: meta.fileName ?? '', url });
  } catch {
    res.status(400).json({ error: 'figmeta 解析失败' });
  }
});
