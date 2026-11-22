// 端到端验证整板主图「切图补洞」核心算法：
// ① 空白闸门：全透明切图被识别并跳过；② 坐标换算：按实测倍率贴到正确位置；
// ③ 像素落地：合成后目标位置出现切图像素、非目标区域保持不变。
import sharp from 'sharp';

const { buildCompositeLayers, REPAIRED_MARK } = await import('../dist/util/thumbRepair.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('PASS | ' + name); }
  else { fail++; console.log('FAIL | ' + name + (detail ? ' | ' + detail : '')); }
};

// 造一张 40x30 的白色整板（设计尺寸 20x15 → 实测倍率 2）
const boardW = 40, boardH = 30, scale = 2;
const board = await sharp({ create: { width: boardW, height: boardH, channels: 4, background: '#ffffff' } }).png().toBuffer();

// 造一张 8x8 的红色实心切图（4x 来源），代表 Figma 丢失的图标
const icon = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ff0000' } }).png().toBuffer();
// 造一张全透明切图，代表空白闸门要拦的图
const blank = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();

// ---- 用例 1：正常切图 + 空白切图混合 ----
const plan = await buildCompositeLayers(boardW, boardH, scale, [
  { buf: icon, name: '真实图标', x: 10, y: 5, width: 4, height: 4 },  // 目标 (20,10) 尺寸 8x8
  { buf: blank, name: '空图标', x: 2, y: 2, width: 4, height: 4 },
]);
ok('空白闸门识别空切图', plan.blankNames.length === 1 && plan.blankNames[0] === '空图标');
ok('空切图不进入合成层', plan.layers.length === 1);
ok('坐标换算 left = x*scale', plan.layers[0].left === 20, 'got ' + plan.layers[0].left);
ok('坐标换算 top = y*scale', plan.layers[0].top === 10, 'got ' + plan.layers[0].top);

const layerMeta = await sharp(plan.layers[0].input).metadata();
ok('缩放到 width*scale', layerMeta.width === 8, 'got ' + layerMeta.width);
ok('缩放到 height*scale', layerMeta.height === 8, 'got ' + layerMeta.height);

const composed = await sharp(board).composite(plan.layers.map(l => ({ input: l.input, left: l.left, top: l.top }))).raw().toBuffer({ resolveWithObject: true });
const px = (x, y) => {
  const i = (y * composed.info.width + x) * composed.info.channels;
  return [composed.data[i], composed.data[i + 1], composed.data[i + 2], composed.data[i + 3]];
};
const inIcon = px(24, 14);   // 目标图内部
const outIcon = px(0, 0);    // 画板左上角，非目标区
ok('目标位置已补上红色像素', inIcon[0] === 255 && inIcon[1] === 0 && inIcon[2] === 0, JSON.stringify(inIcon));
ok('非目标区域保持白色', outIcon[0] === 255 && outIcon[1] === 255 && outIcon[2] === 255, JSON.stringify(outIcon));

// ---- 用例 2：全部空白 → layers 为空（调用方据此 aborted） ----
const allBlank = await buildCompositeLayers(boardW, boardH, scale, [
  { buf: blank, name: '空1', x: 1, y: 1, width: 4, height: 4 },
  { buf: blank, name: '空2', x: 5, y: 5, width: 4, height: 4 },
]);
ok('全部空白时无合成层', allBlank.layers.length === 0);
ok('全部空白时 blankNames 数量正确', allBlank.blankNames.length === 2);

// ---- 用例 3：画板外的切图被跳过 ----
const outside = await buildCompositeLayers(boardW, boardH, scale, [
  { buf: icon, name: '画板外', x: 100, y: 100, width: 4, height: 4 },
]);
ok('画板外切图被跳过', outside.layers.length === 0);

ok('幂等标记常量正确', REPAIRED_MARK === '@repaired.');

console.log(`\n总计 PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
