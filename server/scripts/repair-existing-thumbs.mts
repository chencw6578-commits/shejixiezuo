/**
 * 存量设计稿主图补洞：用已入库的真实切图，补回 Figma 整板导出时丢失的图层。
 *
 * 背景：插件导出整板 PNG 时，某些图层（典型：带组件属性/变体的实心图标）会
 * 渲染为空白，但逐图层切图正常。前端只能显示整板位图，无法在渲染环节补救。
 * 本脚本对存量稿回放「切图补洞」，与插件新导入链路共用 util/thumbRepair。
 *
 * 安全：
 *  - 空白闸门：目标切图全空 → 该画板中止，不写数据，报告需回 Figma 排查。
 *  - 幂等：已修复（thumb_url 含 @repaired）默认跳过；--force 强制重跑。
 *  - 先写新对象 → 改库 → 保留旧对象，任何一步失败都不会让主图指向空地址。
 *  - --dry-run 只统计不写入。
 *
 * 环境变量（在 server 目录运行）：
 *   DATABASE_URL            生产库连接串（必须）
 *   BLOB_READ_WRITE_TOKEN   Vercel Blob 令牌（STORAGE_DRIVER=blob 时）
 *   STORAGE_DRIVER          与线上一致（local / s3 / blob）
 *
 * 用法：
 *   npx tsx scripts/repair-existing-thumbs.mts --dry-run
 *   npx tsx scripts/repair-existing-thumbs.mts
 *   npx tsx scripts/repair-existing-thumbs.mts --project <uuid>
 *   npx tsx scripts/repair-existing-thumbs.mts --force
 */
import 'dotenv/config';
import pg from 'pg';
import { config } from '../src/config.js';
import { getStorage } from '../src/storage/index.js';
import { repairFileThumbs, type RepairSummary } from '../src/util/thumbRepair.js';

const { Pool } = pg;
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const pIdx = process.argv.indexOf('--project');
const PROJECT = pIdx >= 0 ? process.argv[pIdx + 1] : null;

const pool = new Pool({ connectionString: config.databaseUrl, max: 3 });

async function main() {
  let rows: { id: string; name: string; project_id: string }[];
  if (PROJECT) {
    const r = await pool.query<{ id: string; name: string; project_id: string }>(
      `SELECT df.id, df.name, df.project_id FROM design_files df
       WHERE df.project_id = $1 AND df.figma_key LIKE 'plugin:project:%'`,
      [PROJECT]
    );
    rows = r.rows;
  } else {
    const r = await pool.query<{ id: string; name: string; project_id: string }>(
      `SELECT df.id, df.name, df.project_id FROM design_files df
       WHERE df.figma_key LIKE 'plugin:project:%' ORDER BY df.name`
    );
    rows = r.rows;
  }

  console.log(`[repair] 找到 ${rows.length} 份插件设计稿${PROJECT ? `（项目 ${PROJECT}）` : ''}`);
  if (DRY_RUN) {
    // dry-run：只统计有多少画板具备「带 export 标记的真实切图」这一补洞前提
    let frames = 0;
    for (const f of rows) {
      const r = await pool.query<{ n: number }>(
        `SELECT COUNT(DISTINCT fr.id)::int AS n
         FROM frames fr
         JOIN assets a ON a.frame_id = fr.id AND a.file_id = fr.file_id
           AND a.source = 'figma' AND a.format = 'PNG'
         JOIN nodes n ON n.frame_id = fr.id AND n.node_id = a.node_id
           AND n.file_id = fr.file_id
         WHERE fr.file_id = $1
           AND n.props->'exportPresets' IS NOT NULL
           AND jsonb_array_length(n.props->'exportPresets') > 0`,
        [f.id]
      );
      frames += Number(r.rows[0]?.n ?? 0);
    }
    console.log(`[repair] [dry-run] ${frames} 个画板有可补洞的真实切图（未写入任何数据）`);
    await pool.end();
    return;
  }

  const storage = await getStorage();
  let totalRepaired = 0, totalAborted = 0, totalFailed = 0, totalSkipped = 0;
  for (const f of rows) {
    console.log(`[repair] 处理「${f.name}」(${f.id}) …`);
    const summary: RepairSummary = await repairFileThumbs(f.id, storage, { force: FORCE });
    totalRepaired += summary.repaired;
    totalAborted += summary.aborted;
    totalFailed += summary.failed;
    totalSkipped += summary.skipped;
    console.log(
      `[repair]   repaired=${summary.repaired} skipped=${summary.skipped} aborted=${summary.aborted} failed=${summary.failed}`
    );
    for (const fr of summary.frames) {
      if (fr.status === 'repaired') {
        console.log(`[repair]     修复「${fr.frameName}」贴回 ${fr.patched}/${fr.targets} 张${fr.blankSkipped ? `（跳过空图 ${fr.blankSkipped}）` : ''}`);
      } else if (fr.reason) {
        console.log(`[repair]     ${fr.status}「${fr.frameName}」${fr.reason}`);
      }
    }
  }
  console.log(`[repair] 完成：repaired=${totalRepaired} skipped=${totalSkipped} aborted=${totalAborted} failed=${totalFailed}`);
  await pool.end();
}

main().catch((err) => {
  console.error('[repair] 失败:', err);
  process.exit(1);
});
