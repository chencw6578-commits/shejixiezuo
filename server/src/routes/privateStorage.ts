import { Router } from 'express';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { assetFileId, openPrivateAsset, privateAssetKey } from '../storage/index.js';
import { requirePrivateAccess } from './privateAccess.js';

export const privateStorageRouter = Router();

function fileIdFromUrl(path: string): string | null {
  const key = privateAssetKey('/api/storage' + path);
  return key ? assetFileId(key) : null;
}

/** Only called after verifying team membership or a share scoped to the requested thumbnail. */
export async function sendPrivateAsset(key: string, res: Response): Promise<void> {
  let object;
  try {
    object = await openPrivateAsset(key);
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) {
      res.status(404).json({ error: '文件不存在' });
      return;
    }
    throw err;
  }
  if (!(object.Body instanceof Readable)) throw new Error('Object storage returned no stream');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type(extname(key) || 'application/octet-stream');
  await pipeline(object.Body, res);
}

privateStorageRouter.get('/*', requirePrivateAccess('file', (req) => fileIdFromUrl(req.path)), (req, res) => {
  const key = privateAssetKey('/api/storage' + req.path);
  if (!key) return res.status(404).json({ error: '文件不存在' });
  void sendPrivateAsset(key, res).catch((err: unknown) => {
    if (res.destroyed) return;
    console.error('[private-storage] read failed:', err);
    if (!res.headersSent) res.status(502).json({ error: '读取对象存储失败' });
  });
});
