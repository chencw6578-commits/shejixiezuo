import { Router } from 'express';
import { pool } from '../db.js';
import { getFileMeta } from '../figma/client.js';
import { enqueueImport } from '../jobs/importFile.js';

export const webhooksRouter = Router();

interface FigmaWebhookBody {
  event_type?: string;
  file_key?: string;
  passcode?: string;
  [key: string]: unknown;
}

/**
 * Figma Webhook（FILE_UPDATE）→ 版本变化时自动重新导入。
 *
 * 在 Figma 控制台创建 webhook：
 *   Endpoint: https://<你的域名>/api/webhooks/figma
 *   Events: FILE_UPDATE
 * 可选在 .env 配置 WEBHOOK_SECRET，并在 Figma webhook 的
 * description/自定义校验中携带（此处校验 header X-Webhook-Secret 或 body.passcode）。
 */
webhooksRouter.post('/figma', async (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const provided = (req.headers['x-webhook-secret'] as string) ?? req.body?.passcode;
    if (provided !== secret) return res.status(401).json({ error: 'invalid secret' });
  }

  const body = (req.body ?? {}) as FigmaWebhookBody;
  // webhook 注册校验（ping）等非文件事件直接确认
  if (!body.file_key || !body.event_type) return res.json({ ok: true, ignored: true });

  // 只处理文件更新类事件
  if (!['FILE_UPDATE', 'FILE_CONTENT_UPDATE'].includes(body.event_type)) {
    return res.json({ ok: true, ignored: body.event_type });
  }

  const file = (
    await pool.query<{ id: string; version: string | null; status: string }>(
      'SELECT id, version, status FROM design_files WHERE figma_key = $1 ORDER BY created_at DESC LIMIT 1',
      [body.file_key]
    )
  ).rows[0];
  if (!file) return res.json({ ok: true, ignored: 'unknown file' });
  if (file.status === 'pending' || file.status === 'processing') {
    return res.json({ ok: true, ignored: 'already importing' });
  }

  try {
    const meta = await getFileMeta(body.file_key);
    if (meta.version === file.version) {
      return res.json({ ok: true, ignored: 'same version' });
    }
  } catch {
    // meta 拉取失败也重新导入（宁可多重导一次）
  }

  await pool.query("UPDATE design_files SET status = 'pending', error = NULL WHERE id = $1", [file.id]);
  void enqueueImport(file.id, body.file_key);
  res.json({ ok: true, reimported: file.id });
});
