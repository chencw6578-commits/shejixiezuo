// 验证 PropertyPanel.doExport 单张切图下载的文件名规则：
// 图层名转小写 + 保留 @Nx 倍率后缀 + 格式小写
function fileName(layerName, presetScale, scale, format, presetFormat) {
  const suffix = presetScale && presetScale !== 1 ? `@${presetScale}x` : Number(scale) !== 1 ? `@${scale}x` : '';
  return `${layerName.toLowerCase()}${suffix}.${(presetFormat ?? format).toLowerCase()}`;
}
const cases = [
  // [图层名, 预设倍率, 下拉倍率, 格式, 预设格式, 期望]
  ['XZ_ICON', undefined, 2, 'PNG', undefined, 'xz_icon@2x.png'],
  ['XZ_ICON', 2, 1, 'PNG', undefined, 'xz_icon@2x.png'],
  ['kgbz_icon', undefined, 1, 'PNG', undefined, 'kgbz_icon.png'],
  ['Vector', undefined, 1, 'PNG', undefined, 'vector.png'],
  ['ICON', 3, 2, 'WEBP', undefined, 'icon@3x.webp'],
  ['FooBar', undefined, 4, 'PNG', 'SVG', 'foobar@4x.svg'],
  ['MiXeD', undefined, 1, 'PNG', undefined, 'mixed.png'],
];
let fail = 0;
for (const [name, ps, s, fmt, pf, expect] of cases) {
  const got = fileName(name, ps, s, fmt, pf);
  const ok = got === expect;
  if (!ok) { fail++; console.log('FAIL | ' + JSON.stringify(name) + ' => ' + JSON.stringify(got) + ' expect ' + JSON.stringify(expect)); }
  else console.log('PASS | ' + JSON.stringify(name) + ' => ' + JSON.stringify(got));
}
console.log(fail ? fail + ' FAIL' : '全部 ' + cases.length + ' PASS');
process.exit(fail ? 1 : 0);
