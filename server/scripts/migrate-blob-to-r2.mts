/**
 * 把 Vercel Blob 里的图片迁移到 Cloudflare R2（S3 兼容），并回写数据库的图片 URL。
 *
 * 背景：数据库 frames.thumb_url / nodes.render_url / assets.url 存的是「完整 URL」，
 * 所以只搬文件不够——必须把库里的旧 Blob URL 换成新的 R2 公开 URL，前端才会读新地址。
 *
 * 运行前：
 *   1) 在 Vercel 项目里确保 BLOB_READ_WRITE_TOKEN 可用（连接 Blob Store 后自动注入），
 *      本地运行则手工设置该环境变量。
 *   2) 设置 R2 的 S3 兼容凭据（与服务端 STORAGE_DRIVER=s3 用同一组）：
 *        S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
 *        S3_BUCKET=designhub
 *        S3_REGION=auto
 *        S3_ACCESS_KEY=<R2 Access Key ID>
 *        S3_SECRET_KEY=<R2 Secret Access Key>
 *        S3_PUBLIC_BASE_URL=https://<YOUR_R2_PUBLIC_DOMAIN>
 *        S3_PUBLIC_INCLUDE_BUCKET=false
 *      PUBLIC_BASE_URL 也可以直接用 R2_MIGRATE_PUBLIC_BASE 覆盖。
 *   3) DATABASE_URL 指向生产库（回写 URL 用）。
 *
 * 用法（在 server 目录）：
 *   npx tsx scripts/migrate-blob-to-r2.mts --dry-run   # 只统计与校验，不写任何东西
 *   npx tsx scripts/migrate-blob-to-r2.mts             # 实际搬运 + 回写
 *
 * 特性：
 *   - 断点续跑：R2 已存在且大小一致的对象会跳过（依赖 R2 的 HeadObject）。
 *   - 分批回写：数据库按批次 UPDATE，避免一次性长事务。
 *   - 先搬文件、后改库：任何一步失败都不会让前端指向不存在的文件。
 *
 * 注意：脚本只复制不删除 Blob。确认新地址全部可用、观察一段时间后，再去 Blob 控制台清空旧桶。
 */
import { list as blobList } from '@vercel/blob';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import pg from 'pg';

const { Pool } = pg;

const DRY_RUN = process.argv.includes('--dry-run');
const PAGE_SIZE = 500;
const DB_BATCH = 100;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量: ${name}`);
  return v;
}

const endpoint = need('S3_ENDPOINT');
const bucket = need('S3_BUCKET');
const region = process.env.S3_REGION || 'auto';
const accessKeyId = need('S3_ACCESS_KEY');
const secretAccessKey = need('S3_SECRET_KEY');
const publicBase = (
  process.env.R2_MIGRATE_PUBLIC_BASE ||
  process.env.S3_PUBLIC_BASE_URL ||
  ''
).replace(/\/+$/, '');
const includeBucket = (process.env.S3_PUBLIC_INCLUDE_BUCKET ?? 'false') !== 'false';
if (!publicBase) throw new Error('缺少 S3_PUBLIC_BASE_URL（或 R2_MIGRATE_PUBLIC_BASE）');

const s3 = new S3Client({
  endpoint,
  region,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});

const pool = new Pool({ connectionString: need('DATABASE_URL'), max: 5 });

/** pathname -> 新 R2 公开 URL */
const urlMap = new Map<string, string>();

function newPublicUrl(pathname: string): string {
  const base = includeBucket ? `${publicBase}/${bucket}` : publicBase;
  return `${base}/${pathname}`;
}

async function existsInR2(pathname: string, size: number): Promise<boolean> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: pathname }));
    return head.ContentLength === size;
  } catch {
    return false;
  }
}

async function copyOne(pathname: string, url: string, size: number): Promise<'copied' | 'skipped'> {
  if (await existsInR2(pathname, size)) return 'skipped';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载 Blob 失败 HTTP ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== size) {
    throw new Error(`大小校验失败: ${pathname} 期望 ${size} 实际 ${buf.length}`);
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: pathname,
      Body: buf,
      ContentType: res.headers.get('content-type') || 'application/octet-stream',
    })
  );
  return 'copied';
}

async function migrateFiles() {
  let cursor: string | undefined;
  let total = 0;
  let copied = 0;
  let skipped = 0;
  do {
    const page = await blobList({ cursor, limit: PAGE_SIZE });
    for (const b of page.blobs) {
      const pathname = b.pathname;
      if (!pathname) continue;
      total++;
      urlMap.set(pathname, newPublicUrl(pathname));
      if (DRY_RUN) continue;
      const r = await copyOne(pathname, b.url, b.size);
      if (r === 'copied') copied++;
      else skipped++;
      if (total % 50 === 0) console.log(`  已处理 ${total} 个（新复制 ${copied} / 跳过 ${skipped}）`);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  console.log(`文件搬运完成：共 ${total}，新复制 ${copied}，跳过 ${skipped}${DRY_RUN ? '（dry-run，未实际复制）' : ''}`);
}

/**
 * 回写数据库 URL。用 pathname 做后缀匹配定位旧 URL（兼容任意 Blob 域名），
 * 逐条替换为新 R2 URL。三张表都做，覆盖所有图片引用点。
 */
async function rewriteDbUrls() {
  const targets = [
    { table: 'frames', column: 'thumb_url' },
    { table: 'nodes', column: 'render_url' },
    { table: 'assets', column: 'url' },
  ];
  let grandTotal = 0;
  for (const { table, column } of targets) {
    const { rows } = await pool.query<{ id: string; url: string }>(
      `SELECT id, ${column} AS url FROM ${table} WHERE ${column} IS NOT NULL`
    );
    let changed = 0;
    for (let i = 0; i < rows.length; i += DB_BATCH) {
      const batch = rows.slice(i, i + DB_BATCH);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of batch) {
          if (!row.url || !row.url.startsWith('http')) continue;
          let pathname: string;
          try {
            pathname = new URL(row.url).pathname.replace(/^\//, '');
          } catch {
            continue;
          }
          const newUrl = urlMap.get(pathname);
          if (!newUrl || newUrl === row.url) continue;
          if (!DRY_RUN) {
            await client.query(
              `UPDATE ${table} SET ${column} = $1 WHERE id = $2`,
              [newUrl, row.id]
            );
          }
          changed++;
        }
        await client.query(DRY_RUN ? 'ROLLBACK' : 'COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
    grandTotal += changed;
    console.log(`  ${table}.${column}: 待更新 ${changed} 条${DRY_RUN ? '（dry-run，未写入）' : ''}`);
  }
  console.log(`数据库回写完成：共 ${grandTotal} 条${DRY_RUN ? '（dry-run，未写入）' : ''}`);
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== 实际迁移 ===');
  console.log(`目标桶: ${bucket} @ ${endpoint}`);
  console.log(`公开基址: ${publicBase} (includeBucket=${includeBucket})`);
  await migrateFiles();
  await rewriteDbUrls();
  console.log('完成。请抽查若干图片 URL 可访问后，再考虑清空旧 Blob 桶。');
}

main()
  .catch((err) => {
    console.error('迁移失败:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
