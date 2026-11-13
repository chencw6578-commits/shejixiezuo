/**
 * 渐变识别与色号提取，供吸管取色 / 属性面板 / 设计规范页共用。
 *
 * 两条识别路径，结果里用 source 明确区分，避免把推测当成设计稿原始数据：
 *  - layer：解析导入时由 parse.ts / sketch 生成的 CSS 渐变（Figma 图层定义，权威）
 *  - pixel：整板图局部像素做主成分 + 线性平面拟合（通用图像算法，用于无图层渐变数据时兜底）
 */

export interface GradientStop {
  /** 标准 6 位大写色号；含透明度时仍是去掉 alpha 的 RGB 值 */
  hex: string;
  /** 可直接粘进 CSS 的色值；alpha < 1 时保留 rgba(...) */
  cssValue: string;
  /** 色标位置 0–100 */
  pos: number;
  alpha: number;
}

export interface GradientInfo {
  kind: 'linear' | 'radial';
  /** CSS 角度；radial 为 null */
  angle: number | null;
  prefix: string;
  stops: GradientStop[];
  /** 规范化后的整段 CSS，用于一键复制 */
  css: string;
  source: 'layer' | 'pixel';
  /** 像素识别的线性拟合优度 R²，图层数据为 1 */
  confidence: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fmt = (v: number) => String(Math.round(v * 10) / 10);
const toHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase();

/** 按括号深度切分顶层逗号，避免把 rgba(...) 里的逗号当成参数分隔 */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

interface ColorValue {
  hex: string;
  cssValue: string;
  alpha: number;
}

/** 兼容 #rgb / #rrggbb / #rrggbbaa / rgb() / rgba()（含 0-1 小数与百分比写法） */
export function parseColorValue(raw: string): ColorValue | null {
  const s = raw.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { hex: toHex(r, g, b), cssValue: alpha < 1 ? `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 100) / 100})` : toHex(r, g, b), alpha };
  }
  m = /^rgba?\(([^)]*)\)$/i.exec(s);
  if (m) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const num = (v: string) => {
      if (v.endsWith('%')) return (parseFloat(v) / 100) * 255;
      const n = parseFloat(v);
      return n > 0 && n < 1 ? n * 255 : n; // 0–1 归一化的旧数据
    };
    const [r, g, b] = parts.slice(0, 3).map(num);
    if (![r, g, b].every(Number.isFinite)) return null;
    const a = parts.length > 3 ? parseFloat(parts[3]) : 1;
    const alpha = Number.isFinite(a) ? (a > 1 ? a / 100 : a) : 1;
    return {
      hex: toHex(r, g, b),
      cssValue: alpha < 1 ? `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round(alpha * 100) / 100})` : toHex(r, g, b),
      alpha,
    };
  }
  return null;
}

function parseAngle(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  let m = /^(-?[\d.]+)deg$/.exec(s);
  if (m) return (parseFloat(m[1]) % 360 + 360) % 360;
  m = /^(-?[\d.]+)turn$/.exec(s);
  if (m) return (parseFloat(m[1]) * 360 % 360 + 360) % 360;
  const dirs: Record<string, number> = {
    'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270,
    'to top right': 45, 'to right top': 45, 'to bottom right': 135, 'to right bottom': 135,
    'to bottom left': 225, 'to left bottom': 225, 'to top left': 315, 'to left top': 315,
  };
  return s in dirs ? dirs[s] : null;
}

/** 解析导入数据里的 linear-gradient() / radial-gradient() 字符串 */
export function parseGradientCss(css: string | null | undefined): GradientInfo | null {
  if (typeof css !== 'string') return null;
  const m = /^(linear|radial)-gradient\(([\s\S]*)\)$/i.exec(css.trim());
  if (!m) return null;
  const kind = m[1].toLowerCase() === 'radial' ? 'radial' : 'linear';
  const args = splitTopLevel(m[2]);
  if (!args.length) return null;

  let prefix = '';
  let angle: number | null = null;
  let start = 0;
  const first = args[0].toLowerCase();
  if (kind === 'linear' && (parseAngle(args[0]) !== null || /^(to|left|right|top|bottom)/.test(first))) {
    angle = parseAngle(args[0]);
    prefix = angle !== null ? `${fmt(angle)}deg` : args[0];
    start = 1;
  } else if (kind === 'radial' && /^(circle|ellipse|closest|farthest|at)/.test(first)) {
    prefix = args[0];
    start = 1;
  }
  const raw = args.slice(start);
  if (!raw.length) return null;

  const autoPos = (i: number) => (raw.length === 1 ? 0 : (i / (raw.length - 1)) * 100);
  const stops: GradientStop[] = [];
  for (let i = 0; i < raw.length; i++) {
    const sm = /^(.*?)\s+(-?[\d.]+)%$/.exec(raw[i]);
    const colorRaw = sm ? sm[1] : raw[i];
    const color = parseColorValue(colorRaw);
    if (!color) return null;
    stops.push({ ...color, pos: sm ? clamp(parseFloat(sm[2]), 0, 100) : autoPos(i) });
  }
  stops.sort((a, b) => a.pos - b.pos);
  return { kind, angle, prefix, stops, css: buildGradientCss(kind, prefix, stops), source: 'layer', confidence: 1 };
}

export function buildGradientCss(kind: 'linear' | 'radial', prefix: string, stops: GradientStop[]): string {
  const body = stops.map((s) => `${s.cssValue} ${fmt(s.pos)}%`).join(', ');
  return `${kind}-gradient(${prefix ? `${prefix}, ` : ''}${body})`;
}

/** 「复制色号」用的纯色号列表 */
export function gradientHexList(info: GradientInfo): string {
  return [...new Set(info.stops.map((s) => s.hex))].join(', ');
}

interface Pixel {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
}

/**
 * 局部像素渐变识别：
 * 1) 颜色协方差主成分 u，把 RGB 投影成标量场 s；
 * 2) 对 s 做平面最小二乘拟合 s ≈ α + βx·x + βy·y，用 R² 判断是否平滑过渡（可排除图片纹理 / 边缘）；
 * 3) 拟合梯度方向换算 CSS 角度，按 s 分箱提取色标（能识别多色标渐变）。
 * 返回 null 表示「看不出渐变」，绝不硬凑结果。
 */
export function analyzeGradientPixels(
  ctx: CanvasRenderingContext2D,
  imgW: number,
  imgH: number,
  cx: number,
  cy: number,
  radius = 20,
): GradientInfo | null {
  const x0 = clamp(Math.round(cx) - radius, 0, imgW - 1);
  const y0 = clamp(Math.round(cy) - radius, 0, imgH - 1);
  const w = Math.min(2 * radius + 1, imgW - x0);
  const h = Math.min(2 * radius + 1, imgH - y0);
  if (w < 12 || h < 12) return null;

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(x0, y0, w, h).data;
  } catch {
    return null; // 跨域图片 etc.
  }
  const px: Pixel[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 200) continue; // 透明像素不参与
      px.push({ x, y, r: data[i], g: data[i + 1], b: data[i + 2] });
    }
  }
  if (px.length < w * h * 0.75) return null;

  const n = px.length;
  const mr = px.reduce((a, p) => a + p.r, 0) / n;
  const mg = px.reduce((a, p) => a + p.g, 0) / n;
  const mb = px.reduce((a, p) => a + p.b, 0) / n;
  // 3×3 协方差 + 幂迭代求主特征向量
  let cr = 0, cg = 0, cb = 0, rr = 0, rg = 0, rb = 0, gg = 0, gb = 0, bb = 0;
  for (const p of px) {
    const r = p.r - mr, g = p.g - mg, b = p.b - mb;
    cr += r; cg += g; cb += b;
    rr += r * r; rg += r * g; rb += r * b; gg += g * g; gb += g * b; bb += b * b;
  }
  let ux = 1, uy = 0, uz = 0;
  for (let k = 0; k < 12; k++) {
    const vx = rr * ux + rg * uy + rb * uz;
    const vy = rg * ux + gg * uy + gb * uz;
    const vz = rb * ux + gb * uy + bb * uz;
    const len = Math.hypot(vx, vy, vz) || 1;
    ux = vx / len; uy = vy / len; uz = vz / len;
  }
  const s = px.map((p) => (p.r - mr) * ux + (p.g - mg) * uy + (p.b - mb) * uz);
  const smin = Math.min(...s), smax = Math.max(...s);
  if (smax - smin < 14) return null; // 颜色几乎没变化 = 纯色

  const mx = px.reduce((a, p) => a + p.x, 0) / n;
  const my = px.reduce((a, p) => a + p.y, 0) / n;
  const ms = s.reduce((a, v) => a + v, 0) / n;
  let Sxx = 0, Syy = 0, Sxy = 0, Sxs = 0, Sys = 0;
  for (let i = 0; i < n; i++) {
    const X = px[i].x - mx, Y = px[i].y - my, S = s[i] - ms;
    Sxx += X * X; Syy += Y * Y; Sxy += X * Y; Sxs += X * S; Sys += Y * S;
  }
  const det = Sxx * Syy - Sxy * Sxy;
  if (Math.abs(det) < 1e-9) return null;
  const bx = (Sxs * Syy - Sys * Sxy) / det;
  const by = (Sys * Sxx - Sxs * Sxy) / det;
  let sse = 0, sst = 0;
  for (let i = 0; i < n; i++) {
    const pred = ms + bx * (px[i].x - mx) + by * (px[i].y - my);
    sse += (s[i] - pred) ** 2;
    sst += (s[i] - ms) ** 2;
  }
  const r2 = sst > 0 ? 1 - sse / sst : 0;
  if (r2 < 0.82) return null; // 不是平滑线性过渡（纹理 / 文字 / 硬边）

  // CSS 角度：渐变从 s 低处指向高处，方向向量 (bx, by)；CSS 0deg 朝上、顺时针
  const angle = Math.round(((Math.atan2(bx, -by) * 180) / Math.PI + 360) % 360 * 10) / 10;
  const hexToRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

  // 沿渐变方向把取样线延伸到整段渐变的边界：局部小窗口只能看到中间色，
  // 拿不到设计稿真正的起止色号。边界判定 = 连续 20px 颜色几乎不变 / 出现硬跳变。
  const EXT = 360;
  const rad = (angle * Math.PI) / 180;
  const dirX = Math.sin(rad), dirY = -Math.cos(rad);
  const bx0 = Math.round(cx) - EXT, by0 = Math.round(cy) - EXT;
  const BW = 2 * EXT + 1;
  interface LinePoint { t: number; r: number; g: number; b: number; s: number }
  const line: LinePoint[] = [];
  try {
    const big = ctx.getImageData(bx0, by0, BW, BW).data;
    for (let t = -EXT; t <= EXT; t += 2) {
      const ix = Math.round(cx + dirX * t) - bx0;
      const iy = Math.round(cy + dirY * t) - by0;
      if (ix < 0 || iy < 0 || ix >= BW || iy >= BW) continue;
      const i = (iy * BW + ix) * 4;
      if (big[i + 3] < 200) continue;
      const r = big[i], g = big[i + 1], b = big[i + 2];
      line.push({ t, r, g, b, s: (r - mr) * ux + (g - mg) * uy + (b - mb) * uz });
    }
  } catch { /* 扩展取样不可用时回退局部窗口 */ }

  const byT = new Map(line.map((p) => [p.t, p]));
  const edge = (sign: 1 | -1) => {
    let last = byT.get(0);
    if (!last) return 0;
    let tEnd = 0;
    const win: number[] = [];
    for (let k = 1; k <= EXT / 2; k++) {
      const cur = byT.get(sign * k * 2);
      if (!cur) break;
      const jump = Math.hypot(cur.r - last.r, cur.g - last.g, cur.b - last.b);
      if (jump > 45) break; // 进入另一个元素
      // 用 RGB 变化量而非主成分投影：多色标渐变的后半段颜色方向可能与前半段几乎正交
      win.push(jump);
      if (win.length > 10) win.shift();
      if (win.length === 10 && win.reduce((a, b) => a + b, 0) < 3) break; // 连续 20px 无变化 = 到边界
      tEnd = sign * k * 2;
      last = cur;
    }
    return tEnd;
  };
  const t0 = edge(-1), t1 = edge(1);
  const span = t1 - t0;
  const avgLine = (a: number, b: number) => {
    const seg = line.filter((p) => p.t >= a && p.t <= b);
    const len = seg.length || 1;
    return toHex(
      seg.reduce((v, p) => v + p.r, 0) / len,
      seg.reduce((v, p) => v + p.g, 0) / len,
      seg.reduce((v, p) => v + p.b, 0) / len,
    );
  };

  let stopCss: GradientStop[];
  let finalAngle = angle;
  if (span >= 40 && line.length > 20) {
    const A = avgLine(t0, t0 + 8);
    const B = avgLine(t1 - 8, t1);
    const [ar, ag, ab] = hexToRgb(A);
    const [br, bg, bb2] = hexToRgb(B);
    if ((byT.get(t1)?.s ?? 0) < (byT.get(t0)?.s ?? 0)) finalAngle = (angle + 180) % 360;
    stopCss = [{ hex: A, cssValue: A, pos: 0, alpha: 1 }];
    // 只保留偏离两端直线最明显的 1–2 个拐点，避免把平滑过渡拆成一串近似色号
    const bends: { hex: string; pos: number; dev: number }[] = [];
    for (let i = 1; i < 5; i++) {
      const u = i / 5;
      const mid = t0 + span * u;
      const C = avgLine(mid - span / 12, mid + span / 12);
      const [cr2, cg2, cb2] = hexToRgb(C);
      const dev = Math.hypot(cr2 - (ar + (br - ar) * u), cg2 - (ag + (bg - ag) * u), cb2 - (ab + (bb2 - ab) * u));
      if (dev > 12) bends.push({ hex: C, pos: Math.round(u * 1000) / 10, dev });
    }
    bends.sort((a, b) => b.dev - a.dev);
    bends.slice(0, 2).sort((a, b) => a.pos - b.pos).forEach((m) =>
      stopCss.push({ hex: m.hex, cssValue: m.hex, pos: m.pos, alpha: 1 }));
    stopCss.push({ hex: B, cssValue: B, pos: 100, alpha: 1 });
  } else {
    // 扩展失败（渐变段太短 / 取样不足）：退回局部窗口分箱，保证不误报纯色
    const order = px.map((p, i) => ({ p, v: s[i] })).sort((a, b) => a.v - b.v);
    const avgColor = (from: number, to: number) => {
      const seg = order.slice(from, to);
      const len = seg.length || 1;
      return toHex(
        seg.reduce((v, o) => v + o.p.r, 0) / len,
        seg.reduce((v, o) => v + o.p.g, 0) / len,
        seg.reduce((v, o) => v + o.p.b, 0) / len,
      );
    };
    const bins = 6;
    const binsColor = Array.from({ length: bins }, (_, i) =>
      avgColor(Math.floor((i * n) / bins), Math.floor(((i + 1) * n) / bins)));
    const A = binsColor[0], B = binsColor[bins - 1];
    const [ar, ag, ab] = hexToRgb(A);
    const [br, bg, bb2] = hexToRgb(B);
    stopCss = [{ hex: A, cssValue: A, pos: 0, alpha: 1 }];
    for (let i = 1; i < bins - 1; i++) {
      const u = i / (bins - 1);
      const [cr2, cg2, cb2] = hexToRgb(binsColor[i]);
      const dev = Math.hypot(cr2 - (ar + (br - ar) * u), cg2 - (ag + (bg - ag) * u), cb2 - (ab + (bb2 - ab) * u));
      if (dev > 12 && stopCss.length < 4) {
        stopCss.push({ hex: binsColor[i], cssValue: binsColor[i], pos: Math.round(u * 1000) / 10, alpha: 1 });
      }
    }
    stopCss.push({ hex: B, cssValue: B, pos: 100, alpha: 1 });
  }
  const prefix = `${fmt(finalAngle)}deg`;
  return {
    kind: 'linear', angle: finalAngle, prefix,
    stops: stopCss,
    css: buildGradientCss('linear', prefix, stopCss),
    source: 'pixel', confidence: Math.round(r2 * 1000) / 1000,
  };
}
