// 预览：用真实的切图合成算法，模拟「Figma 整板导出丢失实心图标」的修复效果。
// 不连生产库、不写业务数据，只生成一张 before/after 对比 PNG 供确认。
import sharp from 'sharp';

const { buildCompositeLayers } = await import('../dist/util/thumbRepair.js');

// 用法：node scripts/preview-thumb-repair.mjs [输出路径.png]
// 默认输出到当前目录下的 thumb-repair-preview.png
const OUT = process.argv[2] || 'thumb-repair-preview.png';

// 设计尺寸 240x84 pt，整板按 2 倍导出
const FW = 240, FH = 84, SCALE = 2;
const BW = FW * SCALE, BH = FH * SCALE;

// 模拟 App 底部图标栏：前 2 个描边图标正常渲染，后 3 个实心图标在整板导出时丢失
const icons = [
  { x: 14, y: 24, name: '首页' },
  { x: 60, y: 24, name: '搜索' },
  { x: 106, y: 24, name: '网格', color: '#8b93a7', glyph: 'grid' },
  { x: 152, y: 24, name: '我的', color: '#4a7bf7', glyph: 'user' },
  { x: 198, y: 24, name: '消息', color: '#8b93a7', glyph: 'chat' },
];

function glyphSvg(g, cx, cy) {
  if (g === 'grid') {
    return `<rect x="${cx - 22}" y="${cy - 22}" width="18" height="18" rx="4" fill="#fff"/>`
      + `<rect x="${cx + 4}" y="${cy - 22}" width="18" height="18" rx="4" fill="#fff"/>`
      + `<rect x="${cx - 22}" y="${cy + 4}" width="18" height="18" rx="4" fill="#fff"/>`
      + `<rect x="${cx + 4}" y="${cy + 4}" width="18" height="18" rx="4" fill="#fff"/>`;
  }
  if (g === 'user') {
    return `<circle cx="${cx}" cy="${cy - 16}" r="14" fill="#fff"/>`
      + `<path d="M ${cx - 26} ${cy + 30} a 26 24 0 0 1 52 0 z" fill="#fff"/>`;
  }
  if (g === 'chat') {
    return `<rect x="${cx - 26}" y="${cy - 24}" width="52" height="40" rx="12" fill="#fff"/>`
      + `<path d="M ${cx - 10} ${cy + 14} L ${cx - 14} ${cy + 30} L ${cx + 6} ${cy + 14} z" fill="#fff"/>`;
  }
  return '';
}

// 修复前：白底 + 前 2 个描边图标（正常）+ 后 3 个灰虚线框（空白，模拟平台切图标记）
function boardSvg() {
  let s = `<rect width="${BW}" height="${BH}" fill="#ffffff"/>`;
  s += `<text x="14" y="17" font-family="Arial, sans-serif" font-size="10" fill="#9aa0aa">设计稿 · 底部图标栏（整板导出）</text>`;
  for (const ic of icons.slice(0, 2)) {
    const px = ic.x * SCALE, py = ic.y * SCALE, ps = 40 * SCALE;
    s += `<rect x="${px}" y="${py}" width="${ps}" height="${ps}" rx="12" fill="none" stroke="#5b6270" stroke-width="3"/>`;
    s += `<circle cx="${px + ps / 2}" cy="${py + ps / 2}" r="14" fill="none" stroke="#5b6270" stroke-width="3"/>`;
  }
  for (const ic of icons.slice(2)) {
    const px = ic.x * SCALE, py = ic.y * SCALE, ps = 40 * SCALE;
    s += `<rect x="${px}" y="${py}" width="${ps}" height="${ps}" rx="8" fill="#fafbfc" stroke="#b9bfca" stroke-width="1.5" stroke-dasharray="7 6"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BW}" height="${BH}">${s}</svg>`;
}

// 单张切图：4x 透明底实心图标（与插件实际导出的 4x PNG 同口径）
async function sliceBuf(ic) {
  const S = 160; // 40pt * 4
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">`
    + `<rect x="6" y="6" width="${S - 12}" height="${S - 12}" rx="30" fill="${ic.color}"/>`
    + glyphSvg(ic.glyph, S / 2, S / 2)
    + `</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const boardBuf = await sharp(Buffer.from(boardSvg())).png().toBuffer();
const inputs = [];
for (const ic of icons.slice(2)) {
  inputs.push({ buf: await sliceBuf(ic), name: ic.name, x: ic.x, y: ic.y, width: 40, height: 40 });
}

// 调用真实核心算法：验空白 → 算坐标 → 缩放切图
const plan = await buildCompositeLayers(BW, BH, SCALE, inputs);
console.log('合成层=' + plan.layers.length + ' 空白=' + JSON.stringify(plan.blankNames) + ' 坐标=' + JSON.stringify(plan.layers.map(l => [l.left, l.top])));

const repairedBuf = await sharp(boardBuf)
  .composite(plan.layers.map(l => ({ input: l.input, left: l.left, top: l.top })))
  .png()
  .toBuffer();

// 拼成左右对比图
const pad = 22, gap = 20, titleH = 52, footH = 70;
const totalW = pad * 2 + BW * 2 + gap;
const totalH = titleH + BH + footH;
const bg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}">`
  + `<rect width="100%" height="100%" fill="#eef0f4"/>`
  + `<text x="${pad}" y="34" font-family="Arial, sans-serif" font-size="19" font-weight="bold" fill="#1a1b1e">修复前 · Figma 整板导出</text>`
  + `<text x="${pad + BW + gap}" y="34" font-family="Arial, sans-serif" font-size="19" font-weight="bold" fill="#1a1b1e">修复后 · 切图合成补洞</text>`
  + `<text x="${pad}" y="${titleH + BH + 30}" font-family="Arial, sans-serif" font-size="13" fill="#5b6270">3 个实心图标位置空白，仅显示平台叠加的灰色虚线切图标记</text>`
  + `<text x="${pad}" y="${titleH + BH + 52}" font-family="Arial, sans-serif" font-size="13" fill="#2f7d4f">合成后：真实切图按节点坐标贴回整板图，图标恢复显示</text>`
  + `</svg>`;

await sharp(Buffer.from(bg))
  .composite([
    { input: boardBuf, left: pad, top: titleH },
    { input: repairedBuf, left: pad + BW + gap, top: titleH },
  ])
  .png()
  .toFile(OUT);
console.log('saved ' + OUT);
