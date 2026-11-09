/**
 * 文本度量在不同导入通道里形态不一致：
 *  - Figma REST API / 早期导入：number（px）
 *  - Figma 插件 serializeNode：{ unit: 'PIXELS' | 'PERCENT', value: number }
 *
 * 插件把对象原样写进 props.text 后，属性面板曾用 `{t.letterSpacing}px` 直接渲染，
 * React 抛 "Objects are not valid as a React child (found: object with keys {unit, value})"
 * 导致点击文本图层整页白屏。这里统一转成 px 数值，任何输入都只返回 number 或 null。
 */
export function metricToPx(value: unknown, fontSize?: unknown): number | null {
  const size = typeof fontSize === 'number' && Number.isFinite(fontSize) ? fontSize : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value.replace(/px\s*$/i, '').trim());
    return Number.isFinite(n) ? n : null;
  }
  if (value && typeof value === 'object') {
    const o = value as { unit?: unknown; value?: unknown };
    const n = typeof o.value === 'number' ? o.value : Number(o.value);
    if (!Number.isFinite(n)) return null;
    const unit = String(o.unit ?? '').toUpperCase();
    // Figma 的 PERCENT 是相对字号的百分比；没有字号时无法换算，只能丢弃
    if (unit === 'PERCENT' || unit === '%') return size > 0 ? (n / 100) * size : null;
    return n; // PIXELS / AUTO / 未知单位：按 px 原值
  }
  return null;
}

/**
 * 任何未知形态的属性值都转成可安全渲染的字符串，绝不把对象交给 React。
 * 对象显示成紧凑 JSON 而不是崩溃；数组逐项处理。
 */
export function renderable(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(renderable).join(' / ');
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
