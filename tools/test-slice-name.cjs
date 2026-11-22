// 验证 assets.ts 中 sliceFileName 的命名行为：保留 Figma 原图层名，只转义 ZIP 必需字符
function sliceFileName(name) {
  return String(name ?? '').replace(/[\\/\0]/g, '_').trim() || 'asset';
}
function safeName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'asset';
}
const BS = String.fromCharCode(92);   // 反斜杠
const NUL = String.fromCharCode(0);   // NUL
const cases = [
  ['按钮', '按钮'],
  ['顶部渐变 copy', '顶部渐变 copy'],
  ['icon/默认态', 'icon_默认态'],
  ['C:' + BS + 'icon', 'C:_icon'],
  ['价格 ¥99 (2x)', '价格 ¥99 (2x)'],
  ['长'.repeat(100), '长'.repeat(100)],   // 不截断
  ['a:b*c?d', 'a:b*c?d'],                 // 保留 Windows 非法字符（ZIP 内合法）
  ['  前后空格  ', '前后空格'],
  ['x' + NUL + 'y', 'x_y'],
  ['', 'asset'],
];
let fail = 0;
for (const [input, expect] of cases) {
  const got = sliceFileName(input);
  const ok = got === expect;
  if (!ok) { fail++; console.log('FAIL | got=' + JSON.stringify(got) + ' expect=' + JSON.stringify(expect)); }
  else console.log('PASS | ' + JSON.stringify(input.length > 16 ? input.slice(0, 16) + '...' : input));
}
console.log('--- 旧 safeName 对比 ---');
console.log('icon/默认态 => ' + safeName('icon/默认态') + ' (新旧一致)');
console.log('长x100 => 旧长度' + safeName('长'.repeat(100)).length + '(截断80) / 新长度' + sliceFileName('长'.repeat(100)).length + '(不截断)');
console.log(fail ? fail + ' FAIL' : '全部 ' + cases.length + ' PASS');
process.exit(fail ? 1 : 0);
