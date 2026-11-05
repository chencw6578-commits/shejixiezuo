import JSZip from 'jszip';
import { pool } from '../db.js';
import { getStorage } from '../storage/index.js';
import { batchInsert } from '../util/batchInsert.js';
import type { ParsedLayer, ParsedNodeProps } from '../figma/parse.js';

/* ---------- 颜色工具（与 Figma 解析保持一致的结构） ---------- */

function toHex(c: { red: number; green: number; blue: number }) {
  const f = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${f(c.red)}${f(c.green)}${f(c.blue)}`.toUpperCase();
}

function rgbaCss(c: { red: number; green: number; blue: number; alpha?: number }) {
  const a = c.alpha ?? 1;
  const r = Math.round(c.red * 255);
  const g = Math.round(c.green * 255);
  const b = Math.round(c.blue * 255);
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
}

function parseColor(c?: { red: number; green: number; blue: number; alpha?: number }) {
  if (!c) return undefined;
  return { hex: toHex(c), rgba: rgbaCss(c), alpha: c.alpha ?? 1 };
}

function gradientCss(stops: { position: number; color: { red: number; green: number; blue: number; alpha?: number } }[], from?: { x: number; y: number }, to?: { x: number; y: number }) {
  const stopStr = (stops ?? [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((s) => `${rgbaCss(s.color)} ${Math.round(s.position * 100)}%`)
    .join(', ');
  let angle = 180;
  if (from && to) {
    const dx = (to.x - from.x) * 100;
    const dy = (to.y - from.y) * 100;
    angle = Math.round((Math.atan2(dx, -dy) * 180) / Math.PI);
  }
  return `linear-gradient(${angle}deg, ${stopStr})`;
}

/* ---------- 类型 ---------- */

interface SketchPoint { point?: { x: number; y: number }; curveMode?: number; cornerRadius?: number }
interface SketchColor { red: number; green: number; blue: number; alpha?: number }
interface SketchFrame { x: number; y: number; width: number; height: number }
interface SketchLayer {
  _class: string;
  do_objectID: string;
  name?: string;
  frame: SketchFrame;
  isVisible?: boolean;
  layers?: SketchLayer[];
  style?: {
    contextSettings?: { opacity?: number };
    fills?: { isEnabled?: boolean; fillType?: number; color?: SketchColor; gradient?: { gradientType?: number; from?: { x: number; y: number }; to?: { x: number; y: number }; stops?: { position: number; color: SketchColor }[] }; imageRef?: string }[];
    borders?: { isEnabled?: boolean; thickness?: number; position?: number; color?: SketchColor }[];
    shadows?: { isEnabled?: boolean; offsetX?: number; offsetY?: number; blurRadius?: number; spread?: number; color?: SketchColor }[];
    innerShadows?: { isEnabled?: boolean; offsetX?: number; offsetY?: number; blurRadius?: number; spread?: number; color?: SketchColor }[];
    textStyle?: { encodedAttributes?: Record<string, unknown> };
    paragraphStyle?: { alignment?: number; maximumLineHeight?: number };
  };
  points?: SketchPoint[];
  fixedRadius?: number;
  attributedString?: { string?: string };
  exportOptions?: { exportFormats?: { fileFormat?: string; suffix?: string; scale?: string }[] };
  image?: { _ref?: string; _ref_class?: string; _ref_filepath?: string };
  backgroundColor?: SketchColor;
}

const PAINTABLE = new Set(['rectangle', 'oval', 'text', 'bitmap', 'shapePath', 'shapeGroup', 'star', 'triangle', 'polygon', 'symbolInstance']);

/* ---------- 图层属性 → 与 Figma 解析同构的 props ---------- */

function parseProps(l: SketchLayer): ParsedNodeProps {
  const props: ParsedNodeProps = { opacity: 1, fills: [], strokes: [], effects: [], exportPresets: [], hasImageFill: false };
  const style = l.style ?? {};

  props.opacity = style.contextSettings?.opacity ?? 1;

  const fills = (style.fills ?? []).filter((f) => f.isEnabled !== false);
  props.fills = fills.map((f) => {
    if (f.fillType === 1 && f.gradient) {
      return {
        type: 'gradient' as const, visible: true, opacity: 1,
        css: gradientCss(f.gradient.stops ?? [], f.gradient.from, f.gradient.to),
      };
    }
    if (f.fillType === 4) {
      props.hasImageFill = true;
      return { type: 'image' as const, visible: true, opacity: 1, scaleMode: 'FILL' };
    }
    const c = parseColor(f.color);
    return { type: 'solid' as const, visible: true, opacity: 1, color: c, css: c?.rgba };
  });

  const borders = (style.borders ?? []).filter((b) => b.isEnabled !== false);
  if (borders.length) {
    const b0 = borders[0];
    props.strokeWeight = b0.thickness ?? 1;
    props.strokeAlign = b0.position === 1 ? 'INSIDE' : b0.position === 2 ? 'OUTSIDE' : 'CENTER';
    props.strokes = borders.map((b) => {
      const bc = parseColor(b.color);
      return { type: 'solid' as const, visible: true, opacity: 1, color: bc, css: bc?.rgba };
    });
  }

  const shadows = [
    ...(style.shadows ?? []).filter((s) => s.isEnabled !== false).map((s) => ({ ...s, kind: 'DROP_SHADOW' as const })),
    ...(style.innerShadows ?? []).filter((s) => s.isEnabled !== false).map((s) => ({ ...s, kind: 'INNER_SHADOW' as const })),
  ];
  if (shadows.length) {
    props.effects = shadows.map((s) => {
      const c = s.color ?? { red: 0, green: 0, blue: 0, alpha: 0.25 };
      const inset = s.kind === 'INNER_SHADOW' ? 'inset ' : '';
      return {
        type: s.kind,
        offsetX: s.offsetX ?? 0, offsetY: s.offsetY ?? 0,
        radius: s.blurRadius ?? 0, spread: s.spread ?? 0,
        color: parseColor(c),
        css: `${inset}${s.offsetX ?? 0}px ${s.offsetY ?? 0}px ${s.blurRadius ?? 0}px ${s.spread ?? 0}px ${rgbaCss(c)}`,
      };
    });
  }

  const radii = (l.points ?? []).map((p) => p.cornerRadius ?? 0).filter((r) => r > 0);
  const fixed = l.fixedRadius ?? 0;
  props.cornerRadius = radii.length ? Math.max(...radii) : fixed || undefined;

  if (l._class === 'text') {
    const enc = (style.textStyle?.encodedAttributes ?? {}) as Record<string, any>;
    const font = enc.MSAttributedStringFontAttribute?.attributes ?? {};
    const color = enc.MSAttributedStringColorAttribute;
    const align = style.paragraphStyle?.alignment ?? 0;
    props.text = {
      content: l.attributedString?.string ?? '',
      family: font.name,
      size: font.size,
      lineHeight: style.paragraphStyle?.maximumLineHeight,
      alignHorizontal: align === 1 ? 'RIGHT' : align === 2 ? 'CENTER' : 'LEFT',
      color: parseColor(color),
    };
  }

  const FORMAT_UNION = ['PNG', 'SVG', 'PDF', 'JPG'] as const;
  const presets = (l.exportOptions?.exportFormats ?? [])
    .filter((f) => f.fileFormat && (FORMAT_UNION as readonly string[]).includes(f.fileFormat.toUpperCase()))
    .map((f) => {
      const scale = parseFloat(f.scale ?? '1') || 1;
      return { format: f.fileFormat!.toUpperCase() as (typeof FORMAT_UNION)[number], suffix: f.suffix ?? (scale !== 1 ? `@${scale}x` : ''), scale };
    });
  if (presets.length) props.exportPresets = presets;

  return props;
}

/* ---------- 递归收集图层（绝对坐标 + 父关系） ---------- */

interface FlatItem { layer: SketchLayer; parentId: string | null; ax: number; ay: number; type: string; props: ParsedNodeProps }

const ALL_PAINTABLE = new Set(['rectangle', 'oval', 'text', 'bitmap', 'shapePath', 'shapeGroup', 'star', 'triangle', 'polygon', 'symbolInstance', 'slice']);

function walkLayers(root: SketchLayer, originX: number, originY: number): FlatItem[] {
  const out: FlatItem[] = [];
  const walk = (l: SketchLayer, parentId: string | null, dx: number, dy: number, depth: number) => {
    if (l.isVisible === false || depth > 32) return;
    const ax = dx + (l.frame?.x ?? 0);
    const ay = dy + (l.frame?.y ?? 0);
    const type = ALL_PAINTABLE.has(l._class) || l._class === 'group' ? l._class : 'shapePath';
    if (l._class === 'hotspot' || l._class === 'page') return;
    // pre-order：父层先入序（画板根节点本身除外），保证热区 DOM 层叠与 Sketch 一致
    if (parentId !== null || l !== root) {
      out.push({ layer: l, parentId, ax, ay, type, props: parseProps(l) });
    }
    // Sketch 图层数组第 0 个是最上层：反转遍历，保持「先访问底层」与 Figma 一致
    const children = l.layers ?? [];
    for (let i = children.length - 1; i >= 0; i--) walk(children[i], l.do_objectID, ax, ay, depth + 1);
  };
  walk(root, null, originX - (root.frame?.x ?? 0), originY - (root.frame?.y ?? 0), 0);
  return out;
}

/* ---------- SVG 渲染（画板预览底图） ---------- */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function svgNode(l: SketchLayer, dx: number, dy: number, images: Map<string, Buffer | null>, out: string[]) {
  if (l.isVisible === false) return;
  const x = dx + (l.frame?.x ?? 0);
  const y = dy + (l.frame?.y ?? 0);
  const w = l.frame?.width ?? 0;
  const h = l.frame?.height ?? 0;
  const style = l.style ?? {};
  const fill = (style.fills ?? []).find((f) => f.isEnabled !== false);
  const border = (style.borders ?? []).find((b) => b.isEnabled !== false);
  const opacity = style.contextSettings?.opacity ?? 1;

  // 子层先画（Sketch 数组首元素在最上层 → 反转遍历）
  for (let i = (l.layers ?? []).length - 1; i >= 0; i--) svgNode(l.layers![i], x, y, images, out);

  const common = `x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}"`;
  const gradFill = fill && fill.fillType === 1 && fill.gradient ? fill.gradient : undefined;
  const fillAttr = gradFill
    ? `fill="url(#g${out.length})"`
    : fill?.fillType === 4 && fill.imageRef
      ? ''
      : `fill="${parseColor(fill?.color)?.rgba ?? 'none'}"`;
  const strokeAttr = border
    ? ` stroke="${parseColor(border.color)?.rgba ?? 'none'}" stroke-width="${border.thickness ?? 1}"`
    : '';

  // 渐变 def（id 与 fillAttr 中的引用同步计算）
  if (gradFill) {
    const id = `g${out.length}`;
    const stops = (gradFill.stops ?? [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((s) => `<stop offset="${(s.position * 100).toFixed(0)}%" stop-color="${toHex(s.color)}" stop-opacity="${s.color.alpha ?? 1}"/>`)
      .join('');
    out.push(`<defs><linearGradient id="${id}" x1="${gradFill.from?.x ?? 0}" y1="${gradFill.from?.y ?? 0}" x2="${gradFill.to?.x ?? 1}" y2="${gradFill.to?.y ?? 0}">${stops}</linearGradient></defs>`);
  }

  // shapeGroup（布尔运算组）：只画整组包围盒近似，不递归运算子
  if (l._class === 'shapeGroup') {
    out.push(`<rect ${common} fill="${parseColor(fill?.color)?.rgba ?? '#c8c8d0'}" opacity="${opacity}"/>`);
    return;
  }

  switch (l._class) {
    case 'oval':
      out.push(`<ellipse cx="${(x + w / 2).toFixed(2)}" cy="${(y + h / 2).toFixed(2)}" rx="${(w / 2).toFixed(2)}" ry="${(h / 2).toFixed(2)}" ${fillAttr}${strokeAttr} opacity="${opacity}"/>`);
      break;
    case 'bitmap': {
      const ref = l.image?._ref ?? l.image?._ref_filepath;
      const buf = ref ? images.get(ref) : undefined;
      if (buf) {
        out.push(`<image ${common} preserveAspectRatio="none" opacity="${opacity}" href="data:image/png;base64,${buf.toString('base64')}"/>`);
      } else {
        out.push(`<rect ${common} fill="#d0d0d8" opacity="${opacity}"/>`);
      }
      break;
    }
    case 'text': {
      const enc = (style.textStyle?.encodedAttributes ?? {}) as Record<string, any>;
      const font = enc.MSAttributedStringFontAttribute?.attributes ?? {};
      const size = Number(font.size) || 14;
      const color = parseColor(enc.MSAttributedStringColorAttribute)?.rgba ?? '#000000';
      const align = style.paragraphStyle?.alignment ?? 0;
      const anchor = align === 1 ? 'end' : align === 2 ? 'middle' : 'start';
      const tx = align === 1 ? x + w : align === 2 ? x + w / 2 : x;
      const lh = style.paragraphStyle?.maximumLineHeight ?? size * 1.4;
      const lines = (l.attributedString?.string ?? '').split('\n');
      const tspans = lines
        .map((line, i) => `<tspan x="${tx.toFixed(2)}" y="${(y + size + i * lh).toFixed(2)}">${esc(line) || ' '}</tspan>`)
        .join('');
      out.push(`<text font-family="${esc(String(font.name ?? 'sans-serif'))}" font-size="${size}" fill="${color}" text-anchor="${anchor}" opacity="${opacity}">${tspans}</text>`);
      break;
    }
    case 'rectangle':
    case 'shapePath':
    case 'shapeGroup':
    case 'star':
    case 'triangle':
    case 'polygon':
    case 'symbolInstance': {
      if (PAINTABLE.has(l._class)) {
        const radii = (l.points ?? []).map((p) => p.cornerRadius ?? 0).filter((r) => r > 0);
        const r = radii.length ? Math.min(Math.max(...radii), Math.min(w, h) / 2) : (l.fixedRadius ?? 0);
        out.push(`<rect ${common} rx="${r.toFixed(2)}" ${fillAttr}${strokeAttr} opacity="${opacity}"/>`);
      }
      break;
    }
    default:
      break;
  }
}

async function renderArtboardSvg(ab: SketchLayer, zip: JSZip, images: Map<string, Buffer | null>): Promise<string> {
  const w = ab.frame?.width ?? 375;
  const h = ab.frame?.height ?? 812;
  const out: string[] = [];
  const bg = parseColor(ab.backgroundColor);
  if (bg && bg.alpha > 0) out.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="${bg.rgba}"/>`);
  svgNode(ab, 0, 0, images, out);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${out.join('')}</svg>`;
}

/* ---------- 入口：解析 .sketch 并入库 ---------- */

export async function importSketch(fileId: string, buf: Buffer): Promise<{ frames: number; nodes: number }> {
  const zip = await JSZip.loadAsync(buf);
  const pageFiles = Object.keys(zip.files).filter((p) => /^pages\/.+\.json$/.test(p) && !p.includes('__MACOSX'));
  if (pageFiles.length === 0) throw new Error('不是有效的 Sketch 文件（未找到 pages/*.json）');

  // 收集位图资源（key 同时记录完整路径与去扩展名的 ref 两种形式）
  const images = new Map<string, Buffer | null>();
  for (const [p, f] of Object.entries(zip.files)) {
    if (/^images\//.test(p) && !p.includes('__MACOSX')) {
      const data = await f.async('nodebuffer').catch(() => null);
      images.set(p, data);
      images.set(p.replace(/^images\//, '').replace(/\.\w+$/, ''), data);
    }
  }

  type ArtboardJob = { name: string; page: string; ab: SketchLayer; svg: string };
  const jobs: ArtboardJob[] = [];

  for (const pf of pageFiles) {
    const page = JSON.parse(await zip.file(pf)!.async('string')) as { layers?: SketchLayer[] };
    for (const ab of page.layers ?? []) {
      if (ab._class !== 'artboard' && ab._class !== 'symbolMaster') continue;
      const svg = await renderArtboardSvg(ab, zip, images);
      jobs.push({ name: ab.name || 'Artboard', page: pf.replace(/^pages\//, '').replace(/\.json$/, ''), ab, svg });
    }
  }
  if (jobs.length === 0) throw new Error('Sketch 文件中没有画板');

  const storage = await getStorage();
  let nodeCount = 0;
  let sortOrder = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM frames WHERE file_id = $1', [fileId]);

    for (const job of jobs) {
      const ox = job.ab.frame?.x ?? 0;
      const oy = job.ab.frame?.y ?? 0;
      const items = walkLayers(job.ab, ox, oy);

      const svgKey = `files/${fileId}/frames/${encodeURIComponent(job.ab.do_objectID)}.svg`;
      const svgUrl = await storage.put(svgKey, Buffer.from(job.svg, 'utf8'), 'image/svg+xml');

      await batchInsert(
        client,
        `INSERT INTO frames (file_id, node_id, name, page_name, width, height, thumb_url, sort_order)`,
        [[fileId, job.ab.do_objectID, job.name, job.page, job.ab.frame?.width ?? 0, job.ab.frame?.height ?? 0, svgUrl, sortOrder++]]
      );
      const { rows: fr } = await client.query<{ id: string }>(
        'SELECT id FROM frames WHERE file_id = $1 AND node_id = $2',
        [fileId, job.ab.do_objectID]
      );
      const frameRowId = fr[0].id;

      await batchInsert(
        client,
        `INSERT INTO nodes (file_id, frame_id, node_id, parent_id, name, type, x, y, width, height, visible, props)`,
        items.map((it) => [
          fileId, frameRowId, it.layer.do_objectID, it.parentId ?? job.ab.do_objectID,
          it.layer.name || it.layer._class, it.type.toUpperCase(),
          it.ax - ox, it.ay - oy,
          it.layer.frame?.width ?? 0, it.layer.frame?.height ?? 0,
          true, JSON.stringify(it.props),
        ])
      );
      nodeCount += items.length;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { frames: jobs.length, nodes: nodeCount };
}
