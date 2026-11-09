/**
 * 整板 PNG 裁剪兜底。
 *
 * 插件导入时已经保存了 Figma 原生 exportAsync 的整板位图（frames.thumb_url，通常是 2x）。
 * 服务端近似渲染（export/local.ts）画不出 VECTOR 路径、图片填充和文字，导出的切图常是
 * 全透明空白。这里直接从那张原生位图按图层包围盒裁出像素，保证「有内容 + 尺寸精确」。
 *
 * 边界（必须如实告知用户）：
 *  - 裁出的切图带画板背景，不是透明底的独立图层；
 *  - 只支持 PNG 位图；SVG 请求会返回内嵌该位图的 SVG 包装（不是矢量），PDF 不支持；
 *  - 目标倍率高于整板倍率时为放大，画质会下降。
 * 想要透明底 / 真矢量 / 完全按 Figma Export 设置，仍应使用插件逐图层 exportAsync 上传的真实切图。
 */
import zlib from 'node:zlib';
import { pool } from '../db.js';
import { getStorage } from '../storage/index.js';
import type { CropBounds } from './preset.js';

export interface CropSlice {
  buf: Buffer;
  contentType: string;
  ext: string;
  source: 'crop';
}

// ---------- PNG 最小实现（8bit、非隔行；纯 Node，无原生依赖） ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

interface DecodedPng {
  width: number;
  height: number;
  rgba: Buffer;
}

/** 解码 8bit 非隔行 PNG 为 RGBA；不支持的格式返回 null 由调用方降级。 */
function decodePng(buf: Buffer): DecodedPng | null {
  if (buf.length < 33 || !buf.slice(0, 8).equals(PNG_SIG)) return null;
  let off = 8;
  let W = 0;
  let H = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (off + 12 + len > buf.length) return null;
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      W = data.readUInt32BE(0);
      H = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!W || !H || bitDepth !== 8 || interlace !== 0 || idat.length === 0) return null;
  const channels =
    colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 :
    colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels || (colorType === 3 && !palette)) return null;

  const rowBytes = W * channels;
  const stride = rowBytes + 1;
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  if (raw.length < H * stride) return null;

  // 逐扫描行还原 PNG 滤波器
  const pixels = Buffer.alloc(H * rowBytes);
  for (let y = 0; y < H; y++) {
    const ft = raw[y * stride];
    const src = y * stride + 1;
    const dst = y * rowBytes;
    const prev = y > 0 ? (y - 1) * rowBytes : -1;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= channels ? pixels[dst + x - channels] : 0;
      const b = prev >= 0 ? pixels[prev + x] : 0;
      const c = prev >= 0 && x >= channels ? pixels[prev + x - channels] : 0;
      let v = raw[src + x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) v += paeth(a, b, c);
      else if (ft !== 0) return null;
      pixels[dst + x] = v & 0xff;
    }
  }

  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    let r = 0, g = 0, b = 0, al = 255;
    if (colorType === 0) {
      r = g = b = pixels[i];
    } else if (colorType === 2) {
      r = pixels[i * 3]; g = pixels[i * 3 + 1]; b = pixels[i * 3 + 2];
    } else if (colorType === 3 && palette) {
      const idx = pixels[i];
      if (idx * 3 + 2 >= palette.length) continue;
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
      if (trns && idx < trns.length) al = trns[idx];
    } else if (colorType === 4) {
      r = g = b = pixels[i * 2]; al = pixels[i * 2 + 1];
    } else {
      r = pixels[i * 4]; g = pixels[i * 4 + 1]; b = pixels[i * 4 + 2]; al = pixels[i * 4 + 3];
    }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = al;
  }
  return { width: W, height: H, rgba };
}

function encodePng(W: number, H: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 把 /storage/... URL 还原成 storage key；非本地 URL 走 HTTP 读取。 */
export async function loadStoredAsset(url: string): Promise<Buffer> {
  if (url.startsWith('/storage/')) {
    const storage = await getStorage();
    return storage.get(url.slice('/storage/'.length));
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`读取切图失败：HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * 从整板 PNG 裁出指定区域。scale 是用户/预设要求的倍率，整板倍率由
 * dec.width / frame.width 实测得出（不依赖可能被写错的 frames.scale）。
 *
 * bounds 由 resolveExportTarget 给出：Figma 有导出标记时用标记图层的 bbox
 * （尺寸严格等于设计标记、四边完整）；没有标记时用「自身 + 后代 + 描边外扩」
 * 的并集，避免随便点一个图层就把溢出内容/描边切掉。
 */
export async function cropSliceFromBoard(
  fileId: string,
  frameId: string,
  nodeId: string,
  format: string,
  scale: number,
  override?: CropBounds
): Promise<CropSlice | null> {
  if (format === 'PDF') return null;
  const frames = (
    await pool.query<{ thumb_url: string | null; width: number; height: number }>(
      'SELECT thumb_url, width, height FROM frames WHERE id = $1 AND file_id = $2',
      [frameId, fileId]
    )
  ).rows;
  const frame = frames[0];
  if (!frame?.thumb_url || !(frame.width > 0)) return null;

  let b = override;
  if (!b) {
    const nodes = (
      await pool.query<{ x: number; y: number; width: number; height: number }>(
        'SELECT x, y, width, height FROM nodes WHERE frame_id = $1 AND node_id = $2 LIMIT 1',
        [frameId, nodeId]
      )
    ).rows;
    const n = nodes[0];
    if (!n || !(n.width > 0) || !(n.height > 0)) return null;
    b = { x: n.x, y: n.y, width: n.width, height: n.height };
  }
  if (!(b.width > 0) || !(b.height > 0)) return null;

  let boardBuf: Buffer;
  try {
    boardBuf = await loadStoredAsset(frame.thumb_url);
  } catch {
    return null;
  }
  const dec = decodePng(boardBuf);
  if (!dec) return null;
  const boardScale = dec.width / frame.width;
  if (!(boardScale > 0) || !Number.isFinite(boardScale)) return null;

  const W = Math.max(1, Math.round(b.width * scale));
  const H = Math.max(1, Math.round(b.height * scale));
  const out = Buffer.alloc(W * H * 4); // 全 0 = 透明（图层超出画板边界的部分）
  const step = boardScale / scale;
  const sx0 = b.x * boardScale;
  const sy0 = b.y * boardScale;
  // 降采样时用区域平均而非隔点取样：@1x 从 @2x 整板取图不会丢掉 1px 的描边/角标
  const average = step > 1.01;
  for (let py = 0; py < H; py++) {
    const ya = Math.max(0, Math.floor(sy0 + py * step));
    const yb = Math.min(dec.height, Math.max(ya + 1, Math.ceil(sy0 + (py + 1) * step)));
    if (ya >= dec.height || yb <= 0) continue;
    const dy = average ? Math.max(1, Math.floor((yb - ya) / 4)) : yb - ya;
    for (let px = 0; px < W; px++) {
      const xa = Math.max(0, Math.floor(sx0 + px * step));
      const xb = Math.min(dec.width, Math.max(xa + 1, Math.ceil(sx0 + (px + 1) * step)));
      if (xa >= dec.width || xb <= 0) continue;
      const dx = average ? Math.max(1, Math.floor((xb - xa) / 4)) : xb - xa;
      let r = 0, g = 0, bl = 0, al = 0, cnt = 0;
      for (let sy = ya; sy < yb; sy += dy) {
        for (let sx = xa; sx < xb; sx += dx) {
          const si = (sy * dec.width + sx) * 4;
          r += dec.rgba[si]; g += dec.rgba[si + 1];
          bl += dec.rgba[si + 2]; al += dec.rgba[si + 3];
          cnt++;
        }
      }
      if (!cnt) continue;
      const di = (py * W + px) * 4;
      out[di] = Math.round(r / cnt);
      out[di + 1] = Math.round(g / cnt);
      out[di + 2] = Math.round(bl / cnt);
      out[di + 3] = Math.round(al / cnt);
    }
  }
  const png = encodePng(W, H, out);

  if (format === 'SVG') {
    // 没有真实矢量时用位图包装，保证尺寸正确且有内容（如实说明为位图）
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
      `<image width="${W}" height="${H}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`;
    return { buf: Buffer.from(svg), contentType: 'image/svg+xml', ext: 'svg', source: 'crop' };
  }
  // PNG / JPG 都交付 PNG 位图（无 JPEG 编码器，沿用原有行为）
  return { buf: png, contentType: 'image/png', ext: 'png', source: 'crop' };
}
