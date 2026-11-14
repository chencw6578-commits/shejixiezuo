import multer from 'multer';
import { Router, type Request, type Response } from 'express';
import { pool } from '../db.js';
import { enqueue } from '../queue.js';
import { importSketch } from '../sketch/import.js';
import { importPsd } from '../psd/import.js';
import { getStorage } from '../storage/index.js';
import { config } from '../config.js';
import { editGuard } from './authz.js';
import { presignRouter, isValidUploadKey, removeUploaded } from './presign.js';

export const uploadsRouter = Router();

// 预签名直传（Vercel 4.5MB 请求体限制）；local 存储模式下返回 mode=multipart
uploadsRouter.use(presignRouter);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 300 * 1024 * 1024 },
});

const EXTS: Record<string, 'sketch' | 'psd'> = {
  '.sketch': 'sketch',
  '.psd': 'psd',
};

interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function respondError(res: Response, err: unknown) {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 500) console.error('[upload] failed:', message);
  res.status(status).json({ error: message });
}

function projectIdOf(body: unknown): string | null {
  const v = (body as { projectId?: unknown } | null)?.projectId;
  return typeof v === 'string' && v ? v : null;
}

async function setStatus(fileId: string, status: string, error?: string) {
  await pool.query('UPDATE design_files SET status = $2, error = $3 WHERE id = $1', [fileId, status, error ?? null]);
}

async function assertProject(projectId: string | null, req: Request) {
  if (!projectId) return;
  const p = await pool.query<{ team_id: string | null }>('SELECT team_id FROM projects WHERE id = $1', [projectId]);
  if (!p.rows[0]) throw new HttpError(404, '项目不存在');
  const denied = await editGuard(p.rows[0].team_id, req);
  if (denied) throw new HttpError(403, denied);
}

/**
 * 设计稿导入核心逻辑，multipart 上传与对象存储直传共用。
 * 文件本体只在内存里做解析，入库的是图层结构化数据，缩略图/切图写入 Storage。
 */
async function createDesignImport(file: UploadedFile, projectId: string | null, req: Request) {
  const ext = (file.originalname.match(/\.(sketch|psd|fig)$/i) ?? [])[0]?.toLowerCase();
  const source = ext ? EXTS[ext] : null;
  if (!source) {
    if (/\.fig$/i.test(file.originalname)) {
      throw new HttpError(
        400,
        '.fig 是 Figma 私有二进制格式（无公开解析规范），无法直接解析。请改用 Figma 导入：在首页粘贴文件链接（需配置 FIGMA_TOKEN），即可获得完整图层数据。'
      );
    }
    throw new HttpError(400, '仅支持 .sketch / .psd 文件');
  }
  await assertProject(projectId, req);

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

  return { id: fileId, name, status: 'processing', source };
}

/** 剪贴板图片导入核心逻辑，两种上传通道共用 */
async function createImageImport(
  file: UploadedFile,
  projectId: string | null,
  width: number,
  height: number,
  name: string,
  req: Request
) {
  if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.mimetype)) {
    throw new HttpError(400, '剪贴板里不是图片，仅支持 PNG/JPG/WebP/GIF');
  }
  await assertProject(projectId, req);
  const w = Math.max(1, Math.round(width || 800));
  const h = Math.max(1, Math.round(height || 600));
  const title = name.trim() || `剪贴板导入 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;

  const figmaKey = `CLIP-${Date.now().toString(36)}`;
  const { rows: [f] } = await pool.query<{ id: string }>(
    `INSERT INTO design_files (figma_key, name, version, status, source, project_id)
     VALUES ($1, $2, 'clip-v1', 'ready', 'image', $3) RETURNING id`,
    [figmaKey, title, projectId]
  );

  const storage = await getStorage();
  const ext = file.mimetype === 'image/jpeg' ? 'jpg' : (file.mimetype.split('/')[1] ?? 'png');
  const url = await storage.put(`files/${f.id}/frames/${figmaKey}@1x.${ext}`, file.buffer, file.mimetype);

  const { rows: [fr] } = await pool.query<{ id: string }>(
    `INSERT INTO frames (file_id, node_id, name, page_name, width, height, thumb_url, sort_order)
     VALUES ($1, $2, $3, '剪贴板', $4, $5, $6, 0) RETURNING id`,
    [f.id, `${figmaKey}:frame`, title, w, h, url]
  );
  await pool.query(
    `INSERT INTO nodes (file_id, frame_id, node_id, parent_id, name, type, x, y, width, height, visible, props)
     VALUES ($1, $2, $3, NULL, '导入图片', 'RECTANGLE', 0, 0, $4, $5, TRUE, $6)`,
    [f.id, fr.id, `${figmaKey}:image`, w, h,
     JSON.stringify({ fills: [{ type: 'IMAGE', visible: true, imageRef: url, scaleMode: 'FILL' }], exportPresets: [{ format: 'PNG', suffix: '@2x', scale: 2 }] })]
  );
  return { id: f.id, name: title, frames: 1 };
}

/** 从对象存储取回直传的临时文件（读取后即删除临时对象） */
async function readFromStorage(key: string): Promise<Buffer> {
  if (config.storage.driver === 'local') {
    throw new HttpError(400, '当前部署未启用对象存储，请改用普通上传');
  }
  const storage = await getStorage();
  const data = await storage.get(key);
  void removeUploaded(key).catch(() => {});
  return data;
}

// ---------- 上传 .sketch / .psd 文件导入（可指定所属项目，表单字段 projectId） ----------

uploadsRouter.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw new HttpError(400, '未收到文件');
    res.json(await createDesignImport(req.file, projectIdOf(req.body), req));
  } catch (err) {
    respondError(res, err);
  }
});

/** 直传通道：前端先 PUT 到对象存储，再带上 key 触发解析（请求体只有几百字节） */
uploadsRouter.post('/from-storage', async (req, res) => {
  try {
    const body = req.body as { key?: unknown; filename?: unknown; projectId?: unknown } | null;
    if (!isValidUploadKey(body?.key)) throw new HttpError(400, '无效的上传凭证');
    const buffer = await readFromStorage(body.key);
    const file: UploadedFile = {
      buffer,
      originalname: String(body?.filename ?? 'upload.bin'),
      mimetype: 'application/octet-stream',
    };
    res.json(await createDesignImport(file, projectIdOf(body), req));
  } catch (err) {
    respondError(res, err);
  }
});

// ---------- 剪贴板导入 ----------

/** 粘贴图片导入：一张图 = 一个画板（图层树为单个图片填充背景，支持标注/评论/切图整图导出） */
uploadsRouter.post('/image', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw new HttpError(400, '未收到图片');
    const body = req.body as { width?: unknown; height?: unknown; name?: unknown } | null;
    res.json(
      await createImageImport(
        req.file,
        projectIdOf(body),
        Number(body?.width) || 0,
        Number(body?.height) || 0,
        typeof body?.name === 'string' ? body.name : '',
        req
      )
    );
  } catch (err) {
    respondError(res, err);
  }
});

/** 图片直传通道：剪贴板高分辨率截图同样可能超过 4.5MB */
uploadsRouter.post('/image/from-storage', async (req, res) => {
  try {
    const body = req.body as {
      key?: unknown; filename?: unknown; projectId?: unknown;
      width?: unknown; height?: unknown; name?: unknown; contentType?: unknown;
    } | null;
    if (!isValidUploadKey(body?.key)) throw new HttpError(400, '无效的上传凭证');
    const buffer = await readFromStorage(body.key);
    const file: UploadedFile = {
      buffer,
      originalname: String(body?.filename ?? 'clip.png'),
      mimetype: String(body?.contentType ?? 'image/png'),
    };
    res.json(
      await createImageImport(
        file,
        projectIdOf(body),
        Number(body?.width) || 0,
        Number(body?.height) || 0,
        typeof body?.name === 'string' ? body.name : '',
        req
      )
    );
  } catch (err) {
    respondError(res, err);
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
