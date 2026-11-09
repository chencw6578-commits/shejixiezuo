import { readFileSync } from 'node:fs';
import { parsePluginExport } from '../src/figma/pluginImport.js';

const payload = JSON.parse(readFileSync('/workspace/figma-plugin/sample-export.json', 'utf8'));
const result = parsePluginExport(payload);

let marked = 0;
for (const f of result.frames) {
  console.log('frame', f.nodeId, f.name, 'layers:', f.layers.length);
  for (const l of f.layers) {
    const presets = (l.props as { exportPresets?: unknown[] }).exportPresets;
    if (presets?.length) {
      marked++;
      console.log('  ✓', l.nodeId, l.name, '->', JSON.stringify(presets));
    }
  }
}
console.log('frames:', result.frames.length, '| 带切图预设的图层:', marked);
if (marked === 0) {
  console.error('FAIL: 切图标记未被识别');
  process.exit(1);
}
console.log('PASS');
