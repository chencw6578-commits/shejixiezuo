import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MoreHorizontal } from './icons';

export interface RowMenuItem {
  label: string;
  danger?: boolean;
  onClick: () => void;
}

/**
 * 侧栏行右侧的「更多」按钮：点开一个轻量菜单，外部点击或 Esc 关闭。
 * 使用 fixed 定位，避免被列表的 overflow 裁切。
 */
export default function RowMenu({
  label,
  items,
  className = '',
}: {
  label: string;
  items: RowMenuItem[];
  className?: string;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (popRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  // 菜单宽度固定 168：按钮贴右侧时左移，底部空间不足时上翻
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const h = 8 + items.length * 34;
    const left = Math.max(8, Math.min(r.right - 168, window.innerWidth - 176));
    const top = r.bottom + 4 + h > window.innerHeight ? r.top - 4 - h : r.bottom + 4;
    setPos({ left, top });
    popRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [open, items.length]);

  return (
    <span className={`row-menu ${className}`}>
      <button
        ref={btnRef}
        type="button"
        className="row-menu-btn"
        title={`更多操作：${label}`}
        aria-label={`更多操作：${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <MoreHorizontal />
      </button>
      {open && pos && (
        <div
          ref={popRef}
          className="row-menu-pop"
          role="menu"
          aria-label={label}
          style={{ left: pos.left, top: pos.top }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={`row-menu-item ${it.danger ? 'is-danger' : ''}`}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
