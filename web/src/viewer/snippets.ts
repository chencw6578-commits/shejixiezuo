import type { LayerNode } from '../types';

export type SnippetLang = 'CSS' | 'React' | 'Swift' | 'Android';

export const SNIPPET_LANGS: SnippetLang[] = ['CSS', 'React', 'Swift', 'Android'];

function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255];
}

const px = (n: number) => `${Math.round(n * 100) / 100}px`;

function baseParts(node: LayerNode) {
  // 旧数据（种子/Figma 早期导入）的 props 可能缺数组字段，这里统一兜底
  const p = {
    ...node.props,
    fills: node.props.fills ?? [],
    strokes: node.props.strokes ?? [],
    effects: node.props.effects ?? [],
    exportPresets: node.props.exportPresets ?? [],
  };
  const fill = p.fills.find((f) => f.visible && (f.type === 'solid' || f.type === 'gradient'));
  const stroke = p.strokes.find((s) => s.visible && s.color);
  return { p, fill, stroke };
}

function cssDecls(node: LayerNode): string[] {
  const { p, fill, stroke } = baseParts(node);
  const out = [
    `position: absolute;`,
    `left: ${px(node.x)};`,
    `top: ${px(node.y)};`,
    `width: ${px(node.width)};`,
    `height: ${px(node.height)};`,
  ];
  if (p.cornerRadius) out.push(`border-radius: ${px(p.cornerRadius)};`);
  if (fill?.css) out.push(`background: ${fill.css};`);
  else if (fill?.type === 'image') out.push(`background: url(<图像填充>) center / cover no-repeat;`);
  if (p.opacity < 1) out.push(`opacity: ${p.opacity};`);
  if (stroke?.color && p.strokeWeight) out.push(`border: ${px(p.strokeWeight)} solid ${stroke.color.hex};`);
  const shadows = p.effects.filter((e) => e.css);
  if (shadows.length) out.push(`box-shadow: ${shadows.map((e) => e.css).join(', ')};`);
  const t = p.text;
  if (t) {
    if (t.family) out.push(`font-family: '${t.family}', sans-serif;`);
    if (t.size) out.push(`font-size: ${px(t.size)};`);
    if (t.weight && t.weight !== 400) out.push(`font-weight: ${t.weight};`);
    if (t.lineHeight) out.push(`line-height: ${px(t.lineHeight)};`);
    if (t.letterSpacing) out.push(`letter-spacing: ${px(t.letterSpacing)};`);
    if (t.color) out.push(`color: ${t.color.hex};`);
    if (t.alignHorizontal && t.alignHorizontal !== 'LEFT') out.push(`text-align: ${t.alignHorizontal.toLowerCase()};`);
    out.push(`white-space: pre-wrap;`);
  }
  return out;
}

function reactStyle(node: LayerNode): string[] {
  const { p, fill, stroke } = baseParts(node);
  const num = (n: number) => Math.round(n * 100) / 100;
  const out = [`position: 'absolute',`, `left: ${num(node.x)},`, `top: ${num(node.y)},`, `width: ${num(node.width)},`, `height: ${num(node.height)},`];
  if (p.cornerRadius) out.push(`borderRadius: ${num(p.cornerRadius)},`);
  if (fill?.css) out.push(`background: '${fill.css.replace(/'/g, "\\'")}',`);
  else if (fill?.type === 'image') out.push(`background: 'url(<图像填充>) center / cover no-repeat',`);
  if (p.opacity < 1) out.push(`opacity: ${p.opacity},`);
  if (stroke?.color && p.strokeWeight) out.push(`border: '${num(p.strokeWeight)}px solid ${stroke.color.hex}',`);
  const shadows = p.effects.filter((e) => e.css);
  if (shadows.length) out.push(`boxShadow: '${shadows.map((e) => e.css).join(', ')}',`);
  const t = p.text;
  if (t) {
    if (t.family) out.push(`fontFamily: "'${t.family}', sans-serif",`);
    if (t.size) out.push(`fontSize: ${num(t.size)},`);
    if (t.weight && t.weight !== 400) out.push(`fontWeight: ${t.weight},`);
    if (t.lineHeight) out.push(`lineHeight: '${num(t.lineHeight)}px',`);
    if (t.letterSpacing) out.push(`letterSpacing: ${num(t.letterSpacing)},`);
    if (t.color) out.push(`color: '${t.color.hex}',`);
    if (t.alignHorizontal && t.alignHorizontal !== 'LEFT') out.push(`textAlign: '${t.alignHorizontal.toLowerCase()}',`);
    out.push(`whiteSpace: 'pre-wrap',`);
  }
  return out;
}

export function generateSnippet(lang: SnippetLang, node: LayerNode): string {
  const p = baseParts(node).p;
  const t = p.text;

  if (lang === 'CSS') {
    return [
      `/* ${node.name} · 坐标相对画板左上角 */`,
      `.layer {`,
      ...cssDecls(node).map((l) => `  ${l}`),
      `}`,
    ].join('\n');
  }

  if (lang === 'React') {
    const el = t ? 'p' : 'div';
    return [
      `{/* ${node.name} · 坐标相对画板左上角 */}`,
      `<${el} style={{`,
      ...reactStyle(node).map((l) => `  ${l}`),
      `}}>${t?.content ? `\n  ${t.content.split('\n').join('\n  ')}\n` : ''}</${el}>`,
    ].join('\n');
  }

  if (lang === 'Swift') {
    const rgb = (hex: string) => {
      const [r, g, b] = hexToRgb01(hex);
      return `UIColor(red: ${r.toFixed(2)}, green: ${g.toFixed(2)}, blue: ${b.toFixed(2)}, alpha: 1.0)`;
    };
    const out: string[] = [`// ${node.name} · 坐标相对画板左上角`];
    const frame = `CGRect(x: ${Math.round(node.x)}, y: ${Math.round(node.y)}, width: ${Math.round(node.width)}, height: ${Math.round(node.height)})`;
    if (t) {
      out.push(`let label = UILabel(frame: ${frame})`);
      if (t.content) out.push(`label.text = ${JSON.stringify(t.content)}`);
      if (t.family) out.push(`label.font = UIFont(name: "${t.family}", size: ${Math.round(t.size ?? 14)})`);
      else if (t.size) out.push(`label.font = UIFont.systemFont(ofSize: ${Math.round(t.size)})`);
      if (t.color) out.push(`label.textColor = ${rgb(t.color.hex)}`);
      if (t.lineHeight) out.push(`// 行高 ${Math.round(t.lineHeight)}：使用 NSParagraphStyle 设置 lineSpacing`);
      if (t.alignHorizontal && t.alignHorizontal !== 'LEFT') out.push(`label.textAlignment = .${t.alignHorizontal.toLowerCase()}`);
      out.push(`label.numberOfLines = 0`);
      out.push(`view.addSubview(label)`);
    } else {
      out.push(`let view = UIView(frame: ${frame})`);
      const fill = p.fills.find((f) => f.visible && f.color);
      out.push(`view.backgroundColor = ${fill?.color ? rgb(fill.color.hex) : '.clear'}`);
      if (p.cornerRadius) out.push(`view.layer.cornerRadius = ${Math.round(p.cornerRadius)}`);
      out.push(`view.layer.masksToBounds = true`);
      if (p.opacity < 1) out.push(`view.alpha = ${p.opacity}`);
      const s = p.strokes.find((st) => st.visible && st.color);
      if (s?.color && p.strokeWeight) {
        out.push(`view.layer.borderWidth = ${p.strokeWeight}`);
        out.push(`view.layer.borderColor = ${rgb(s.color.hex)}.cgColor`);
      }
      const sh = p.effects.find((e) => e.type === 'DROP_SHADOW');
      if (sh) {
        out.push(`view.layer.shadowOpacity = ${(sh.color?.alpha ?? 0.25).toFixed(2)}`);
        out.push(`view.layer.shadowOffset = CGSize(width: ${sh.offsetX ?? 0}, height: ${sh.offsetY ?? 0})`);
        out.push(`view.layer.shadowRadius = ${(sh.radius ?? 0) / 2}`);
      }
      out.push(`parent.addSubview(view)`);
    }
    return out.join('\n');
  }

  // Android XML
  const out: string[] = [`<!-- ${node.name} · 坐标相对画板左上角，dp = px（@1x 设计稿时） -->`];
  const tag = t ? 'TextView' : 'View';
  out.push(`<${tag}`);
  out.push(`    android:layout_width="${Math.round(node.width)}dp"`);
  out.push(`    android:layout_height="${Math.round(node.height)}dp"`);
  out.push(`    android:layout_marginStart="${Math.round(node.x)}dp"`);
  out.push(`    android:layout_marginTop="${Math.round(node.y)}dp"`);
  const fill = p.fills.find((f) => f.visible && f.color);
  if (fill?.color) out.push(`    android:background="#FF${fill.color.hex.replace('#', '')}"`);
  if (p.opacity < 1) out.push(`    android:alpha="${p.opacity}"`);
  if (p.cornerRadius) out.push(`    <!-- 圆角 ${Math.round(p.cornerRadius)}dp：改用 shape drawable 设置 corners -->`);
  if (t) {
    if (t.content) out.push(`    android:text="${t.content.replace(/\n/g, '\\n')}"`);
    if (t.size) out.push(`    android:textSize="${Math.round(t.size)}sp"`);
    if (t.color) out.push(`    android:textColor="#FF${t.color.hex.replace('#', '')}"`);
    if (t.family) out.push(`    android:fontFamily="${t.family}"`);
    if (t.alignHorizontal && t.alignHorizontal !== 'LEFT') {
      out.push(`    android:gravity="${t.alignHorizontal === 'CENTER' ? 'center_horizontal' : 'end'}"`);
    }
  }
  out.push(`    ... />`);
  return out.join('\n');
}
