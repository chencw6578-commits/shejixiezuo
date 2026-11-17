/**
 * 存量设计稿存储优化（一次性）。
 *
 * 背景：2026-11 起 server 端已落地三项节省——① 停写 design_files.raw；
 * ② 默认跳过节点渲染图（GENERATE_NODE_RENDERS=0）；③ 缩略图无损 WebP。
 * 但这些只对「新导入」生效，存量旧稿仍是旧格式（PNG 缩略图 + 全量节点渲染图 +
 * raw 存档），占着 Blob 与数据库的大头。本脚本把三项优化回放到存量数据上。
 *
 * 做什么（每步独立，均可 --dry-run 只统计不写入）：
 *   1) 清空 design_files.raw   —— 全库零读取点的冗余存档（gzip 后仍约 12KB/份）。
 *   2) 删除节点渲染图          —— Blob 前缀 files/{fileId}/nodes/（约 50 个对象/份），
 *      并把 nodes.render_url 置空。缩略图存在时画布走主图模式，这些图从不显示；
 *      缩略图缺失时前端已有 CSS 近似兜底。--keep-renders 可跳过此步。
 *   3) frames 缩略图 PNG → 无损 WebP —— 逐张转码，仅当 WebP 更小才落盘；
 *      实测省约 60%，像素零差异（吸管取色安全）。回写 frames.thumb_url 后删除旧 PNG。
 *
 * 安全性：
 *   - 不触碰 assets/{fileId}/（用户切图资产）与 files/{fileId}/frames/ 以外的 frames 对象。
 *   - WebP 转码失败自动跳过保留 PNG；DB 回写按 thumb_url 精确匹配，不会误伤他行。
 *   - 先写新对象 → 改库 → 再删旧对象，任何一步失败都不会让前端指向空地址。
 *   - 幂等：重跑时已是 WebP / raw 已空 / 渲染已删的项会自动跳过。
 *
 * 环境变量（在 server 目录运行）：
 *   DATABASE_URL           生产库连接串（必须）
 *   BLOB_READ_WRITE_TOKEN  Vercel Blob 读写令牌（必须，STORAGE_DRIVER=blob 时）
 *
 * 用法：
 *   npx tsx scripts/optimize-existing-storage.mts --dry-run   # 只统计
 *   npx tsx scripts/optimize-existing-storage.mts             # 实际执行
 *   npx tsx scripts/optimize-existing-storage.mts --keep-renders  # 保留节点渲染图
 */
import { list as blobList, del as blobDel, put as blobPut } from '@vercel/blob';
import sharp from 'sharp';
import pg from 'pg';

const { Pool } = pg;

const DRY_RUN = process.argv.includes('--dry-run');
const KEEP_RENDERS = process.argv.includes('--keep-renders');
const LIST_PAGE = 1000;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量: ${name}`);
  return v;
}

const pool = new Pool({ connectionString: need('DATABASE_URL'), max: 3 });

const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;

interface BlobItem {
  pathname: string;
  url: string;
  size: number;
}

/** 分页列出全部 Blob 对象（只列 files/ 前缀；assets/ 切图资产不参与本脚本）。 */
async function listAllFiles(): Promise<BlobItem[]> {
  const all: BlobItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await blobList({ prefix: 'files/', cursor, limit: LIST_PAGE });
    all.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return all;
}

/** 第 1 步：清空 raw 存档 */
async function purgeRaw(): Promise<void> {
  const before = await pool.query<{ total: string | null; files: string }>(
    `SELECT octet_length(raw)::text AS total, count(*)::text AS files
     FROM design_files WHERE raw IS NOT NULL`
  );
  const row = before.rows[0];
  const total = Number(row?.total ?? 0);
  const count = Number(row?.files ?? 0);
  console.log(`\n[1/3] raw 存档: ${count} 份, 共 ${fmtBytes(total)}`);
  if (DRY_RUN || count === 0) return;
  const res = await pool.query(`UPDATE design_files SET raw = NULL WHERE raw IS NOT NULL`);
  console.log(`      已清空 ${res.rowCount} 份 raw，释放数据库 ${fmtBytes(total)}`);
}

/** 第 2 步：删除节点渲染图并置空 render_url */
async function purgeNodeRenders(items: BlobItem[]): Promise<void> {
  const renders = items.filter((b) => /^files\/[^/]+\/nodes\//.test(b.pathname));
  const bytes = renders.reduce((s, b) => s + b.size, 0);
  console.log(
    `\n[2/3] 节点渲染图: ${renders.length} 个对象, 共 ${fmtBytes(bytes)}${KEEP_RENDERS ? '（--keep-renders，跳过）' : ''}`
  );
  if (DRY_RUN || KEEP_RENDERS || renders.length === 0) return;

  let deleted = 0;
  for (let i = 0; i < renders.length; i += 200) {
    const batch = renders.slice(i, i + 200);
    await blobDel(batch.map((b) => b.url));
    deleted += batch.length;
    process.stdout.write(`      删除进度 ${deleted}/${renders.length}\r`);
  }
  process.stdout.write('\n');
  const res = await pool.query(`UPDATE nodes SET render_url = NULL WHERE render_url IS NOT NULL`);
  console.log(`      已删除 ${deleted} 个对象, 置空 ${res.rowCount} 行 render_url`);
}

/** 第 3 步：缩略图 PNG → 无损 WebP（更小才落盘），回写 thumb_url 后删旧 PNG */
async function transcodeThumbnails(items: BlobItem[]): Promise<void> {
  const pngs = items.filter((b) => /^files\/[^/]+\/frames\/.*\.png$/i.test(b.pathname));
  const bytes = pngs.reduce((s, b) => s + b.size, 0);
  console.log(`\n[3/3] 缩略图 PNG: ${pngs.length} 张, 共 ${fmtBytes(bytes)}`);
  if (DRY_RUN || pngs.length === 0) return;

  let saved = 0;
  let converted = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < pngs.length; i++) {
    const item = pngs[i];
    try {
      const res = await fetch(item.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const png = Buffer.from(await res.arrayBuffer());
      const webp = await sharp(png).webp({ lossless: true }).toBuffer();
      if (webp.length >= png.length) {
        skipped++;
        continue;
      }
      const newKey = item.pathname.replace(/\.png$/i, '.webp');
      const put = await blobPut(newKey, webp, {
        access: 'public',
        contentType: 'image/webp',
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      const upd = await pool.query(
        `UPDATE frames SET thumb_url = $2 WHERE thumb_url = $1`,
        [item.url, put.url]
      );
      if (upd.rowCount === 0) {
        // 没有任何行引用旧 URL（可能已被手工处理），删除刚写的新对象以免留孤儿
        await blobDel(put.url);
        skipped++;
        continue;
      }
      await blobDel(item.url);
      converted++;
      saved += png.length - webp.length;
    } catch (err) {
      failed++;
      console.warn(`      跳过 ${item.pathname}: ${err instanceof Error ? err.message : err}`);
    }
    if ((i + 1) % 50 === 0 || i + 1 === pngs.length) {
      process.stdout.write(
        `      进度 ${i + 1}/${pngs.length}  转码 ${converted}  跳过 ${skipped}  失败 ${failed}  已省 ${fmtBytes(saved)}\r`
      );
    }
  }
  process.stdout.write('\n');
  console.log(
    `      完成: 转码 ${converted} 张, 跳过 ${skipped}, 失败 ${failed}, 共节省 ${fmtBytes(saved)}`
  );
}

async function main() {
  console.log(
    DRY_RUN
      ? '=== 存量存储优化（DRY-RUN，只统计不写入） ==='
      : '=== 存量存储优化（实际执行） ==='
  );
  const t0 = Date.now();
  await purgeRaw();
  const items = await listAllFiles();
  console.log(`Blob files/ 前缀共 ${items.length} 个对象`);
  await purgeNodeRenders(items);
  await transcodeThumbnails(items);
  await pool.end();
  console.log(`\n总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s${DRY_RUN ? '（未写入任何数据）' : ''}`);
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
