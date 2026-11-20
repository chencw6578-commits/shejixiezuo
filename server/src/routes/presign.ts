/**
 * 大文件直传通道（Vercel Serverless 专用）。
 *
 * Vercel 函数请求体硬上限 4.5MB，.sketch/.psd / 高分辨率图片走 multipart
 * 会被平台直接拦成 413。这里签发一个「只能上传到指定 key」的临时凭证，
 * 浏览器把文件直接送到对象存储，再由一个只带 key 的轻量 JSON 请求通知服务端拉取解析。
 *
 * 支持两种对象存储：
 *   - blob：Vercel Blob（默认，Store 已连接项目并注入 BLOB_READ_WRITE_TOKEN）
 *   - s3：S3 兼容存储（R2 / MinIO / AWS S3），签发预签名 PUT URL
 * 本地 / Docker 常驻部署（STORAGE_DRIVER=local）返回 mode=multipart，
 * 前端保持原来的 multipart 上传路径不变。
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { del as blobDel } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import { config, privateTeamStorage } from '../config.js';
import { getSessionUser } from '../auth.js';
import { createS3Client } from '../storage/index.js';

export const presignRouter = Router();

const ALLOWED_TYPES = new Set([
  'application/octet-stream',
  'application/zip',
  'application/x-zip-compressed',
  'application/json', // Figma 插件导出的 JSON 文本直传
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

/** 与 multer 保持一致的单文件上限 */
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

/** 只保留安全字符，避免对象 key 里出现路径分隔符或 Windows 非法字符 */
function safeName(name: string): string {
  return (name || 'upload.bin').replace(/[^A-Za-z0-9._-]/g, '_').slice(-120);
}

presignRouter.get('/presign', async (req, res) => {
  if (config.storage.driver === 'local' || privateTeamStorage) {
    return res.json({ mode: 'multipart' as const });
  }
  // 直传凭证可写对象存储，要求已登录，避免匿名滥用存储桶
  if (!getSessionUser(req)) {
    return res.status(401).json({ error: '请先登录后再上传文件' });
  }
  const filename = String(req.query.filename ?? '');
  const contentType = String(req.query.contentType ?? 'application/octet-stream');
  if (!ALLOWED_TYPES.has(contentType)) {
    return res.status(400).json({ error: `不支持的文件类型：${contentType}` });
  }

  const key = `uploads/${randomUUID()}/${safeName(filename)}`;
  try {
    if (config.storage.driver === 'blob') {
      // 客户端令牌把权限锁死在「这一个 pathname / 这个 MIME / 300MB / 30 分钟」，
      // 前端拿到后由 @vercel/blob/client 直接 PUT 到 Blob，文件不经过函数。
      const token = await generateClientTokenFromReadWriteToken({
        pathname: key,
        allowedContentTypes: [contentType],
        maximumSizeInBytes: MAX_UPLOAD_BYTES,
        addRandomSuffix: false,
        allowOverwrite: false,
        validUntil: Date.now() + 30 * 60 * 1000,
      });
      return res.json({ mode: 'blob' as const, token, key, contentType });
    }

    const { client } = await createS3Client();
    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: config.storage.s3.bucket,
        Key: key,
        ContentType: contentType,
      }),
      // 只签 content-type：浏览器 PUT 时必须原样带上这个 header
      { expiresIn: 3600, signableHeaders: new Set(['content-type']) }
    );
    return res.json({ mode: 'direct' as const, uploadUrl, key, contentType });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[presign] failed:', message);
    return res.status(500).json({ error: '生成上传地址失败，请检查对象存储配置' });
  }
});

/** from-storage 路由回传的 key 必须是本模块签发出的形状，防止任意读取桶内对象 */
export function isValidUploadKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    /^uploads\/[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,120}$/.test(key)
  );
}

/** 直传临时对象在服务端读取后删除，避免桶里堆积用户上传的原始大文件 */
export async function removeUploaded(key: string): Promise<void> {
  if (config.storage.driver === 'blob') {
    await blobDel(key);
    return;
  }
  const { s3, client } = await createS3Client();
  await client.send(
    new s3.DeleteObjectCommand({ Bucket: config.storage.s3.bucket, Key: key })
  );
}
