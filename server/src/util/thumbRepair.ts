/**
 * 整板主图「切图补洞」修复。
 *
 * 背景：Figma 插件用 node.exportAsync 导出整板 PNG 时，某些图层（典型：带组件
 * 属性/变体的实心图标）在整板渲染中会丢失，表现为画板上出现空白；但这些图层
 * 的「逐图层切图」单独 exportAsync 时内容正常。画布主图（frames.thumb_url）是
 * 一份位图，前端只负责显示，无法在渲染环节把丢失的图标补回来。
 *
 * 本模块用已入库的真实切图（assets.source='figma'）按图层坐标贴回整板图，重建
 * 一份完整主图。安全约束：
 *  1. 空白闸门：任一目标切图全透明（无可见像素）→ 整份中止，不写任何数据，
 *     把问题退回 Figma 源头修复（避免拿一张同样空白的切图去「补」空白）。
 *  2. 只补「带 export 标记」的图层（与画布虚线框/批量切图同一口径），不碰散图。
 *  3. 坐标用实测整板倍率（解码宽 / frame.width），不依赖可能写错的 frames.scale。
 *  4. 幂等：已修复过的画板（thumb_url 指向 @repaired 对象）默认跳过。
 *  5. 先写新对象 → 改库 → 保留旧对象，任何一步失败都不会让主图指向空地址。
 */
import sharp from 'sharp';
import { pool } from '../db.js';
import { type Storage } from '../storage/index.js';
import { loadStoredAsset, hasVisiblePixels } from '../export/crop.js';
import { encodeThumbnail } from './imageEncode.js';

export interface RepairOptions {
  /** 已修复过的画板是否强制重跑（默认跳过） */
  force?: boolean;
  /** 只处理这些 frame id；不传则处理 file 下全部画板 */
  frameIds?: string[];
}

export interface FrameRepairReport {
  frameId: string;
  frameName: string;
  status: 'repaired' | 'skipped' | 'aborted' | 'failed';
  /** 实际贴回的切图数 */
  patched: number;
  /** 参与合成的目标切图总数 */
  targets: number;
  /** 因空白被跳过的切图数 */
  blankSkipped?: number;
  reason?: string;
}

export interface RepairSummary {
  fileId: string;
  frames: FrameRepairReport[];
  repaired: number;
  skipped: number;
  aborted: number;
  failed: number;
  changedUrls: string[];
}

const REPAIRED_MARK = '@repaired.';

interface SliceRow {
  node_id: string;
  name: string | null;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
  props: unknown;
}

/**
 * 判断一个图层是否为「带 export 标记的切图节点」。
 * 与 Canvas.sliceNodes / assets 导出口径一致：props.exportPresets 非空。
 */
function hasExportPreset(props: unknown): boolean {
  if (!props || typeof props !== 'object') return false;
  const presets = (props as Record<string, unknown>).exportPresets;
  return Array.isArray(presets) && presets.length > 0;
}

export interface CompositeInput {
  buf: Buffer;
  name: string;
  /** 相对画板左上角的设计坐标 */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompositePlan {
  layers: { input: Buffer; left: number; top: number }[];
  blankNames: string[];
  failedNames: string[];
}

/**
 * 纯合成规划（不碰 DB / 存储，便于单测）：验空白、算实测倍率与坐标、缩放切图。
 * scale 由调用方按「整板解码宽 / frame.width」传入。
 */
export async function buildCompositeLayers(
  boardWidth: number,
  boardHeight: number,
  scale: number,
  slices: CompositeInput[]
): Promise<CompositePlan> {
  const layers: { input: Buffer; left: number; top: number }[] = [];
  const blankNames: string[] = [];
  const failedNames: string[] = [];
  for (const t of slices) {
    if (!hasVisiblePixels(t.buf)) {
      blankNames.push(t.name);
      continue;
    }
    const left = Math.round(t.x * scale);
    const top = Math.round(t.y * scale);
    const w = Math.max(1, Math.round(t.width * scale));
    const h = Math.max(1, Math.round(t.height * scale));
    if (left >= boardWidth || top >= boardHeight || left + w <= 0 || top + h <= 0) continue;
    const sized = await sharp(t.buf).resize(w, h, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
    layers.push({ input: sized, left, top });
  }
  return { layers, blankNames, failedNames };
}

/**
 * 合成单张画板。返回该画板的处理报告；任何异常收敛为 status='failed'，不影响其他画板。
 */
export async function repairFrameThumb(
  fileId: string,
  frameId: string,
  storage: Storage,
  opts: RepairOptions = {}
): Promise<FrameRepairReport> {
  const frameRes = await pool.query<{
    id: string; name: string; thumb_url: string | null; width: number; height: number;
  }>(
    `SELECT fr.id, fr.name, fr.thumb_url, fr.width, fr.height
     FROM frames fr WHERE fr.id = $1 AND fr.file_id = $2 LIMIT 1`,
    [frameId, fileId]
  );
  const frame = frameRes.rows[0];
  if (!frame) {
    return { frameId, frameName: '-', status: 'failed', patched: 0, targets: 0, reason: '画板不存在' };
  }
  if (!frame.thumb_url) {
    return { frameId, frameName: frame.name, status: 'skipped', patched: 0, targets: 0, reason: '画板无主图，无法补洞' };
  }
  if (!opts.force && frame.thumb_url.includes(REPAIRED_MARK)) {
    return { frameId, frameName: frame.name, status: 'skipped', patched: 0, targets: 0, reason: '已修复过（可 force 重跑）' };
  }
  if (!(frame.width > 0) || !(frame.height > 0)) {
    return { frameId, frameName: frame.name, status: 'failed', patched: 0, targets: 0, reason: '画板尺寸非法' };
  }

  // 目标图层：有 export 标记的图层，且存在 figma 来源的 PNG 切图
  const sliceRes = await pool.query<SliceRow>(
    `SELECT a.node_id, a.name, a.url, n.x, n.y, n.width, n.height, n.props
     FROM assets a
     JOIN nodes n ON n.frame_id = a.frame_id AND n.node_id = a.node_id AND n.file_id = a.file_id
     WHERE a.frame_id = $1 AND a.file_id = $2 AND a.source = 'figma' AND a.format = 'PNG'
     ORDER BY n.id`,
    [frameId, fileId]
  );
  const targets = sliceRes.rows.filter((r) => hasExportPreset(r.props)) as SliceRow[];
  if (!targets.length) {
    return { frameId, frameName: frame.name, status: 'skipped', patched: 0, targets: 0, reason: '没有带 export 标记的真实切图' };
  }

  let boardBuf: Buffer;
  let boardMeta: { width: number; height: number };
  try {
    boardBuf = await loadStoredAsset(frame.thumb_url);
    const meta = await sharp(boardBuf).metadata();
    if (!meta.width || !meta.height) throw new Error('主图解码失败');
    boardMeta = { width: meta.width, height: meta.height };
  } catch (err) {
    return { frameId, frameName: frame.name, status: 'failed', patched: 0, targets: targets.length, reason: `主图读取失败：${err instanceof Error ? err.message : String(err)}` };
  }
  // 实测倍率：不依赖 frames.scale（历史数据可能写错）
  const scale = boardMeta.width / frame.width;
  if (!(scale > 0) || !Number.isFinite(scale)) {
    return { frameId, frameName: frame.name, status: 'failed', patched: 0, targets: targets.length, reason: '整板倍率计算失败' };
  }

  // ---- 空白闸门 ----
  // 逐张验像素：空白切图跳过（不能拿空白图去补空白）；若目标切图「全部」空白，
  // 说明这批切图整体不可用 → 整份中止并把问题退回 Figma 源头，不写入任何数据。
  // 个别历史空图不应拖垮整张画板，所以只在「全部空白」时才 aborted。
  const compositeInputs: CompositeInput[] = [];
  const failedNames: string[] = [];
  for (const t of targets) {
    let sliceBuf: Buffer;
    try {
      sliceBuf = await loadStoredAsset(t.url);
    } catch (err) {
      failedNames.push(`「${t.name ?? t.node_id}」${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    compositeInputs.push({
      buf: sliceBuf,
      name: t.name ?? t.node_id,
      x: t.x, y: t.y, width: t.width, height: t.height,
    });
  }
  const { layers, blankNames } = await buildCompositeLayers(
    boardMeta.width, boardMeta.height, scale, compositeInputs
  );

  const usable = layers.length;
  if (usable === 0) {
    if (blankNames.length === targets.length) {
      return {
        frameId, frameName: frame.name, status: 'aborted', patched: 0, targets: targets.length,
        reason: `全部 ${targets.length} 张目标切图均为全透明空白，已中止（需回 Figma 检查图层导出设置）`,
      };
    }
    const reason = failedNames.length
      ? `目标切图全部读取失败：${failedNames.slice(0, 3).join('；')}`
      : '所有切图都在画板外，无需补洞';
    return { frameId, frameName: frame.name, status: 'skipped', patched: 0, targets: targets.length, blankSkipped: blankNames.length, reason };
  }

  try {
    const composed = await sharp(boardBuf)
      .composite(layers.map((l) => ({ input: l.input, left: l.left, top: l.top })))
      .png()
      .toBuffer();
    const encoded = await encodeThumbnail(composed);
    const key = `files/${fileId}/frames/${frame.id}@repaired.${encoded.ext}`;
    const newUrl = await storage.put(key, encoded.data, encoded.contentType);
    await pool.query('UPDATE frames SET thumb_url = $1 WHERE id = $2 AND file_id = $3', [newUrl, frameId, fileId]);
    return { frameId, frameName: frame.name, status: 'repaired', patched: layers.length, targets: targets.length, blankSkipped: blankNames.length };
  } catch (err) {
    return { frameId, frameName: frame.name, status: 'failed', patched: 0, targets: targets.length, reason: `合成写入失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 修复一个设计文件下的画板（可指定 frameIds）。 */
export async function repairFileThumbs(
  fileId: string,
  storage: Storage,
  opts: RepairOptions = {}
): Promise<RepairSummary> {
  let ids = opts.frameIds;
  if (!ids) {
    const r = await pool.query<{ id: string }>('SELECT id FROM frames WHERE file_id = $1 ORDER BY sort_order, id', [fileId]);
    ids = r.rows.map((x) => x.id);
  }
  const frames: FrameRepairReport[] = [];
  const changedUrls: string[] = [];
  for (const id of ids) {
    const report = await repairFrameThumb(fileId, id, storage, opts);
    frames.push(report);
    if (report.status === 'repaired') {
      const u = await pool.query<{ thumb_url: string | null }>('SELECT thumb_url FROM frames WHERE id = $1', [id]);
      if (u.rows[0]?.thumb_url) changedUrls.push(u.rows[0].thumb_url);
    }
  }
  return {
    fileId,
    frames,
    repaired: frames.filter((f) => f.status === 'repaired').length,
    skipped: frames.filter((f) => f.status === 'skipped').length,
    aborted: frames.filter((f) => f.status === 'aborted').length,
    failed: frames.filter((f) => f.status === 'failed').length,
    changedUrls,
  };
}

export { REPAIRED_MARK };
