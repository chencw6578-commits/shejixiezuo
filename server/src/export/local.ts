/**
 * 本地切图渲染：不从 Figma API 导出，而是直接用图层数据在服务端渲染。
 *  - SVG：矢量输出（含渐变/文本），倍率只影响 width/height
 *  - PNG：纯 Node zlib 光栅化（矩形/圆/圆角矩形，渐变取均色，透明底）
 *
 * 适用：演示数据（figma_key=DEMO*）、Sketch/PSD 导入的本地文件。
 */
import zlib from 'node:zlib';
import { pool } from '../db.js';

export interface LocalNode {
  node_id: string;
  parent_id: string | null;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  props: {
    opacity?: number;
    fills?: Array<Record<string, unknown>>;
    strokes?: Array<Record<string, unknown>>;
    cornerRadius?: number;
    text?: {
      family?: string;
      weight?: number;
      size?: number;
      lineHeight?: number;
      alignHorizontal?: string;
      characters?: string;
      color?: Record<string, unknown>;
    };
  };
}

export async function loadFrameNodes(fileId: string, frameId: string): Promise<LocalNode[]> {
  const { rows } = await pool.query(
    `SELECT node_id, parent_id, name, type, x, y, width, height, props
     FROM nodes WHERE file_id = $1 AND frame_id = $2 ORDER BY id`,
    [fileId, frameId]
  );
  return rows as LocalNode[];
}

/** 该文件是否走本地渲染（演示 / Sketch / PSD）。 */
export function isLocalFile(source: string, figmaKey: string): boolean {
  return source !== 'figma' || figmaKey === 'DEMO' || figmaKey === 'DEMO2';
}

// ---------- 颜色解析 ----------

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(c: unknown): RGBA | null {
  if (!c) return null;
  if (typeof c === 'object' && !Array.isArray(c)) {
    const o = c as Record<string, unknown>;
    // Figma 结构 {r,g,b,a}（0-1）
    if (typeof o.r === 'number' && o.r <= 1 && 'g' in o) {
      return {
        r: Math.round((o.r as number) * 255),
        g: Math.round((o.g as number) * 255),
        b: Math.round((o.b as number) * 255),
        a: typeof o.a === 'number' ? o.a : 1,
      };
    }
    // {hex, alpha}
    if (typeof o.hex === 'string') {
      const m = o.hex.match(/([0-9a-fA-F]{6})/);
      if (m) {
        const v = parseInt(m[1], 16);
        return {
          r: (v >> 16) & 255,
          g: (v >> 8) & 255,
          b: v & 255,
          a: typeof o.alpha === 'number' ? o.alpha : 1,
        };
      }
    }
  }
  if (typeof c === 'string') {
    const rgba = c.match(/rgba?\(([^)]+)\)/);
    if (rgba) {
      const parts = rgba[1].split(',').map((s) => Number(s.trim()));
      return { r: parts[0] | 0, g: parts[1] | 0, b: parts[2] | 0, a: parts.length > 3 ? parts[3] : 1 };
    }
    const hex = c.match(/#?([0-9a-fA-F]{6})/);
    if (hex) {
      const v = parseInt(hex[1], 16);
      return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: 1 };
    }
  }
  return null;
}

function stopColor(s: unknown): RGBA | null {
  const o = s as Record<string, unknown> | undefined;
  if (!o) return null;
  return parseColor(o.color ?? o) ?? null;
}

/** 取第一个可见填充；渐变近似为各 stop 均色（位图光栅化用）。 */
function pickFill(props: LocalNode['props']): RGBA | null {
  const fills = Array.isArray(props?.fills) ? props.fills : [];
  const f = fills.find((x) => x && (x as Record<string, unknown>).visible !== false) as
    | Record<string, unknown>
    | undefined;
  if (!f) return null;
  const stops = f.gradientStops;
  if (Array.isArray(stops) && stops.length > 0) {
    const colors = stops.map(stopColor).filter((c): c is RGBA => !!c);
    if (colors.length > 0) {
      const avg = colors.reduce(
        (acc, c) => ({ r: acc.r + c.r / colors.length, g: acc.g + c.g / colors.length, b: acc.b + c.b / colors.length, a: acc.a + c.a / colors.length }),
        { r: 0, g: 0, b: 0, a: 0 }
      );
      return avg;
    }
  }
  return parseColor(f.color ?? f.css);
}

function cssColor(c: RGBA): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${Number(c.a.toFixed(3))})`;
}

// ---------- PNG 编码（RGBA，纯 Node） ----------

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

interface RShape {
  kind: 'rect' | 'ellipse';
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  color: RGBA;
}

/** 收集 root 及其全部后代的可光栅化形状（坐标换算到 root 包围盒内；文本跳过）。 */
function collectShapes(nodes: LocalNode[], root: LocalNode): RShape[] {
  const childrenOf = new Map<string, LocalNode[]>();
  for (const n of nodes) {
    if (!n.parent_id) continue;
    const list = childrenOf.get(n.parent_id) ?? [];
    list.push(n);
    childrenOf.set(n.parent_id, list);
  }
  const shapes: RShape[] = [];
  const walk = (n: LocalNode) => {
    if (n.type !== 'TEXT') {
      const color = pickFill(n.props);
      if (color) {
        shapes.push({
          kind: n.type === 'ELLIPSE' ? 'ellipse' : 'rect',
          x: n.x - root.x,
          y: n.y - root.y,
          w: n.width,
          h: n.height,
          radius: Math.max(0, Number(n.props?.cornerRadius) || 0),
          color,
        });
      }
    }
    for (const c of childrenOf.get(n.node_id) ?? []) walk(c);
  };
  walk(root);
  return shapes;
}

/** 光栅化为 PNG（透明底，src-over 合成；bg 提供时先铺底色，用于 JPG 的不透明输出）。 */
function rasterPng(w: number, h: number, scale: number, shapes: RShape[], bg?: RGBA): Buffer {
  const W = Math.max(1, Math.round(w * scale));
  const H = Math.max(1, Math.round(h * scale));
  const img = Buffer.alloc(W * H * 4);
  if (bg) {
    for (let i = 0; i < W * H; i++) {
      img[i * 4] = bg.r;
      img[i * 4 + 1] = bg.g;
      img[i * 4 + 2] = bg.b;
      img[i * 4 + 3] = 255;
    }
  }
  for (const s of shapes) {
    if (s.color.a <= 0 || s.w <= 0 || s.h <= 0) continue;
    const x0 = Math.max(0, Math.floor(s.x * scale));
    const y0 = Math.max(0, Math.floor(s.y * scale));
    const x1 = Math.min(W, Math.ceil((s.x + s.w) * scale));
    const y1 = Math.min(H, Math.ceil((s.y + s.h) * scale));
    const radius = Math.min(s.radius, s.w / 2, s.h / 2);
    for (let py = y0; py < y1; py++) {
      const cy = (py + 0.5) / scale - s.y;
      for (let px = x0; px < x1; px++) {
        const cx = (px + 0.5) / scale - s.x;
        let inside: boolean;
        if (s.kind === 'ellipse') {
          const dx = (cx - s.w / 2) / (s.w / 2);
          const dy = (cy - s.h / 2) / (s.h / 2);
          inside = dx * dx + dy * dy <= 1;
        } else {
          inside = cx >= 0 && cx < s.w && cy >= 0 && cy < s.h;
          if (inside && radius > 0) {
            const nearX = cx < radius ? -1 : cx > s.w - radius ? 1 : 0;
            const nearY = cy < radius ? -1 : cy > s.h - radius ? 1 : 0;
            if (nearX !== 0 && nearY !== 0) {
              const ox = nearX < 0 ? radius - cx : cx - (s.w - radius);
              const oy = nearY < 0 ? radius - cy : cy - (s.h - radius);
              if (ox * ox + oy * oy > radius * radius) inside = false;
            }
          }
        }
        if (!inside) continue;
        const a = s.color.a;
        const off = (py * W + px) * 4;
        const da = img[off + 3] / 255;
        const oa = a + da * (1 - a);
        if (oa > 0) {
          img[off] = Math.round((s.color.r * a + img[off] * da * (1 - a)) / oa);
          img[off + 1] = Math.round((s.color.g * a + img[off + 1] * da * (1 - a)) / oa);
          img[off + 2] = Math.round((s.color.b * a + img[off + 2] * da * (1 - a)) / oa);
          img[off + 3] = Math.round(oa * 255);
        }
      }
    }
  }
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // filter: none
    img.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- SVG 渲染 ----------

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 渲染某图层（含全部后代）为独立 SVG；viewBox 裁到图层包围盒。 */
export function renderNodeSvg(nodes: LocalNode[], root: LocalNode, scale: number): string {
  const childrenOf = new Map<string, LocalNode[]>();
  for (const n of nodes) {
    if (!n.parent_id) continue;
    const list = childrenOf.get(n.parent_id) ?? [];
    list.push(n);
    childrenOf.set(n.parent_id, list);
  }
  const defs: string[] = [];
  const body: string[] = [];
  let gi = 0;

  const fillAttrOf = (n: LocalNode): string | null => {
    const fills = Array.isArray(n.props?.fills) ? n.props.fills : [];
    const f = fills.find((x) => x && (x as Record<string, unknown>).visible !== false) as
      | Record<string, unknown>
      | undefined;
    if (!f) return null;
    const stops = f.gradientStops;
    if (Array.isArray(stops) && stops.length > 0) {
      const parts = stops
        .map((s) => {
          const o = s as Record<string, unknown>;
          const c = parseColor(o.color ?? o);
          if (!c) return null;
          const offset = typeof o.position === 'number' ? o.position : 0;
          return `<stop offset="${offset}" stop-color="rgb(${c.r},${c.g},${c.b})" stop-opacity="${Number(c.a.toFixed(3))}"/>`;
        })
        .filter(Boolean)
        .join('');
      if (parts) {
        const id = `lg${gi++}`;
        defs.push(`<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${parts}</linearGradient>`);
        return `url(#${id})`;
      }
    }
    const c = parseColor(f.color ?? f.css);
    return c ? cssColor(c) : null;
  };

  const strokeAttrOf = (n: LocalNode): string => {
    const strokes = Array.isArray(n.props?.strokes) ? n.props.strokes : [];
    const st = strokes[0] as Record<string, unknown> | undefined;
    if (!st || st.visible === false) return '';
    const c = parseColor(st.color ?? st.css);
    if (!c) return '';
    const weight = typeof st.weight === 'number' ? st.weight : 1;
    return ` stroke="${cssColor(c)}" stroke-width="${weight}"`;
  };

  const walk = (n: LocalNode) => {
    const x = n.x - root.x;
    const y = n.y - root.y;
    const op = typeof n.props?.opacity === 'number' && n.props.opacity < 1 ? ` opacity="${n.props.opacity}"` : '';
    if (n.type === 'TEXT') {
      const t = n.props?.text;
      const color = parseColor(t?.color) ?? pickFill(n.props);
      const size = Math.max(1, t?.size ?? 14);
      const lh = t?.lineHeight && t.lineHeight >= size ? t.lineHeight : size * 1.4;
      const anchor = t?.alignHorizontal === 'CENTER' ? 'middle' : t?.alignHorizontal === 'RIGHT' ? 'end' : 'start';
      const tx = anchor === 'middle' ? x + n.width / 2 : anchor === 'end' ? x + n.width : x;
      const baseline = y + Math.max(size * 0.8, (n.height - lh) / 2 + size * 0.8);
      const family = t?.family ? ` font-family="${esc(t.family)}, sans-serif"` : '';
      const weight = t?.weight ? ` font-weight="${t.weight}"` : '';
      const chars = t?.characters ?? n.name ?? '';
      body.push(
        `<text x="${tx}" y="${baseline.toFixed(2)}"${family}${weight} font-size="${size}" fill="${color ? cssColor(color) : '#000'}" text-anchor="${anchor}"${op}>${esc(String(chars))}</text>`
      );
    } else {
      const fill = fillAttrOf(n);
      if (fill) {
        const stroke = strokeAttrOf(n);
        const radius = Math.max(0, Number(n.props?.cornerRadius) || 0);
        if (n.type === 'ELLIPSE') {
          body.push(
            `<ellipse cx="${x + n.width / 2}" cy="${y + n.height / 2}" rx="${n.width / 2}" ry="${n.height / 2}" fill="${fill}"${stroke}${op}/>`
          );
        } else {
          body.push(
            `<rect x="${x}" y="${y}" width="${n.width}" height="${n.height}"${radius > 0 ? ` rx="${radius}"` : ''} fill="${fill}"${stroke}${op}/>`
          );
        }
      }
    }
    for (const c of childrenOf.get(n.node_id) ?? []) walk(c);
  };
  walk(root);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(root.width * scale)}" height="${Math.round(root.height * scale)}" ` +
    `viewBox="${root.x} ${root.y} ${root.width} ${root.height}">` +
    (defs.length ? `<defs>${defs.join('')}</defs>` : '') +
    body.join('') +
    `</svg>`
  );
}

// ---------- 导出入口 ----------

export interface LocalSlice {
  buf: Buffer;
  contentType: string;
  ext: string;
}

/**
 * 渲染单个图层切图。PNG/JPG 走光栅化（JPG 合成白底），SVG 走矢量。
 * PDF 本地不支持，返回 null 由调用方计入失败。
 */
export async function renderLocalSlice(
  fileId: string,
  frameId: string,
  nodeId: string,
  format: string,
  scale: number
): Promise<LocalSlice | null> {
  const nodes = await loadFrameNodes(fileId, frameId);
  const root = nodes.find((n) => n.node_id === nodeId);
  if (!root) return null;
  if (format === 'SVG') {
    return { buf: Buffer.from(renderNodeSvg(nodes, root, scale)), contentType: 'image/svg+xml', ext: 'svg' };
  }
  if (format === 'PNG' || format === 'JPG') {
    const shapes = collectShapes(nodes, root);
    if (format === 'JPG') {
      // 无 JPEG 编码器：白底合成为不透明 PNG 交付（浏览器按扩展名渲染无差异）
      const png = rasterPng(root.width, root.height, scale, shapes, { r: 255, g: 255, b: 255, a: 1 });
      return { buf: png, contentType: 'image/png', ext: 'png' };
    }
    return { buf: rasterPng(root.width, root.height, scale, shapes), contentType: 'image/png', ext: 'png' };
  }
  return null; // PDF 不支持
}
