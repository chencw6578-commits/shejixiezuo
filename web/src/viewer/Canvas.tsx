import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FrameDetail, LayerNode } from '../types';
import type { CommentItem } from '../api';
import type { Unit } from '../unit';
import { canvasBgStyle, useCanvasBg } from '../canvasBg';
import CanvasBgPicker from '../components/CanvasBgPicker';
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
  const align = (t.alignHorizontal ?? 'LEFT').toUpperCase();
  return {
    fontFamily: t.family
      ? `"${t.family}", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`
      : undefined,
    fontSize: (t.size ?? 12) * zoom,
    fontWeight: t.weight ?? 400,
    lineHeight: t.lineHeight ? `${t.lineHeight * zoom}px` : undefined,
    letterSpacing: t.letterSpacing ? `${t.letterSpacing * zoom}px` : undefined,
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

/** 计算两个矩形的标注间距（仅在另一轴有重叠时），返回线段与数值。 */
function gapBetween(a: Rect, b: Rect): { dir: 'h' | 'v'; gap: number; x1: number; y1: number; x2: number; y2: number } | null {
  const vOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const hOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  if (vOverlap > 0 && (b.x + b.w <= a.x || b.x >= a.x + a.w)) {
    if (b.x + b.w <= a.x) {
      return { dir: 'h', gap: a.x - (b.x + b.w), x1: b.x + b.w, x2: a.x, y1: Math.max(a.y, b.y) + vOverlap / 2, y2: 0 };
    }
    return { dir: 'h', gap: b.x - (a.x + a.w), x1: a.x + a.w, x2: b.x, y1: Math.max(a.y, b.y) + vOverlap / 2, y2: 0 };
  }
  if (hOverlap > 0 && (b.y + b.h <= a.y || b.y >= a.y + a.h)) {
    const midX = Math.max(a.x, b.x) + hOverlap / 2;
    if (b.y + b.h <= a.y) {
      return { dir: 'v', gap: a.y - (b.y + b.h), x1: midX, y1: b.y + b.h, x2: 0, y2: a.y };
    }
    return { dir: 'v', gap: b.y - (a.y + a.h), x1: midX, y1: a.y + a.h, x2: 0, y2: b.y };
  }
  return null;
}

export default function Canvas({
  frame, nodes, selectedId, hoverId, onSelect, onHover, onZoomChange, unit = 'px',
  comments = [], commentMode = false, onAddComment, onOpenComment,
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
  const dragMovedRef = useRef(false);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    panRef.current = { x: e.clientX, y: e.clientY };
    dragMovedRef.current = false;
  };
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
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
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointerleave', up);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointerleave', up);
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
  const fmt = useCallback(
    (a: LayerNode): Rect => ({ x: a.x, y: a.y, w: a.width, h: a.height }),
    []
  );
  const gap = useMemo(
    () =>
      selected && hovered && selected !== hovered
        ? gapBetween(fmt(selected), fmt(hovered))
        : null,
    [selected, hovered, fmt]
  );

  const W = frame.width * zoom;
  const H = frame.height * zoom;
  // 有节点数据 → 节点矢量渲染；否则回退到位图 + 热区（两条路径共用同一套热区命中逻辑）
  const hasNodes = nodes.length > 0;
  const lw = 1 / zoom; // 视觉恒定 1px
  const fs = 11 / zoom;

  // 选中「元素」时：它到父容器四边的距离；父级无边界（顶层节点）时以画板为基准
  const padLines = useMemo(() => {
    if (!selected || !hasNodes) return [];
    const p = selected.parent_id ? nodeById.get(selected.parent_id) : undefined;
    const pr = p
      ? { x: p.x, y: p.y, w: p.width, h: p.height }
      : { x: 0, y: 0, w: frame.width, h: frame.height };
    if (pr.w <= 0 || pr.h <= 0) return [];
    const sides = {
      left: selected.x - pr.x,
      right: pr.x + pr.w - (selected.x + selected.width),
      top: selected.y - pr.y,
      bottom: pr.y + pr.h - (selected.y + selected.height),
    };
    // 出现负值/0 说明父级与元素关系不成立，不画错误数值
    if (Object.values(sides).some((v) => v < 1)) return [];
    const cy = selected.y + selected.height / 2;
    const cx = selected.x + selected.width / 2;
    return [
      { x1: pr.x, y1: cy, x2: selected.x, y2: cy, value: sides.left },
      { x1: selected.x + selected.width, y1: cy, x2: pr.x + pr.w, y2: cy, value: sides.right },
      { x1: cx, y1: pr.y, x2: cx, y2: selected.y, value: sides.top },
      { x1: cx, y1: selected.y + selected.height, x2: cx, y2: pr.y + pr.h, value: sides.bottom },
    ];
  }, [selected, hasNodes, nodeById, frame.width, frame.height]);


  const badgeStyle = (r: Rect): React.CSSProperties => {
    const below = r.y + r.h + 20 / zoom <= frame.height;
    return {
      position: 'absolute',
      left: r.x * zoom + (r.w * zoom) / 2,
      top: below ? r.y * zoom + r.h * zoom + 6 / zoom : r.y * zoom - 6 / zoom,
      transform: `translate(-50%, ${below ? '0%' : '-100%'})`,
      fontSize: fs,
      padding: `${2 / zoom}px ${5 / zoom}px`,
      borderRadius: 2 / zoom,
      whiteSpace: 'nowrap',
    };
  };

  return (
    <div
      className={`canvas-container${spacePan ? ' space-pan' : ''} ${bg.className}`}
      ref={containerRef}
      style={bg.style}
      onPointerDown={onPointerDown}
      onMouseDown={(e) => {
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
      >
        {hasNodes ? (
          /* 有节点数据：直接按节点渲染矢量视图，像素位置/颜色与属性面板同源 */
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
        ) : (
          /* 无节点数据（纯截图/位图导入）：保留位图底图 + 热区 */
          frame.thumb_url && (
            <img className="artboard-img" data-bg="1" src={frame.thumb_url} alt={frame.name} draggable={false} />
          )
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
          {hovered && hovered !== selected && (
            <rect
              x={hovered.x * zoom} y={hovered.y * zoom}
              width={hovered.width * zoom} height={hovered.height * zoom}
              fill="none" stroke="rgba(108, 76, 241, 0.45)" strokeWidth={lw}
            />
          )}
          {selected && (
            <rect
              x={selected.x * zoom} y={selected.y * zoom}
              width={selected.width * zoom} height={selected.height * zoom}
              fill="none" stroke="#6c4cf1" strokeWidth={lw}
            />
          )}
          {gap && (
            <line
              x1={gap.x1 * zoom} y1={gap.y1 * zoom}
              x2={gap.x2 * zoom} y2={gap.y2 * zoom}
              stroke="#6c4cf1" strokeWidth={lw} strokeDasharray={`${4 * lw} ${3 * lw}`}
            />
          )}
          {padLines.map((l, i) => (
            <line
              key={`pad-${i}`}
              x1={l.x1 * zoom} y1={l.y1 * zoom} x2={l.x2 * zoom} y2={l.y2 * zoom}
              stroke="#6c4cf1" strokeWidth={lw}
            />
          ))}
        </svg>

        {hovered && hovered !== selected && (
          <div className="badge badge-hover" style={badgeStyle(fmt(hovered))}>
            {Math.round(hovered.width)} × {Math.round(hovered.height)} {unit}
          </div>
        )}
        {selected && (
          <div className="badge badge-selected" style={badgeStyle(fmt(selected))}>
            {Math.round(selected.width)} × {Math.round(selected.height)} {unit}
          </div>
        )}
        {gap && (
          <div
            className="badge badge-gap"
            style={{
              position: 'absolute',
              left: gap.dir === 'h' ? ((gap.x1 + gap.x2) / 2) * zoom : gap.x1 * zoom,
              top: gap.dir === 'h' ? gap.y1 * zoom : ((gap.y1 + gap.y2) / 2) * zoom,
              transform: gap.dir === 'h' ? 'translate(-50%, -130%)' : 'translate(-130%, -50%)',
              fontSize: fs,
              padding: `${2 / zoom}px ${5 / zoom}px`,
              borderRadius: 2 / zoom,
              whiteSpace: 'nowrap',
            }}
          >
            {Math.round(gap.gap)} {unit}
          </div>
        )}
        {/* 选中元素到父容器四边的距离（白底小标签，缩放时数值随之换算） */}
        {padLines.map((l, i) => (
          <div
            key={`padb-${i}`}
            className="badge badge-pad"
            style={{
              position: 'absolute',
              left: ((l.x1 + l.x2) / 2) * zoom,
              top: ((l.y1 + l.y2) / 2) * zoom,
              transform: 'translate(-50%, -50%)',
              fontSize: fs,
              padding: `${1 / zoom}px ${4 / zoom}px`,
              borderRadius: 2 / zoom,
              whiteSpace: 'nowrap',
            }}
          >
            {Math.round(l.value)} {unit}
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
    </div>
  );
}
