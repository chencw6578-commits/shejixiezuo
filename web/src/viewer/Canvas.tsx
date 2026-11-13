import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FrameDetail, LayerNode } from '../types';
import type { CommentItem } from '../api';
import type { Unit } from '../unit';
import { canvasBgStyle, useCanvasBg } from '../canvasBg';
import CanvasBgPicker from '../components/CanvasBgPicker';
import { metricToPx } from './textMetric';
import { analyzeGradientPixels, gradientHexList, parseGradientCss, type GradientInfo } from './gradient';
import { Maximize, Minus, Plus } from '../components/icons';

interface Props {
  frame: FrameDetail['frame'];
  nodes: LayerNode[];
  selectedId: string | null;
  hoverId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onZoomChange: (z: number) => void;
  /** 尺寸单位：只影响数值后缀，不改变尺寸/坐标 */
  unit?: Unit;
  comments?: CommentItem[];
  commentMode?: boolean;
  /** 吸管取色模式：光标十字、悬浮色值预览、点击吸取颜色 */
  eyedropper?: boolean;
  onAddComment?: (draft: { x: number; y: number; nodeId?: string }, body: string) => Promise<void>;
  onOpenComment?: (id: string) => void;
}

interface Draft { x: number; y: number; nodeId?: string }

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

interface Rect {
  x: number; y: number; w: number; h: number;
}

/**
 * 节点矢量渲染：把 parse.ts / 演示种子共用的 props 映射为渲染样式。
 * 文本图层的 fills 表示字形颜色而不是背景色，因此这里与 parse.ts 保持同一约定。
 */
function layerBoxStyle(n: LayerNode, zoom: number): React.CSSProperties {
  const p = n.props ?? ({} as LayerNode['props']);
  const fills = (p.fills ?? []).filter((f) => f.visible);
  const fill = fills.find((f) => f.type === 'solid' || f.type === 'gradient');
  const stroke = (p.strokes ?? []).find((s) => s.visible && s.color);
  // 有渲染资产（SVG/位图）时形状与填充由资产承载，不再 CSS 近似绘制
  const hasRender = !!n.render_url;
  const box: React.CSSProperties = {
    position: 'absolute',
    left: n.x * zoom,
    top: n.y * zoom,
    width: Math.max(0, n.width) * zoom,
    height: Math.max(0, n.height) * zoom,
    boxSizing: 'border-box',
    opacity: p.opacity ?? 1,
  };
  const radius = p.cornerRadius ?? 0;
  if (radius > 0) box.borderRadius = radius * zoom;
  else if (n.type === 'ELLIPSE') box.borderRadius = '50%';
  if (!hasRender && n.type !== 'TEXT' && fill) {
    if (fill.type === 'solid' && fill.color) box.background = fill.color.rgba;
    else if (fill.type === 'gradient' && fill.css) box.background = fill.css;
  }
  if (!hasRender && stroke?.color) {
    box.border = `${Math.max((p.strokeWeight ?? 1) * zoom, 0.5)}px solid ${stroke.color.rgba}`;
  }
  const shadows = (p.effects ?? [])
    .filter((e) => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')
    .map(
      (e) =>
        `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${(e.offsetX ?? 0) * zoom}px ${(e.offsetY ?? 0) * zoom}px ${(e.radius ?? 0) * zoom}px ${(e.spread ?? 0) * zoom}px ${e.color?.rgba ?? 'rgba(0,0,0,0.25)'}`
    );
  if (shadows.length) box.boxShadow = shadows.join(', ');
  return box;
}

function layerTextStyle(n: LayerNode, zoom: number): React.CSSProperties | null {
  const t = n.props?.text;
  if (!t?.content) return null;
  const align = String(t.alignHorizontal ?? 'LEFT').toUpperCase();
  // 文本度量可能是 {unit,value} 对象（插件导入），统一换算，避免 NaNpx / 渲染报错
  const size = metricToPx(t.size);
  const lh = metricToPx(t.lineHeight, size ?? undefined);
  const ls = metricToPx(t.letterSpacing, size ?? undefined);
  return {
    fontFamily: typeof t.family === 'string' && t.family
      ? `"${t.family}", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`
      : undefined,
    fontSize: (size ?? 12) * zoom,
    fontWeight: typeof t.weight === 'number' ? t.weight : 400,
    lineHeight: lh !== null && lh > 0 ? `${lh * zoom}px` : undefined,
    letterSpacing: ls !== null && ls !== 0 ? `${ls * zoom}px` : undefined,
    color:
      t.color?.rgba ??
      n.props?.fills?.find((f) => f.visible && f.color)?.color?.rgba ??
      '#1D2129',
    textAlign: align === 'CENTER' ? 'center' : align === 'RIGHT' ? 'right' : 'left',
    justifyContent: align === 'CENTER' ? 'center' : align === 'RIGHT' ? 'flex-end' : 'flex-start',
    display: 'flex',
    alignItems: t.alignVertical === 'TOP' ? 'flex-start' : t.alignVertical === 'BOTTOM' ? 'flex-end' : 'center',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflow: 'visible',
  };
}

/**
 * 选中 A、鼠标移到 B 时，测出 A↔B 的距离：水平 / 垂直各一条。
 * 只在存在正间距的方向出标注，相交或包含不制造 0 / 负数标签；
 * 斜向放置的两个元素会同时给出两轴距离（设计交付工具的标准测距）。
 */
function measureBetween(a: Rect, b: Rect): Measure[] {
  const out: Measure[] = [];
  const leftGap = a.x - (b.x + b.w);
  const rightGap = b.x - (a.x + a.w);
  const topGap = a.y - (b.y + b.h);
  const bottomGap = b.y - (a.y + a.h);
  // y 轴投影重叠 → 水平引线走重叠区中点；否则走 A 的水平中心线
  const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  if (leftGap > 0.5 || rightGap > 0.5) {
    const side: Side = leftGap > 0.5 ? 'left' : 'right';
    const y = yOverlap > 0 ? Math.max(a.y, b.y) + yOverlap / 2 : a.y + a.h / 2;
    out.push({
      side, axis: 'h', gap: side === 'left' ? leftGap : rightGap,
      x1: side === 'left' ? b.x + b.w : a.x + a.w, y1: y,
      x2: side === 'left' ? a.x : b.x, y2: y,
    });
  }
  if (topGap > 0.5 || bottomGap > 0.5) {
    const side: Side = topGap > 0.5 ? 'top' : 'bottom';
    const x = xOverlap > 0 ? Math.max(a.x, b.x) + xOverlap / 2 : a.x + a.w / 2;
    out.push({
      side, axis: 'v', gap: side === 'top' ? topGap : bottomGap,
      x1: x, y1: side === 'top' ? b.y + b.h : a.y + a.h,
      x2: x, y2: side === 'top' ? a.y : b.y,
    });
  }
  return out;
}

type Side = 'left' | 'right' | 'top' | 'bottom';
interface Measure {
  side: Side;
  axis: 'h' | 'v';
  gap: number;
  x1: number; y1: number; x2: number; y2: number;
  peerId?: string;
  /** 包含关系的四边 inset 标注（标签锚在引线中点） */
  inset?: boolean;
}

/** 图标内部绘制路径不是布局元素，与紧包它的图标容器之间不出 inset 距离 */
const PATH_TYPES = ['VECTOR', 'BOOLEAN_OPERATION', 'LINE', 'ELLIPSE', 'POLYGON', 'STAR'];

/**
 * 包含关系（hover 到父级背景 / 容器，或反过来 hover 到内层子元素）：
 * 显示内层元素到外层容器四边的距离，与设计标注工具的 inset 标注一致。
 * 每条引线从内层元素对应边中点画到外层容器的边；贴边时显示 0，负值（几何异常）不画。
 */
function insetMeasures(inner: Rect, outer: Rect): Measure[] {
  const out: Measure[] = [];
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  const push = (side: Side, gap: number, line: { x1: number; y1: number; x2: number; y2: number }) => {
    if (gap < 0) return;
    out.push({ side, axis: side === 'left' || side === 'right' ? 'h' : 'v', gap, ...line, inset: true });
  };
  push('top', inner.y - outer.y, { x1: cx, y1: outer.y, x2: cx, y2: inner.y });
  push('bottom', outer.y + outer.h - (inner.y + inner.h), { x1: cx, y1: inner.y + inner.h, x2: cx, y2: outer.y + outer.h });
  push('left', inner.x - outer.x, { x1: outer.x, y1: cy, x2: inner.x, y2: cy });
  push('right', outer.x + outer.w - (inner.x + inner.w), { x1: inner.x + inner.w, y1: cy, x2: outer.x + outer.w, y2: cy });
  return out;
}

export default function Canvas({
  frame, nodes, selectedId, hoverId, onSelect, onHover, onZoomChange, unit = 'px',
  comments = [], commentMode = false, onAddComment, onOpenComment, eyedropper = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const artboardRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoomState] = useState(1);
  const zoomRef = useRef(1);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  // 空格按住 = 平移模式（Figma 式）：光标变抓手，拖拽不触发选中/评论
  const [spacePan, setSpacePan] = useState(false);
  const spaceRef = useRef(false);
  // 画布平移偏移（transform 实现，无需滚动空间，任意方向可拖）
  const [pan, setPanState] = useState({ x: 0, y: 0 });
  const panXYRef = useRef({ x: 0, y: 0 });
  const setPanXY = useCallback((x: number, y: number) => {
    panXYRef.current = { x, y };
    setPanState({ x, y });
  }, []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftBody, setDraftBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // 画布底色（localStorage，按用户，与项目画布页共用偏好）
  const [canvasBg, pickCanvasBg] = useCanvasBg();
  const bg = canvasBgStyle(canvasBg);
  // 画板底图：插件导入时已经保存了 Figma 原生 exportAsync 的整板 PNG（含图片填充、图标、渐变）。
  // 节点矢量层只是 CSS 近似，还原不了这些，因此固定展示原图（无原图时回退到节点渲染）。

  // ── 吸管取色 ────────────────────────────────────────────────
  // 原图模式：把整板 PNG 画进离屏 canvas（按 src 缓存），点击处映射回自然像素取色；
  // 无原图（纯 DOM 渲染）时回退浏览器原生 EyeDropper API（Chrome 95+）。
  const [pickPreview, setPickPreview] = useState<{ x: number; y: number; hex: string; isGradient: boolean } | null>(null);
  const [picked, setPicked] = useState<{
    x: number; y: number; hex: string; rgb: string; gradient: GradientInfo | null;
  } | null>(null);
  const [copyKey, setCopyKey] = useState<string | null>(null);
  const sampleCanvasRef = useRef<{ src: string; canvas: HTMLCanvasElement } | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  /** 屏幕坐标 → 整板原图像素坐标 + 离屏 canvas。不在画板图内返回 null。 */
  const getSamplePoint = useCallback((clientX: number, clientY: number) => {
    const img = containerRef.current?.querySelector<HTMLImageElement>('.artboard-img');
    const ab = artboardRef.current;
    if (!img || !ab || !img.complete || !img.naturalWidth) return null;
    const rect = ab.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    const nw = img.naturalWidth, nh = img.naturalHeight;
    // .artboard-img 是 object-fit: cover：按 cover 裁切公式映射回原图坐标
    const scale = Math.max(rect.width / nw, rect.height / nh);
    const ox = (rect.width - nw * scale) / 2;
    const oy = (rect.height - nh * scale) / 2;
    const sx = Math.floor((x - ox) / scale);
    const sy = Math.floor((y - oy) / scale);
    if (sx < 0 || sy < 0 || sx >= nw || sy >= nh) return null;
    let entry = sampleCanvasRef.current;
    if (!entry || entry.src !== img.currentSrc) {
      const c = document.createElement('canvas');
      c.width = nw;
      c.height = nh;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0);
      entry = { src: img.currentSrc, canvas: c };
      sampleCanvasRef.current = entry;
    }
    const ctx = entry.canvas.getContext('2d') as CanvasRenderingContext2D | null;
    if (!ctx) return null;
    return { ctx, sx, sy, nw, nh };
  }, []);

  /** 屏幕坐标 → 设计稿像素颜色。 */
  const sampleColorAt = useCallback((clientX: number, clientY: number): string | null => {
    const p = getSamplePoint(clientX, clientY);
    if (!p) return null;
    const data = p.ctx.getImageData(p.sx, p.sy, 1, 1).data;
    return '#' + [data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
  }, [getSamplePoint]);

  /** 优先取图层里导入的渐变定义（Figma / Sketch 原始数据，非推测）。 */
  const findLayerGradientAt = useCallback((clientX: number, clientY: number): GradientInfo | null => {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const hz = el?.closest('.hotzone[data-node-id]') as HTMLElement | null;
    const id = hz?.dataset.nodeId;
    if (!id) return null;
    const node = nodesRef.current.find((v) => v.node_id === id);
    const fill = node?.props?.fills?.find((f) => f.visible && f.type === 'gradient' && typeof f.css === 'string');
    return fill ? parseGradientCss(fill.css) : null;
  }, []);

  const copyText = useCallback((text: string, key: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopyKey(key);
      window.setTimeout(() => setCopyKey((cur) => (cur === key ? null : cur)), 1500);
    }).catch(() => {});
  }, []);

  const toLocal = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  // 悬浮预览：吸管模式下鼠标移动实时显示所指像素的色值；命中渐变图层时给出「渐变」提示
  const onEyeDropperMove = useCallback(
    (e: React.MouseEvent) => {
      if (!eyedropper) return;
      const hex = sampleColorAt(e.clientX, e.clientY);
      const isGradient = !!findLayerGradientAt(e.clientX, e.clientY);
      setPickPreview(hex ? { ...toLocal(e.clientX, e.clientY), hex, isGradient } : null);
    },
    [eyedropper, sampleColorAt, toLocal, findLayerGradientAt]
  );

  const pickColor = useCallback(
    (clientX: number, clientY: number) => {
      if (!showImageRef.current) {
        // 无整板图：浏览器原生吸管（全屏幕取色，含 DOM 渲染层）
        const Ctor = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
        if (!Ctor) return;
        new Ctor()
          .open()
          .then((r: { sRGBHex: string }) => {
            const hex = r.sRGBHex.toLowerCase();
            const n = parseInt(hex.slice(1), 16);
            const p = toLocal(clientX, clientY);
            setPicked({ ...p, hex, rgb: `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`, gradient: null });
            void navigator.clipboard?.writeText(hex.toUpperCase()).catch(() => {});
          })
          .catch(() => { /* 用户取消 */ });
        return;
      }
      const hex = sampleColorAt(clientX, clientY);
      if (!hex) return;
      // ① 图层渐变定义（权威） ② 兜底：整板图局部像素拟合，识别无图层数据时的渐变
      let gradient = findLayerGradientAt(clientX, clientY);
      if (!gradient) {
        const p = getSamplePoint(clientX, clientY);
        if (p) gradient = analyzeGradientPixels(p.ctx, p.nw, p.nh, p.sx, p.sy, 20);
      }
      const n = parseInt(hex.slice(1), 16);
      setPicked({
        ...toLocal(clientX, clientY), hex,
        rgb: `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`,
        gradient,
      });
      setPickPreview(null);
      // 识别到渐变 → 默认复制整段 CSS；纯色 → 保持原来的「复制点击处 HEX」
      // 用独立的 'auto' 标记，避免一弹出结果卡就把「复制 CSS」按钮文案顶掉
      copyText(gradient ? gradient.css : hex.toUpperCase(), 'auto');
    },
    [sampleColorAt, toLocal, getSamplePoint, findLayerGradientAt, copyText]
  );

  // 退出吸管 / Esc：清掉预览与结果
  useEffect(() => {
    if (!eyedropper) {
      setPickPreview(null);
      setPicked(null);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPicked(null);
        setPickPreview(null);
      }
    };
    // 点击卡片以外任意位置自动关闭（画布上点击会先关再由 onClick 取新色）
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('.eyedropper-result')) return;
      setPicked(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [eyedropper]);
  // ──────────────────────────────────────────────────────────

  const setZoom = useCallback((z: number) => {
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    zoomRef.current = z;
    setZoomState(z);
    onZoomChange(z);
  }, [onZoomChange]);

  /** 自适应：画板完整展示在可视区内 */
  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const pad = 80;
    const z = Math.min(
      (el.clientWidth - pad) / frame.width,
      (el.clientHeight - pad) / frame.height,
      1
    );
    setZoom(clamp(z, MIN_ZOOM, MAX_ZOOM));
    setPanXY(
      (el.clientWidth - frame.width * zoomRef.current) / 2,
      (el.clientHeight - frame.height * zoomRef.current) / 2
    );
  }, [frame.width, frame.height, setZoom, setPanXY]);

  /** 以容器中心为锚点缩放（缩放按钮用） */
  const zoomCenter = useCallback(
    (z: number) => {
      const el = containerRef.current;
      const next = clamp(z, MIN_ZOOM, MAX_ZOOM);
      if (!el) return setZoom(next);
      const cx = el.clientWidth / 2;
      const cy = el.clientHeight / 2;
      const old = zoomRef.current;
      const p = panXYRef.current;
      setPanXY(cx - (cx - p.x) * (next / old), cy - (cy - p.y) * (next / old));
      setZoom(next);
    },
    [setZoom, setPanXY]
  );

  // 首次加载自适应
  useEffect(() => {
    const t = setTimeout(() => fit(), 50);
    return () => clearTimeout(t);
  }, [frame.id, fit]);

  // ctrl/meta + 滚轮缩放（以光标为锚点）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const old = zoomRef.current;
      const next = clamp(old * Math.exp(-e.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
      const p = panXYRef.current;
      setPanXY(cx - (cx - p.x) * (next / old), cy - (cy - p.y) * (next / old));
      setZoom(next);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [setZoom]);

  // 空格按住 = 平移模式（Figma 式）：光标变抓手，拖拽不触发选中/评论
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isTyping(e.target)) return;
      e.preventDefault(); // 阻止页面滚动/焦点按钮触发
      spaceRef.current = true;
      setSpacePan(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceRef.current = false;
      setSpacePan(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // 键盘 + / - 缩放画布（输入框聚焦时不触发）
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.key === '+' || e.key === '=' || e.code === 'Equal' || e.code === 'NumpadAdd') {
        e.preventDefault();
        zoomCenter(zoomRef.current * 1.25);
      } else if (e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract') {
        e.preventDefault();
        zoomCenter(zoomRef.current / 1.25);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomCenter]);

  // 空白处拖拽平移（拖动超过阈值后吞掉随后的 click，避免拖完误选图层）
  // move/up 必须挂 window：挂容器时，平移中 pan 状态每帧变化重建热区层，
  // Chrome 会合成 pointerleave/pointercancel（clientY=0）打断监听——
  // 表现为拖到一半画布"卡住"，每次只动一小段（项目画布页同为 window 级监听，无此问题）。
  const dragMovedRef = useRef(false);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // 吸管模式：不做空白拖拽平移
    if (eyedropper) return;
    panRef.current = { x: e.clientX, y: e.clientY };
    dragMovedRef.current = false;
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!panRef.current) return;
      const dx = e.clientX - panRef.current.x;
      const dy = e.clientY - panRef.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragMovedRef.current = true;
      const p = panXYRef.current;
      setPanXY(p.x + dx, p.y + dy);
      panRef.current = { x: e.clientX, y: e.clientY };
    };
    const up = () => (panRef.current = null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);

  // 退出评论模式时清掉起草中的评论
  useEffect(() => {
    if (!commentMode) {
      setDraft(null);
      setDraftBody('');
    }
  }, [commentMode]);

  const openDraftAt = useCallback(
    (clientX: number, clientY: number, nodeId?: string) => {
      const ab = artboardRef.current;
      if (!ab) return;
      const rect = ab.getBoundingClientRect();
      const x = clamp((clientX - rect.left) / zoomRef.current, 0, frame.width);
      const y = clamp((clientY - rect.top) / zoomRef.current, 0, frame.height);
      setDraft({ x, y, nodeId });
      setDraftBody('');
    },
    [frame.width, frame.height]
  );

  const submitDraft = useCallback(async () => {
    if (!draft || !draftBody.trim() || !onAddComment) return;
    setSubmitting(true);
    try {
      await onAddComment({ x: draft.x, y: draft.y, nodeId: draft.nodeId }, draftBody.trim());
      setDraft(null);
      setDraftBody('');
    } finally {
      setSubmitting(false);
    }
  }, [draft, draftBody, onAddComment]);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.node_id, n])), [nodes]);
  const selected = selectedId ? nodeById.get(selectedId) : undefined;
  const hovered = hoverId ? nodeById.get(hoverId) : undefined;
  // 有切图的图层：Figma/Sketch 导入时打了导出预设的节点，与「按设计标记导出 zip」同一口径。
  // 画布上用极浅虚线框轻提示（不遮挡内容），hover/选中时才有完整描边与尺寸徽标。
  const sliceNodes = useMemo(
    () => nodes.filter((n) => (n.props?.exportPresets?.length ?? 0) > 0),
    [nodes]
  );
  const fmt = useCallback(
    (a: LayerNode): Rect => ({ x: a.x, y: a.y, w: a.width, h: a.height }),
    []
  );
  /**
   * 尺寸标注统一口径：图标内部的 Vector 只是绘制路径，不是切图单位。
   * 例：Figma 导出标记打在外层 20×20 容器上，内部 Vector 的 bbox 是
   * 16.67×15.83（≈17×16）。旧逻辑按「当前 hover / 选中的节点」直接显示，
   * 同一个图标会随鼠标命中的层级不同一会儿 20×20、一会儿 17×16，干扰判断。
   * 这里统一取图标容器（优先 Figma 导出标记所在层）的尺寸与位置。
   */
  const sizeBadge = useCallback(
    (n: LayerNode | undefined) => {
      if (!n) return null;
      const anc = n.exportPresetAncestor;
      // 父级没有 Figma 标记的图标（如 309:886 / 312:907 这类 20×20 容器）也按父级容器标注，
      // 否则内部 Vector 仍会冒出 17×17、15×16 这类路径 bbox。
      const isPath = ['VECTOR', 'BOOLEAN_OPERATION', 'LINE', 'ELLIPSE', 'POLYGON', 'STAR'].includes(n.type);
      const parent = n.parent_id ? nodeById.get(n.parent_id) : undefined;
      // 只认近正方形的小图标容器（20×20 / 14×14 / 24×24）。长条文本容器
      // （67×11 等）不是图标，仍按路径自身尺寸标注，避免制造新的错误数字。
      const iconParent = !anc && isPath && parent &&
        parent.width <= 64 && parent.height <= 64 &&
        Math.abs(parent.width - parent.height) <= 1 &&
        parent.width >= n.width * 0.6 && parent.height >= n.height * 0.6 &&
        parent.width * parent.height <= Math.max(64, n.width * n.height * 2.5)
        ? parent : null;
      // anc 自带父级真实尺寸，即使该节点不在本页 nodes 里也不会退回路径 bbox
      const markedNode = anc ? nodeById.get(anc.node_id) : null;
      const target = markedNode || iconParent || n;
      const w = anc ? anc.width : (iconParent || n).width;
      const h = anc ? anc.height : (iconParent || n).height;
      return { rect: fmt(target), w, h };
    },
    [nodeById, fmt]
  );
  // 描边框与尺寸徽标共用同一口径：只框住真实切图范围（图标容器），
  // 内部 Vector 的 17×16 bbox 不再单独画一个框，也不再单独标一个尺寸。
  const selectedOutline = sizeBadge(selected);
  const hoverOutline = sizeBadge(hovered);
  const sameOutline = (a: Rect | null, b: Rect | null) =>
    !!a && !!b &&
    Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5 &&
    Math.abs(a.w - b.w) <= 0.5 && Math.abs(a.h - b.h) <= 0.5;
  // hover 命中的是同一个图标的内外层时，只保留选中框，避免出现一大一小两个框
  const showHoverOutline = !!hovered && hovered !== selected &&
    !sameOutline(selectedOutline?.rect ?? null, hoverOutline?.rect ?? null);
  // 任何时刻只保留一个尺寸徽标：有选中时以选中对象为准，未选中时才看悬停对象
  const sizeTag = selectedOutline ?? hoverOutline;
  // 距离标注的触发口径：只有「选中 A + 鼠标移到另一个元素 B」时才显示 A↔B 的距离。
  // 不相交 → 两轴间距；B 包含 A（hover 父级背景）或 A 包含 B → 内层到外层四边的 inset；
  // 图标容器与内部绘制路径不算布局包含，避免 0~3pt 的碎片数字（沿用上一轮口径）。
  const measures = useMemo<Measure[]>(() => {
    if (!selected || !hovered || hovered === selected) return [];
    const a = fmt(selected);
    const b = fmt(hovered);
    const contains = (o: Rect, i: Rect) =>
      o.x <= i.x + 0.5 && o.y <= i.y + 0.5 &&
      o.x + o.w >= i.x + i.w - 0.5 && o.y + o.h >= i.y + i.h - 0.5 &&
      o.w * o.h > i.w * i.h;
    const iconLike = (n: LayerNode) =>
      n.width <= 64 && n.height <= 64 && Math.abs(n.width - n.height) <= 1;
    const iconPair = (inner: LayerNode, outer: LayerNode) =>
      PATH_TYPES.includes(inner.type) && iconLike(outer);
    if (contains(b, a) && !iconPair(selected, hovered)) {
      return insetMeasures(a, b).map((m) => ({ ...m, peerId: hovered.node_id }));
    }
    if (contains(a, b) && !iconPair(hovered, selected)) {
      return insetMeasures(b, a).map((m) => ({ ...m, peerId: hovered.node_id }));
    }
    return measureBetween(a, b).map((m) => ({ ...m, peerId: hovered.node_id }));
  }, [selected, hovered, fmt]);

  // 画板边缘测距：选中元素后鼠标移到画板边边（<=10px）时，显示元素到画板左边/上边的距离。
  // 与节点间距标注同一套视觉（品牌色虚线 + 胶囊标签），标签只显示数值 + 单位。
  const [frameEdgeHover, setFrameEdgeHover] = useState(false);
  const frameMeasures = useMemo<Measure[]>(() => {
    if (!frameEdgeHover || !selected) return [];
    const a = fmt(selected);
    const cx = a.x + a.w / 2;
    const cy = a.y + a.h / 2;
    const out: Measure[] = [];
    // 元素飞出画板（负坐标）不画；贴边显示 0
    if (a.y >= 0) out.push({ side: 'top', axis: 'v', gap: a.y, x1: cx, y1: 0, x2: cx, y2: a.y, peerId: '__frame__' });
    if (a.x >= 0) out.push({ side: 'left', axis: 'h', gap: a.x, x1: 0, y1: cy, x2: a.x, y2: cy, peerId: '__frame__' });
    return out;
  }, [frameEdgeHover, selected, fmt]);

  const FRAME_EDGE_PX = 10;
  const onArtboardMouseMove = (e: React.MouseEvent) => {
    const ab = artboardRef.current;
    if (!ab || !selectedId) {
      if (frameEdgeHover) setFrameEdgeHover(false);
      return;
    }
    const r = ab.getBoundingClientRect();
    const near =
      Math.min(e.clientX - r.left, r.right - e.clientX, e.clientY - r.top, r.bottom - e.clientY) <=
      FRAME_EDGE_PX;
    if (near !== frameEdgeHover) setFrameEdgeHover(near);
  };

  const W = frame.width * zoom;
  const H = frame.height * zoom;
  // 有节点数据 → 节点矢量渲染；否则回退到位图 + 热区（两条路径共用同一套热区命中逻辑）
  const hasNodes = nodes.length > 0;
  const hasThumb = !!frame.thumb_url;
  // 原图是导入时 Figma 原生导出的整板 PNG，与画板列表缩略图同一份文件，保真度最高。
  // 无节点数据时无条件用原图；有节点时也固定用原图（模式切换按钮已全部移除）。
  const showImage = hasThumb;
  const showVector = hasNodes && !showImage;
  const showImageRef = useRef(showImage);
  showImageRef.current = showImage;
  // 缩放是把每个坐标手动乘 zoom（.artboard 只有 translate，没有 transform: scale），
  // 所以标注层的 DOM / SVG 本身就是屏幕像素坐标系。以前按「外层 scale(zoom)」的假设
  // 用 1/zoom 反向补偿，结果 zoom 越大字号、描边越细 —— 即「越放大文字越小」。
  // 统一改成恒定像素：标注不随画板缩放，与 Figma / 蓝湖等标注工具行为一致。
  const lw = 1; // 恒定 1px 描边
  const fs = 11; // 恒定 11px 字号

  // 距离统一只在 hover 其它元素时出现（见 measures）；
  // 旧版「选中即自动标注到父容器四边距离」已移除，避免不 hover 时刷出一堆数字。


  const badgeStyle = (r: Rect): React.CSSProperties => {
    // 偏移量同样是屏幕像素：放大时标签与选中框的间距应保持恒定，不能除以 zoom
    const below = (r.y + r.h) * zoom + 20 <= H;
    return {
      position: 'absolute',
      left: r.x * zoom + (r.w * zoom) / 2,
      top: below ? (r.y + r.h) * zoom + 6 : r.y * zoom - 6,
      transform: `translate(-50%, ${below ? '0%' : '-100%'})`,
      fontSize: fs,
      padding: '2px 5px',
      borderRadius: 2,
      whiteSpace: 'nowrap',
    };
  };

  return (
    <div
      className={`canvas-container viewer-stage${spacePan ? ' space-pan' : ''}${eyedropper ? ' is-eyedropper' : ''} ${bg.className}`}
      ref={containerRef}
      style={bg.style}
      onPointerDown={onPointerDown}
      onMouseMove={onEyeDropperMove}
      onDragStart={(e) => e.preventDefault()}
      onMouseDown={(e) => {
        // 吸管模式：点击即取色，不取消选中、不触发其他行为
        if (eyedropper) return;
        // 点击空白取消选中（拖拽后不触发）；空格平移模式下不触发；评论模式下改为在点击处起草评论
        if (spaceRef.current) return;
        const target = e.target as HTMLElement;
        // 画板外的画布空白（容器本身）与画板/图片空白都算“点空白”
        const onBlank = target.dataset.bg !== undefined || target === e.currentTarget;
        if (onBlank) {
          if (!dragMovedRef.current) {
            if (commentMode) openDraftAt(e.clientX, e.clientY);
            else onSelect(null);
          }
        }
      }}
    >
      <div
        className="artboard"
        data-bg="1"
        style={{ width: W, height: H, transform: `translate(${pan.x}px, ${pan.y}px)` }}
        ref={artboardRef}
        onMouseMove={onArtboardMouseMove}
        onMouseLeave={() => { if (frameEdgeHover) setFrameEdgeHover(false); }}
        onClick={(e) => {
          // 吸管模式下，点击未被图层热区 / 评论钉点覆盖的画板空白与图片区域，同样取色
          if (!eyedropper || dragMovedRef.current || spaceRef.current) return;
          pickColor(e.clientX, e.clientY);
        }}
      >
        {showImage && (
          /* 原图模式：直接用导入时保存的整板 PNG，与画板列表缩略图同源，完整还原设计稿 */
          <img
            className="artboard-img"
            data-render="image"
            data-bg="1"
            src={frame.thumb_url!}
            alt={frame.name}
            draggable={false}
            style={{ objectFit: 'fill' }}
          />
        )}
        {showVector && (
          /* 图层模式：按节点数据 CSS 近似渲染，仅用于查看图层颜色/文字（图片填充与矢量图标无法还原） */
          <div className="artboard-vector" data-render="nodes" aria-hidden="true">
            {nodes.map((n) => (
              <div
                key={n.node_id}
                data-node-id={n.node_id}
                data-layer-type={n.type}
                style={{ ...layerBoxStyle(n, zoom), ...(layerTextStyle(n, zoom) ?? {}) }}
              >
                {n.render_url ? (
                  <img
                    src={n.render_url}
                    alt={n.name}
                    draggable={false}
                    style={{
                      width: '100%', height: '100%', display: 'block',
                      objectFit: 'fill', pointerEvents: 'none',
                    }}
                  />
                ) : (
                  n.props?.text?.content ?? null
                )}
              </div>
            ))}
          </div>
        )}

        {/* 热区层：按数组顺序渲染，后渲染者在上层，天然符合 Figma z-order */}
        <div className="hotzones" style={{ width: W, height: H }}>
          {nodes.map((n) => (
            <div
              key={n.node_id}
              className="hotzone"
              data-node-id={n.node_id}
              data-layer-type={n.type}
              style={{ left: n.x * zoom, top: n.y * zoom, width: n.width * zoom, height: n.height * zoom }}
              onMouseEnter={() => onHover(n.node_id)}
              onMouseLeave={() => onHover(null)}
              onClick={(e) => {
                e.stopPropagation();
                if (dragMovedRef.current || spaceRef.current) return;
                // 吸管模式：点图层 = 取色，不选中
                if (eyedropper) {
                  pickColor(e.clientX, e.clientY);
                  return;
                }
                if (commentMode) {
                  // 锚定到图层：钉在图层右上角
                  setDraft({ x: n.x + n.width, y: n.y, nodeId: n.node_id });
                  setDraftBody('');
                } else {
                  onSelect(n.node_id);
                }
              }}
            />
          ))}
        </div>

        {/* 标注层：选中/悬停描边、尺寸徽标、间距 */}
        <svg className="overlay" width={W} height={H} style={{ pointerEvents: 'none' }}>
          {showHoverOutline && hoverOutline && (
            <rect
              data-outline="hover"
              data-outline-w={hoverOutline.w} data-outline-h={hoverOutline.h}
              x={hoverOutline.rect.x * zoom} y={hoverOutline.rect.y * zoom}
              width={hoverOutline.rect.w * zoom} height={hoverOutline.rect.h * zoom}
              fill="none" style={{ stroke: 'var(--measure)', strokeOpacity: 0.45 }} strokeWidth={lw}
            />
          )}
          {selectedOutline && (
            <rect
              data-outline="selected"
              data-outline-w={selectedOutline.w} data-outline-h={selectedOutline.h}
              x={selectedOutline.rect.x * zoom} y={selectedOutline.rect.y * zoom}
              width={selectedOutline.rect.w * zoom} height={selectedOutline.rect.h * zoom}
              fill="none" style={{ stroke: 'var(--measure)' }} strokeWidth={lw}
            />
          )}
          {/* 距离引线统一品牌色，不再出现粉红/白底两套颜色 */}
          {measures.map((m) => (
            <line
              key={`gap-${m.side}`}
              data-gap-line={m.side}
              x1={m.x1 * zoom} y1={m.y1 * zoom}
              x2={m.x2 * zoom} y2={m.y2 * zoom}
              style={{ stroke: 'var(--measure)' }} strokeWidth={lw}
              strokeDasharray={`${4 * lw} ${3 * lw}`}
            />
          ))}
          {/* 画板边缘测距引线：元素到画板上边（竖线）/ 左边（横线） */}
          {frameMeasures.map((m) => (
            <line
              key={`fgap-${m.side}`}
              data-frame-gap-line={m.side}
              x1={m.x1 * zoom} y1={m.y1 * zoom}
              x2={m.x2 * zoom} y2={m.y2 * zoom}
              style={{ stroke: 'var(--measure)' }} strokeWidth={lw}
              strokeDasharray={`${4 * lw} ${3 * lw}`}
            />
          ))}
        </svg>

        {/* 切图区域轻提示：极浅虚线细框常显（不遮挡、不弹字），hover/选中时另有完整品牌色描边与尺寸徽标 */}
        {sliceNodes.map((n) => (
          <div
            key={`slice-${n.node_id}`}
            className="slice-outline"
            data-slice-outline={n.node_id}
            title={`切图：${n.name} · ${Math.round(n.width)}×${Math.round(n.height)} ${unit ?? ''}`}
            style={{
              left: n.x * zoom, top: n.y * zoom,
              width: n.width * zoom, height: n.height * zoom,
            }}
          />
        ))}

        {/* 只显示一个真实切图尺寸：内部 Vector 路径的 bbox 不再单独标注，
            且选中状态下 hover 到别的图层也不再叠出第二个尺寸数字 */}
        {sizeTag && (
          <div className={`badge ${selected ? 'badge-selected' : 'badge-hover'}`} style={badgeStyle(sizeTag.rect)}>
            {Math.round(sizeTag.w)} × {Math.round(sizeTag.h)} {unit}
          </div>
        )}
        {/* 选中 A + hover B 时显示 A↔B 的距离：每方向一条引线 + 一个品牌色胶囊标签 */}
        {measures.map((m) => (
          <div
            key={`gapb-${m.side}`}
            className="badge badge-gap"
            data-gap-side={m.side}
            data-gap-peer={m.peerId ?? ''}
            style={{
              position: 'absolute',
              // 锚点贴「相邻元素」那一端，标签留在外侧；选中框正下方只留给尺寸徽标。
              // inset（包含关系）的引线两端分别是容器边与元素边，标签锚在线段中点居中。
              left: m.inset ? ((m.x1 + m.x2) / 2) * zoom
                : m.side === 'left' ? m.x1 * zoom - 4
                  : m.side === 'right' ? m.x2 * zoom + 4
                    : m.x1 * zoom,
              top: m.inset ? ((m.y1 + m.y2) / 2) * zoom
                : m.side === 'top' ? m.y1 * zoom - 4
                  : m.side === 'bottom' ? m.y2 * zoom + 4
                    : m.y1 * zoom,
              transform: m.inset ? 'translate(-50%, -50%)'
                : m.side === 'left' ? 'translate(-100%, -50%)'
                  : m.side === 'right' ? 'translate(0, -50%)'
                    : m.side === 'top' ? 'translate(-50%, -100%)'
                      : 'translate(-140%, -50%)',
              fontSize: fs,
              padding: '2px 6px',
              borderRadius: 999,
              whiteSpace: 'nowrap',
            }}
          >
            {Math.round(m.gap)} {unit}
          </div>
        ))}
        {/* 画板边缘测距标签：数值 = 元素到画板上边/左边的距离，锚在引线中点 */}
        {frameMeasures.map((m) => (
          <div
            key={`fgapb-${m.side}`}
            className="badge badge-gap"
            data-frame-gap={m.side}
            style={{
              position: 'absolute',
              left: ((m.x1 + m.x2) / 2) * zoom,
              top: ((m.y1 + m.y2) / 2) * zoom,
              transform: 'translate(-50%, -50%)',
              fontSize: fs,
              padding: '2px 6px',
              borderRadius: 999,
              whiteSpace: 'nowrap',
            }}
          >
            {Math.round(m.gap)} {unit}
          </div>
        ))}
        {/* 评论钉点 */}
        {comments
          .filter((c) => !c.parent_id && c.x !== null && c.y !== null)
          .map((c) => {
            const replies = comments.filter((r) => r.parent_id === c.id).length;
            return (
              <button
                key={c.id}
                className={`pin ${c.resolved ? 'pin-resolved' : ''}`}
                style={{ left: c.x! * zoom, top: c.y! * zoom }}
                title={`${c.author}：${c.body}`}
                onClick={(e) => {
                  e.stopPropagation();
                  // 吸管模式：点评论钉点也取色，不打开评论抽屉
                  if (eyedropper) {
                    pickColor(e.clientX, e.clientY);
                    return;
                  }
                  onOpenComment?.(c.id);
                }}
              >
                {c.resolved ? '✓' : c.author.slice(0, 1).toUpperCase()}
                {replies > 0 && <span className="pin-count">{replies}</span>}
              </button>
            );
          })}

        {/* 评论起草框 */}
        {commentMode && draft && (
          <div
            className="comment-composer"
            style={{ left: draft.x * zoom, top: draft.y * zoom }}
            onClick={(e) => e.stopPropagation()}
          >
            <textarea
              autoFocus
              placeholder={draft.nodeId ? `评论「${nodeById.get(draft.nodeId)?.name ?? '图层'}」…` : '输入评论…'}
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setDraft(null);
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submitDraft();
              }}
            />
            <div className="composer-actions">
              <button onClick={() => setDraft(null)}>取消</button>
              <button className="primary-btn" disabled={!draftBody.trim() || submitting} onClick={() => void submitDraft()}>
                {submitting ? '发送中…' : '发送'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 缩放控件 */}
      <div className="zoombar">
        <button onClick={() => zoomCenter(zoom / 1.25)} title="缩小" aria-label="缩小"><Minus /></button>
        <span className="zoom-value">{Math.round(zoom * 100)}%</span>
        <button onClick={() => zoomCenter(zoom * 1.25)} title="放大" aria-label="放大"><Plus /></button>
        <button onClick={fit} title="适应画布"><Maximize /><span>适应</span></button>
        <CanvasBgPicker token={canvasBg} onPick={pickCanvasBg} />
      </div>

      {/* 吸管：悬浮色值预览（跟随光标，不挡操作） */}
      {eyedropper && pickPreview && !picked && (
        <div
          className="eyedropper-preview"
          data-eyedropper-preview
          style={{ left: pickPreview.x + 16, top: pickPreview.y + 16 }}
        >
          <span className="eyedropper-swatch" style={{ background: pickPreview.hex }} />
          <span className="mono">{pickPreview.hex.toUpperCase()}</span>
          {pickPreview.isGradient && <span className="grad-hint">渐变</span>}
        </div>
      )}

      {/* 吸管：取色结果卡（当前点色 + 渐变色标 + 复制色号/CSS） */}
      {picked && (
        <div
          className="eyedropper-result"
          data-eyedropper-result
          style={{
            left: Math.min(Math.max(picked.x - 40, 8), (containerRef.current?.clientWidth ?? 800) - 360),
            top: Math.min(Math.max(picked.y + 18, 8), (containerRef.current?.clientHeight ?? 600) - 280),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="eyedropper-main">
            <span className="eyedropper-swatch swatch-lg" style={{ background: picked.hex }} />
            <div className="eyedropper-values">
              <span className="mono">{picked.hex.toUpperCase()}</span>
              <span className="dim mono">rgb({picked.rgb})</span>
            </div>
            <button className="eyedropper-copy" data-eyedropper-copy onClick={() => copyText(picked.hex.toUpperCase(), 'hex')}>
              {copyKey === 'hex' ? '已复制' : '复制 HEX'}
            </button>
          </div>

          {picked.gradient && (
            <div className="eyedropper-gradient" data-eyedropper-gradient>
              <div className="eyedropper-gradient-head">
                <span className="grad-badge">{picked.gradient.kind === 'radial' ? '径向渐变' : '线性渐变'}</span>
                <span className="dim">
                  {picked.gradient.angle !== null ? `${picked.gradient.angle}° · ` : ''}
                  {picked.gradient.source === 'layer' ? '图层定义' : `像素识别 R²=${picked.gradient.confidence}`}
                </span>
                {copyKey === 'auto' && <span className="grad-ok">已自动复制 CSS ✓</span>}
              </div>
              <div className="eyedropper-gradient-bar" style={{ background: picked.gradient.css }} />
              <div className="grad-stop-list">
                {picked.gradient.stops.map((s, i) => (
                  <button
                    key={i}
                    className="grad-copy-chip"
                    data-grad-stop={i}
                    title={`复制 ${s.cssValue}`}
                    onClick={() => copyText(s.cssValue, `stop-${i}`)}
                  >
                    <span className="grad-stop-dot" style={{ background: s.cssValue }} />
                    <span className="mono">{s.hex}</span>
                    <span className="dim">{Math.round(s.pos)}%</span>
                    {copyKey === `stop-${i}` && <span className="grad-ok">✓</span>}
                  </button>
                ))}
              </div>
              <div className="eyedropper-gradient-actions">
                <button data-copy-stops onClick={() => copyText(gradientHexList(picked.gradient!), 'stops')}>
                  {copyKey === 'stops' ? '已复制 ✓' : '复制色号'}
                </button>
                <button data-copy-css onClick={() => copyText(picked.gradient!.css, 'css')}>
                  {copyKey === 'css' ? '已复制 ✓' : '复制 CSS'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
