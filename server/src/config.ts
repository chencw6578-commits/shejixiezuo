import 'dotenv/config';

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env: ${name}`);
  return v;
}

const storageDriver = process.env.STORAGE_DRIVER ?? 'local';
export const privateTeamStorage = process.env.S3_PRIVATE === '1';
if (privateTeamStorage) {
  if (storageDriver !== 's3' || process.env.S3_PUBLIC_BASE_URL?.trim()) {
    throw new Error('S3_PRIVATE=1 requires STORAGE_DRIVER=s3 and an empty S3_PUBLIC_BASE_URL');
  }
  const required = ['AUTH_SECRET', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`S3_PRIVATE=1 requires ${missing.join(', ')}`);
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  figmaToken: req('FIGMA_TOKEN', '').trim(),
  databaseUrl: req(
    'DATABASE_URL',
    'postgres://postgres:postgres@localhost:5432/designhub'
  ),
  /**
   * 缩略图无损 WebP 转码：相比 PNG 省约 60% 体积，且像素完全一致（像素吸管安全）。
   * 默认开启；设为 0 可回退到 PNG（兼容不支持 WebP 的极旧客户端）。
   */
  thumbWebp: (process.env.THUMB_WEBP ?? '1') !== '0',
  storage: {
    // local: 本地磁盘（常驻部署）；s3: S3 兼容对象存储；blob: Vercel Blob（Serverless 默认）
    driver: storageDriver as 'local' | 's3' | 'blob',
    localDir: process.env.STORAGE_LOCAL_DIR ?? 'storage',
    s3: {
      provider: process.env.S3_PROVIDER ?? 's3',
      endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
      bucket: process.env.S3_BUCKET ?? 'designhub',
      region: process.env.S3_REGION ?? 'us-east-1',
      accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
      secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
      publicBaseUrl: process.env.S3_PUBLIC_BASE_URL ?? '',
      /**
       * MinIO / AWS S3 的公网基址通常不含 bucket（拼成 base/bucket/key）；
       * Cloudflare R2 的 r2.dev / 自定义域公开地址已经直接指向桶（拼成 base/key），
       * 这类平台要设为 false，否则图片 URL 会多一层桶名而 404。
       */
      publicIncludeBucket: (process.env.S3_PUBLIC_INCLUDE_BUCKET ?? 'true') !== 'false',
    },
  },
};

// ---------- 邮件 ----------
// EMAIL_PROVIDER: outbox（默认，邮件写本地 outbox/ 目录，便于开发调试）| resend | smtp
export const emailConfig = {
  provider: (process.env.EMAIL_PROVIDER ?? 'outbox') as 'outbox' | 'resend' | 'smtp',
  /** 发件人，如 "设计协作 <no-reply@yourdomain.com>"；outbox 模式可用默认值 */
  from: process.env.EMAIL_FROM ?? '设计协作 <no-reply@localhost>',
  /** 验证邮件里的跳转基地址（前端 /verify 页面所在域名） */
  webBaseUrl: (process.env.WEB_BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, ''),
  outboxDir: process.env.EMAIL_OUTBOX_DIR ?? 'outbox',
  resend: {
    apiKey: process.env.RESEND_API_KEY ?? '',
    /** Resend 未验证域名前只允许发给自己账号邮箱 */
    endpoint: 'https://api.resend.com/emails',
  },
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 465),
    secure: (process.env.SMTP_SECURE ?? 'true') === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
  },
};

export const isFigmaConfigured = () => config.figmaToken.length > 0;
