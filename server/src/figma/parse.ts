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
  /** 旋转角度（Figma 插件导出才有；REST 节点通常不带） */
  rotation?: number;
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

/**
 * 由渐变 handle 位置计算 CSS linear-gradient 角度（相对节点包围盒）。
 * 注意：Figma REST 返回的是 Vector 对象（{x, y}），历史上也有 [x, y] 数组形式，两种都要兼容。
 */
function toVector(h: unknown): { x: number; y: number } | null {
  if (Array.isArray(h)) {
    const x = Number(h[0]);
    const y = Number(h[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }
  if (h && typeof h === 'object') {
    const { x, y } = h as { x?: unknown; y?: unknown };
    const nx = Number(x);
    const ny = Number(y);
    return Number.isFinite(nx) && Number.isFinite(ny) ? { x: nx, y: ny } : null;
  }
  return null;
}

function gradientAngle(handles: unknown): number {
  if (!Array.isArray(handles) || handles.length < 2) return 180;
  const start = toVector(handles[0]);
  const end = toVector(handles[2]) ?? toVector(handles[1]);
  if (!start || !end) return 180;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
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
  /** REST 里是 Vector[]（{x,y}），旧数据可能是 number[][]，按 unknown 做防御解析 */
  gradientHandlePositions?: unknown;
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
  if (typeof paint.type === 'string' && paint.type.startsWith('GRADIENT_')) {
    const rawStops = Array.isArray(paint.gradientStops) ? paint.gradientStops : [];
    const stops = rawStops
      .filter((s) => s && typeof s === 'object' && s.color)
      .map((s) => `${toColor(s.color, s.color.a ?? 1).rgba} ${Math.round(s.position * 1000) / 10}%`)
      .join(', ');
    if (!stops) return base;
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

function parsePaints(fills: unknown, nodeId = '?'): ParsedFill[] {
  if (fills === undefined || fills === null) return [];
  if (!Array.isArray(fills)) {
    console.warn(`[parse] skip malformed fills on node ${nodeId}: not an array`);
    return [];
  }
  const out: ParsedFill[] = [];
  for (const paint of fills) {
    // 单个畸形 fill 只跳过自身，不能让整个节点（进而整次导入）失败
    try {
      out.push(parsePaint(paint as RawPaint));
    } catch (err) {
      console.warn(
        `[parse] skip malformed fill on node ${nodeId}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  return out;
}

interface RawEffect {
  type: string;
  visible?: boolean;
  offset?: { x: number; y: number };
  radius?: number;
  spread?: number;
  color?: { r: number; g: number; b: number; a?: number };
}

function parseEffects(effects: unknown, nodeId = '?'): ParsedEffect[] {
  if (effects === undefined || effects === null) return [];
  if (!Array.isArray(effects)) {
    console.warn(`[parse] skip malformed effects on node ${nodeId}: not an array`);
    return [];
  }
  const out: ParsedEffect[] = [];
  for (const e of effects as RawEffect[]) {
    try {
      if (!e || typeof e !== 'object') {
        console.warn(`[parse] skip malformed effect on node ${nodeId}: not an object`);
        continue;
      }
      if (e.visible === false) continue;
      const item: ParsedEffect = { type: e.type };
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
        const color = toColor(e.color ?? { r: 0, g: 0, b: 0 }, e.color?.a ?? 0.25);
        item.offsetX = round2(e.offset?.x ?? 0);
        item.offsetY = round2(e.offset?.y ?? 0);
        item.radius = round2(e.radius ?? 0);
        item.spread = round2(e.spread ?? 0);
        item.color = color;
        item.css = `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${item.offsetX}px ${item.offsetY}px ${item.radius}px ${item.spread}px ${color.rgba}`;
      }
      out.push(item);
    } catch (err) {
      console.warn(
        `[parse] skip malformed effect on node ${nodeId}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  return out;
}

function parseTextStyle(node: FigmaNode): ParsedTextStyle | undefined {
  if (node.type !== 'TEXT') return undefined;
  const s = (node.style ?? {}) as Record<string, number | string>;
  const solid = parsePaints(node.fills, node.id).find((f) => f.type === 'solid' && f.visible);
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

/** 是否画板类节点（供「按节点导入」筛选 id 使用）。 */
export const isArtboardType = (type: string): boolean => ARTBOARD_TYPES.has(type);

function bbox(node: FigmaNode): Rect | undefined {
  const box = node.absoluteBoundingBox as Rect | undefined;
  if (!box || typeof box !== 'object') return undefined;
  if (![box.x, box.y, box.width, box.height].every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return undefined;
  }
  return box;
}

/** Figma 的 children 应为数组；类型不符时按空数组处理，避免 for...of 抛「not iterable」 */
export function childrenOf(node: FigmaNode | null | undefined): FigmaNode[] {
  if (!node) return [];
  const kids = (node as { children?: unknown }).children;
  return Array.isArray(kids) ? (kids as FigmaNode[]) : [];
}

/** 记录被跳过的畸形节点，方便定位是哪个 node id 触发的 */
function skipNode(where: string, node: FigmaNode | null | undefined, err: unknown) {
  const id = node?.id ?? '?';
  const type = node?.type ?? '?';
  console.warn(
    `[parse] skip ${where} node ${id} (${type}):`,
    err instanceof Error ? err.message : String(err)
  );
}

function parseProps(node: FigmaNode): ParsedNodeProps {
  const text = parseTextStyle(node);
  const fills = parsePaints(node.fills, node.id);
  const radii = Array.isArray(node.rectangleCornerRadii)
    ? (node.rectangleCornerRadii as number[]).filter((v) => typeof v === 'number')
    : undefined;
  return {
    opacity: clamp01(node.opacity ?? 1),
    fills,
    strokes: parsePaints(node.strokes, node.id),
    strokeWeight: node.strokeWeight,
    strokeAlign: node.strokeAlign,
    effects: parseEffects(node.effects, node.id),
    cornerRadius: node.cornerRadius,
    cornerRadii: radii,
    blendMode: node.blendMode,
    rotation: typeof node.rotation === 'number' && Number.isFinite(node.rotation) ? node.rotation : undefined,
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
    for (const child of childrenOf(n)) {
      if (child.visible === false) continue;
      const cb = bbox(child);
      if (!cb) continue;
      try {
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
      } catch (err) {
        // 单个畸形图层只跳过自身，其余图层照常导入
        skipNode('layer', child, err);
      }
      if (childrenOf(child).length) walk(child, child.id);
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

/** 收集一个页面（或容器节点）下的画板；SECTION 内的画板也纳入。 */
function collectFrames(node: FigmaNode, pageName: string, startOrder = 0): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  let sortOrder = startOrder;
  const collect = (n: FigmaNode) => {
    for (const child of childrenOf(n)) {
      if (child.visible === false) continue;
      try {
        if (child.type === 'SECTION') {
          collect(child); // SECTION 本身不是画板，继续找里面的
          continue;
        }
        if (ARTBOARD_TYPES.has(child.type) && bbox(child)) {
          frames.push(parseArtboard(child, pageName, sortOrder++));
        }
      } catch (err) {
        // 畸形画板跳过，其余画板继续
        skipNode('artboard', child, err);
      }
    }
  };
  collect(node);
  return frames;
}

/** 解析整个文件：页面直系子节点中找画板；SECTION 内的画板也纳入。 */
export function parseFile(file: FileResponse): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  for (const page of childrenOf(file.document)) {
    // Figma REST 里页面节点的 type 是 CANVAS（兼容历史数据里的 PAGE）
    if (page.type !== 'PAGE' && page.type !== 'CANVAS') continue;
    try {
      frames.push(...collectFrames(page, page.name, frames.length));
    } catch (err) {
      skipNode('page', page, err);
    }
  }
  return frames;
}

/**
 * 解析「按节点导入」返回的子树：
 * - PAGE / CANVAS：按页面解析其中的画板
 * - SECTION：解析其中的画板
 * - 画板类（FRAME/COMPONENT/INSTANCE/GROUP）：自身即一张画板
 * - 其他（比如组件集）：把子节点里能当画板的收进来
 */
export function parseNodeSubtree(doc: FigmaNode, fallbackPageName: string): ParsedFrame[] {
  if (doc.type === 'PAGE' || doc.type === 'CANVAS') {
    return collectFrames(doc, doc.name || fallbackPageName);
  }
  if (doc.type === 'SECTION') {
    return collectFrames(doc, fallbackPageName);
  }
  if (ARTBOARD_TYPES.has(doc.type) && bbox(doc)) {
    return [parseArtboard(doc, fallbackPageName, 0)];
  }
  const frames: ParsedFrame[] = [];
  for (const child of childrenOf(doc)) {
    if (child.visible === false) continue;
    if (!ARTBOARD_TYPES.has(child.type) || !bbox(child)) continue;
    try {
      frames.push(parseArtboard(child, fallbackPageName, frames.length));
    } catch (err) {
      skipNode('artboard', child, err);
    }
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
