import { useState } from 'react';

/** 画布底色预设（按用户维度记忆，跨项目共用） */
export const CANVAS_BG_PRESETS = [
  { id: 'white', label: '白', color: '#ffffff' },
  { id: 'light', label: '浅灰', color: '#f4f5f7' },
  { id: 'gray', label: '深灰', color: '#3c4048' },
  { id: 'black', label: '黑', color: '#111318' },
];

const KEY = 'designhub-canvas-bg';
const DEFAULT_TOKEN = 'light';

export function readCanvasBg(): string {
  try {
    const v = localStorage.getItem(KEY);
    return v || DEFAULT_TOKEN;
  } catch {
    return DEFAULT_TOKEN;
  }
}

export function saveCanvasBg(token: string) {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    /* 隐私模式下忽略 */
  }
}

/** token → 实际色值（支持自定义 #rrggbb） */
export function canvasBgColor(token: string): string {
  const preset = CANVAS_BG_PRESETS.find((p) => p.id === token);
  if (preset) return preset.color;
  if (/^#[0-9a-f]{6}$/i.test(token)) return token;
  return '#f4f5f7';
}

/** 是否为深色底（决定画板描边、标签文字颜色） */
export function isDarkCanvas(hex: string): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 < 140;
}

/** 画布底色偏好（localStorage，按用户） */
export function useCanvasBg(): [string, (token: string) => void] {
  const [token, setToken] = useState<string>(() => readCanvasBg());
  const pick = (next: string) => {
    saveCanvasBg(next);
    setToken(next);
  };
  return [token, pick];
}

/** 画布容器需要的 CSS 变量与类名 */
export function canvasBgStyle(token: string) {
  const color = canvasBgColor(token);
  const dark = isDarkCanvas(color);
  return {
    color,
    dark,
    className: dark ? 'is-dark-canvas' : '',
    style: { '--canvas-bg': color } as Record<string, string>,
  };
}
