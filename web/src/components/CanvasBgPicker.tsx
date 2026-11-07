import { useEffect, useRef, useState } from 'react';
import { CANVAS_BG_PRESETS, canvasBgColor } from '../canvasBg';
import { Palette } from './icons';

/** 画布底色切换：4 个预设 + 一个原生取色入口（只换画布背景，不改画板内容） */
export default function CanvasBgPicker({
  token,
  onPick,
}: {
  token: string;
  onPick: (token: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState(canvasBgColor(token));
  const rootRef = useRef<HTMLDivElement>(null);
  const current = canvasBgColor(token);

  // 面板外点击关闭 / Esc 关闭（捕获阶段监听，避免被画布的 pointerdown 逻辑干扰）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  useEffect(() => setHex(current), [current]);

  const commitHex = () => {
    const v = hex.trim();
    if (/^#?[0-9a-f]{6}$/i.test(v)) onPick(v.startsWith('#') ? v.toLowerCase() : `#${v.toLowerCase()}`);
    else setHex(current);
  };

  return (
    <div className="canvas-bg-picker" ref={rootRef}>
      <button
        type="button"
        className={`canvas-bg-btn ${open ? 'is-active' : ''}`}
        title={`画布底色（当前 ${current}）`}
        aria-label="画布底色"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Palette />
      </button>
      {open && (
        <div className="canvas-bg-pop" role="dialog" aria-label="画布底色">
          <div className="canvas-bg-swatches">
            {CANVAS_BG_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`canvas-bg-swatch ${current === p.color ? 'is-active' : ''}`}
                style={{ background: p.color }}
                title={p.label}
                aria-label={`画布底色 ${p.label}`}
                data-bg={p.id}
                onClick={() => onPick(p.id)}
              />
            ))}
          </div>
          <div className="canvas-bg-custom">
            <input
              type="color"
              value={current}
              aria-label="自定义画布底色"
              onChange={(e) => onPick(e.target.value.toLowerCase())}
            />
            <input
              className="canvas-bg-hex"
              value={hex}
              aria-label="自定义十六进制色值"
              placeholder="#ffffff"
              spellCheck={false}
              onChange={(e) => setHex(e.target.value)}
              onBlur={commitHex}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitHex();
                }
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
