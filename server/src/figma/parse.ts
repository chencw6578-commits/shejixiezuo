import type { ExportSetting, FileResponse, FigmaNode, Rect } from './client.js';

// ---------- 对外数据结构 ----------

export interface ParsedColor {
  hex: string;    // #RRGGBB
  alpha: number;  // 0..1
  rgba: string;   // rgba(r,g,b,a)
}

export interface ParsedFill {
  type: 'solid' | 'gradient' | 'image' | 'other';
  visible: boolean;
  opacity: number;
  color?: ParsedColor;        // solid 时有
  css?: string;               // 可直接用于预览的 CSS background
  scaleMode?: string;         // image 填充
}

export interface ParsedEffect {
  type: string;               // DROP_SHADOW / INNER_SHADOW / LAYER_BLUR ...
  css?: string;               // box-shadow 片段（阴影类）
  offsetX?: number;
  offsetY?: number;
  radius?: number;
  spread?: number;
  color?: ParsedColor;
}

export interface ParsedTextStyle {
  family?: string;
  postScript?: string;
  weight?: number;
  size?: number;
  lineHeight?: number;        // px
  letterSpacing?: number;     // px
  alignHorizontal?: string;
  alignVertical?: string;
  textDecoration?: string;
  textCase?: string;
  color?: ParsedColor;        // 取第一个 solid 填充
}

export interface ParsedExportPreset {
  format: 'PNG' | 'SVG' | 'PDF' | 'JPG';
  suffix: string;
  scale: number;
}

export interface ParsedNodeProps {
  opacity: number;
  fills: ParsedFill[];
  strokes: ParsedFill[];
  strokeWeight?: number;
  strokeAlign?: string;
  effects: ParsedEffect[];
  cornerRadius?: number;
  cornerRadii?: number[];
  blendMode?: string;
  text?: ParsedTextStyle & { content: string };
  exportPresets: ParsedExportPreset[];
  hasImageFill: boolean;
}

export interface ParsedLayer {
  nodeId: string;
  parentId: string | null;
  name: string;
  type: string;
  x: number;                  // 相对画板左上角
  y: number;
  width: number;
  height: number;
  props: ParsedNodeProps;
}

export interface ParsedFrame {
  nodeId: string;
  name: string;
  pageName: string;
  width: number;
  height: number;
  sortOrder: number;
  layers: ParsedLayer[];
}

// ---------- 颜色工具 ----------

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function toColor(c: { r: number; g: number; b: number }, a = 1): ParsedColor {
  const r = Math.round(clamp01(c.r) * 255);
  const g = Math.round(clamp01(c.g) * 255);
  const b = Math.round(clamp01(c.b) * 255);
  const alpha = Math.round(clamp01(a) * 1000) / 1000;
  const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  return { hex, alpha, rgba: `rgba(${r}, ${g}, ${b}, ${alpha})` };
}

/** 由渐变 handle 位置计算 CSS linear-gradient 角度（相对节点包围盒）。 */
function gradientAngle(handles: number[][] | undefined): number {
  if (!handles || handles.length < 2) return 180;
  const [sx, sy] = handles[0];
  const [ex, ey] = handles[2] ?? handles[1];
  const dx = ex - sx;
  const dy = ey - sy;
  if (dx === 0 && dy === 0) return 180;
  // CSS 渐变角度：0deg 指向上，顺时针。Figma handle 方向即渐变方向。
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return Math.round(deg * 10) / 10;
}

// ---------- paint / effect 解析 ----------

interface RawPaint {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: { r: number; g: number; b: number; a?: number };
  gradientStops?: { position: number; color: { r: number; g: number; b: number; a?: number } }[];
  gradientHandlePositions?: number[][];
  scaleMode?: string;
}

function parsePaint(paint: RawPaint): ParsedFill {
  const opacity = clamp01(paint.opacity ?? 1);
  const visible = paint.visible !== false;
  const base: ParsedFill = { type: 'other', visible, opacity };

  if (paint.type === 'SOLID' && paint.color) {
    const color = toColor(paint.color, (paint.color.a ?? 1) * opacity);
    return { ...base, type: 'solid', color, css: color.rgba };
  }
  if (paint.type?.startsWith('GRADIENT_')) {
    const stops = (paint.gradientStops ?? [])
      .map((s) => `${toColor(s.color, s.color.a ?? 1).rgba} ${Math.round(s.position * 1000) / 10}%`)
      .join(', ');
    const kind = paint.type === 'GRADIENT_RADIAL' ? 'radial-gradient' : 'linear-gradient';
    const css =
      kind === 'radial-gradient'
        ? `radial-gradient(circle, ${stops})`
        : `linear-gradient(${gradientAngle(paint.gradientHandlePositions)}deg, ${stops})`;
    return { ...base, type: 'gradient', css };
  }
  if (paint.type === 'IMAGE') {
    return { ...base, type: 'image', scaleMode: paint.scaleMode, css: null as unknown as string };
  }
  return base;
}

function parsePaints(fills: unknown): ParsedFill[] {
  if (!Array.isArray(fills)) return [];
  return (fills as RawPaint[]).map(parsePaint);
}

interface RawEffect {
  type: string;
  visible?: boolean;
  offset?: { x: number; y: number };
  radius?: number;
  spread?: number;
  color?: { r: number; g: number; b: number; a?: number };
}

function parseEffects(effects: unknown): ParsedEffect[] {
  if (!Array.isArray(effects)) return [];
  return (effects as RawEffect[])
    .filter((e) => e.visible !== false)
    .map((e) => {
      const out: ParsedEffect = { type: e.type };
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
        const color = toColor(e.color ?? { r: 0, g: 0, b: 0 }, e.color?.a ?? 0.25);
        out.offsetX = round2(e.offset?.x ?? 0);
        out.offsetY = round2(e.offset?.y ?? 0);
        out.radius = round2(e.radius ?? 0);
        out.spread = round2(e.spread ?? 0);
        out.color = color;
        out.css = `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${out.offsetX}px ${out.offsetY}px ${out.radius}px ${out.spread}px ${color.rgba}`;
      }
      return out;
    });
}

function parseTextStyle(node: FigmaNode): ParsedTextStyle | undefined {
  if (node.type !== 'TEXT') return undefined;
  const s = (node.style ?? {}) as Record<string, number | string>;
  const solid = parsePaints(node.fills).find((f) => f.type === 'solid' && f.visible);
  const style: ParsedTextStyle = {
    family: s.fontFamily as string,
    postScript: s.fontPostScriptName as string,
    weight: s.fontWeight as number,
    size: s.fontSize as number,
    lineHeight: (s.lineHeightPx as number) ?? undefined,
    letterSpacing: (s.letterSpacing as number) ?? undefined,
    alignHorizontal: s.textAlignHorizontal as string,
    alignVertical: s.textAlignVertical as string,
    textDecoration: s.textDecoration as string,
    textCase: s.textCase as string,
  };
  if (solid) style.color = solid.color;
  return style;
}

function parseExportPresets(settings: ExportSetting[] | undefined): ParsedExportPreset[] {
  if (!Array.isArray(settings)) return [];
  return settings.map((s) => ({
    format: s.format ?? 'PNG',
    suffix: s.suffix ?? '',
    // constraint SCALE 的 value 即倍率；缺省按 2x
    scale: s.constraint?.type === 'SCALE' ? s.constraint.value : 2,
  }));
}

const round2 = (v: number) => Math.round(v * 100) / 100;

// ---------- 节点遍历 ----------

/** 可被选中查看属性的图层类型。 */
const SELECTABLE = new Set([
  'FRAME', 'GROUP', 'COMPONENT', 'INSTANCE', 'RECTANGLE', 'TEXT',
  'ELLIPSE', 'VECTOR', 'LINE', 'BOOLEAN_OPERATION', 'REGULAR_POLYGON',
  'STAR', 'SLICE',
]);

/** 画板类型（页面直系子节点）。 */
const ARTBOARD_TYPES = new Set(['FRAME', 'COMPONENT', 'INSTANCE', 'GROUP']);

function bbox(node: FigmaNode): Rect | undefined {
  return node.absoluteBoundingBox ?? undefined;
}

function parseProps(node: FigmaNode): ParsedNodeProps {
  const text = parseTextStyle(node);
  const fills = parsePaints(node.fills);
  const radii = node.rectangleCornerRadii;
  return {
    opacity: clamp01(node.opacity ?? 1),
    fills,
    strokes: parsePaints(node.strokes),
    strokeWeight: node.strokeWeight,
    strokeAlign: node.strokeAlign,
    effects: parseEffects(node.effects),
    cornerRadius: node.cornerRadius,
    cornerRadii: radii,
    blendMode: node.blendMode,
    text: text ? { ...text, content: node.characters ?? '' } : undefined,
    exportPresets: parseExportPresets(node.exportSettings),
    hasImageFill: fills.some((f) => f.type === 'image' && f.visible),
  };
}

/** 解析一个画板及其内部所有图层（坐标归一到画板左上角）。 */
function parseArtboard(node: FigmaNode, pageName: string, sortOrder: number): ParsedFrame {
  const box = bbox(node) ?? { x: 0, y: 0, width: 0, height: 0 };
  const ox = box.x;
  const oy = box.y;
  const layers: ParsedLayer[] = [];

  const walk = (n: FigmaNode, parentId: string | null) => {
    for (const child of n.children ?? []) {
      if (child.visible === false) continue;
      const cb = bbox(child);
      if (!cb) continue;
      if (SELECTABLE.has(child.type)) {
        layers.push({
          nodeId: child.id,
          parentId,
          name: child.name,
          type: child.type,
          x: round2(cb.x - ox),
          y: round2(cb.y - oy),
          width: round2(cb.width),
          height: round2(cb.height),
          props: parseProps(child),
        });
      }
      if (child.children?.length) walk(child, child.id);
    }
  };

  walk(node, node.id);
  return {
    nodeId: node.id,
    name: node.name,
    pageName,
    width: round2(box.width),
    height: round2(box.height),
    sortOrder,
    layers,
  };
}

/** 解析整个文件：页面直系子节点中找画板；SECTION 内的画板也纳入。 */
export function parseFile(file: FileResponse): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  const pages = file.document?.children ?? [];

  for (const page of pages) {
    if (page.type !== 'PAGE') continue;
    let sortOrder = 0;
    const collect = (node: FigmaNode) => {
      for (const child of node.children ?? []) {
        if (child.visible === false) continue;
        if (child.type === 'SECTION') {
          collect(child); // SECTION 本身不是画板，继续找里面的
          continue;
        }
        if (ARTBOARD_TYPES.has(child.type) && bbox(child)) {
          frames.push(parseArtboard(child, page.name, sortOrder++));
        }
      }
    };
    collect(page);
  }
  return frames;
}

/**
 * 计算画板缩略图导出倍率：优先 2x，最长边超过 Figma 渲染上限时降级。
 */
export function thumbScale(width: number, height: number, maxPx = 4096): number {
  const longest = Math.max(width, height);
  if (longest * 2 <= maxPx) return 2;
  if (longest <= maxPx) return 1;
  return round2(maxPx / longest);
}
