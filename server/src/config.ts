import 'dotenv/config';

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  figmaToken: req('FIGMA_TOKEN', '').trim(),
  databaseUrl: req(
    'DATABASE_URL',
    'postgres://postgres:postgres@localhost:5432/designhub'
  ),
  storage: {
    driver: (process.env.STORAGE_DRIVER ?? 'local') as 'local' | 's3',
    localDir: process.env.STORAGE_LOCAL_DIR ?? 'storage',
    s3: {
      endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
      bucket: process.env.S3_BUCKET ?? 'designhub',
      region: process.env.S3_REGION ?? 'us-east-1',
      accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
      secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
      publicBaseUrl: process.env.S3_PUBLIC_BASE_URL ?? '',
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
