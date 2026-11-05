import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FrameDetail, LayerNode } from '../types';

interface Props {
  frame: FrameDetail['frame'];
  nodes: LayerNode[];
  selectedId: string | null;
  hoverId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onZoomChange: (z: number) => void;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

interface Rect {
  x: number; y: number; w: number; h: number;
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
  frame, nodes, selectedId, hoverId, onSelect, onHover, onZoomChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoomState] = useState(1);
  const zoomRef = useRef(1);
  const panRef = useRef<{ x: number; y: number } | null>(null);

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
  }, [frame.width, frame.height, setZoom]);

  // 首次加载自适应
  useEffect(() => {
    const t = setTimeout(fit, 50);
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
      el.scrollLeft = (el.scrollLeft + cx) * (next / old) - cx;
      el.scrollTop = (el.scrollTop + cy) * (next / old) - cy;
      setZoom(next);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [setZoom]);

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
      el.scrollLeft -= dx;
      el.scrollTop -= dy;
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
  const lw = 1 / zoom; // 视觉恒定 1px
  const fs = 11 / zoom;

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
      className="canvas-container"
      ref={containerRef}
      onPointerDown={onPointerDown}
      onMouseDown={(e) => {
        // 点击空白取消选中（拖拽后不触发）
        if ((e.target as HTMLElement).dataset.bg !== undefined) {
          if (!dragMovedRef.current) onSelect(null);
        }
      }}
    >
      <div className="artboard" data-bg="1" style={{ width: W, height: H }}>
        {frame.thumb_url && (
          <img className="artboard-img" data-bg="1" src={frame.thumb_url} alt={frame.name} draggable={false} />
        )}

        {/* 热区层：按数组顺序渲染，后渲染者在上层，天然符合 Figma z-order */}
        <div className="hotzones" style={{ width: W, height: H }}>
          {nodes.map((n) => (
            <div
              key={n.node_id}
              className="hotzone"
              style={{ left: n.x * zoom, top: n.y * zoom, width: n.width * zoom, height: n.height * zoom }}
              onMouseEnter={() => onHover(n.node_id)}
              onMouseLeave={() => onHover(null)}
              onClick={(e) => {
                e.stopPropagation();
                if (!dragMovedRef.current) onSelect(n.node_id);
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
              fill="none" stroke="#f24822" strokeWidth={lw}
            />
          )}
          {selected && (
            <rect
              x={selected.x * zoom} y={selected.y * zoom}
              width={selected.width * zoom} height={selected.height * zoom}
              fill="none" stroke="#0d99ff" strokeWidth={lw}
            />
          )}
          {gap && (
            <line
              x1={gap.x1 * zoom} y1={gap.y1 * zoom}
              x2={gap.x2 * zoom} y2={gap.y2 * zoom}
              stroke="#f531b3" strokeWidth={lw} strokeDasharray={`${4 * lw} ${3 * lw}`}
            />
          )}
        </svg>

        {hovered && hovered !== selected && (
          <div className="badge badge-hover" style={badgeStyle(fmt(hovered))}>
            {Math.round(hovered.width)} × {Math.round(hovered.height)}
          </div>
        )}
        {selected && (
          <div className="badge badge-selected" style={badgeStyle(fmt(selected))}>
            {Math.round(selected.width)} × {Math.round(selected.height)}
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
            {Math.round(gap.gap)}
          </div>
        )}
      </div>

      {/* 缩放控件 */}
      <div className="zoombar">
        <button onClick={() => setZoom(zoom / 1.25)} title="缩小">−</button>
        <span className="zoom-value">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(zoom * 1.25)} title="放大">+</button>
        <button onClick={fit} title="适应画布">适应</button>
      </div>
    </div>
  );
}
