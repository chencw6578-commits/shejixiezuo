/* 冒烟测试：构造最小 .sketch zip → importSketch → 校验 DB 与 SVG 输出 */
import JSZip from 'jszip';
import { pool } from '../src/db.js';
import { importSketch } from '../src/sketch/import.js';

const color = (r: number, g: number, b: number, a = 1) => ({ red: r / 255, green: g / 255, blue: b / 255, alpha: a });

const artboard = {
  _class: 'artboard',
  do_objectID: 'AB-1',
  name: '登录页',
  frame: { x: 0, y: 0, width: 375, height: 812 },
  backgroundColor: color(250, 250, 252),
  style: {},
  exportOptions: { exportFormats: [] },
  layers: [
    {
      _class: 'rectangle', do_objectID: 'R-1', name: '主按钮',
      frame: { x: 24, y: 640, width: 327, height: 48 },
      style: {
        contextSettings: { opacity: 1 },
        fills: [{ isEnabled: true, fillType: 0, color: color(59, 130, 246) }],
        borders: [],
        shadows: [{ isEnabled: true, offsetX: 0, offsetY: 4, blurRadius: 12, spread: 0, color: color(59, 130, 246, 0.3) }],
      },
      points: [{ point: { x: 0, y: 0 }, cornerRadius: 8 }, { point: { x: 1, y: 1 }, cornerRadius: 8 }],
      exportOptions: { exportFormats: [{ fileFormat: 'png', scale: '2x' }, { fileFormat: 'svg' }] },
    },
    {
      _class: 'text', do_objectID: 'T-1', name: '标题',
      frame: { x: 24, y: 120, width: 200, height: 32 },
      attributedString: { string: '欢迎回来' },
      style: {
        textStyle: {
          encodedAttributes: {
            MSAttributedStringFontAttribute: { _class: 'fontDescriptor', attributes: { name: 'PingFangSC-Semibold', size: 24 } },
            MSAttributedStringColorAttribute: color(17, 24, 39),
          },
        },
        paragraphStyle: { alignment: 0, maximumLineHeight: 32 },
      },
    },
    {
      _class: 'oval', do_objectID: 'O-1', name: '头像',
      frame: { x: 150, y: 300, width: 75, height: 75 },
      style: {
        fills: [{ isEnabled: true, fillType: 1, gradient: { gradientType: 0, from: { x: 0.5, y: 0 }, to: { x: 0.5, y: 1 }, stops: [{ position: 0, color: color(255, 99, 132) }, { position: 1, color: color(75, 192, 192) }] } }],
        borders: [],
      },
    },
    {
      _class: 'group', do_objectID: 'G-1', name: '卡片组',
      frame: { x: 24, y: 420, width: 327, height: 100 },
      style: {},
      layers: [
        {
          _class: 'rectangle', do_objectID: 'R-2', name: '卡片背景',
          frame: { x: 0, y: 0, width: 327, height: 100 },
          style: { fills: [{ isEnabled: true, fillType: 0, color: color(255, 255, 255) }], borders: [{ isEnabled: true, thickness: 1, position: 1, color: color(0, 0, 0, 0.08) }] },
        },
      ],
    },
  ],
};

const pageJson = JSON.stringify({ _class: 'page', do_objectID: 'P-1', name: '页面 1', layers: [artboard] });

async function main() {
  const zip = new JSZip();
  zip.file('meta.json', JSON.stringify({ pagesAndArtboards: {} }));
  zip.file('document.json', JSON.stringify({ pagesAndArtboards: {} }));
  zip.file('pages/P-1.json', pageJson);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });

  const { rows } = await pool.query(
    `INSERT INTO design_files (figma_key, name, status, source) VALUES ('smoke.sketch', 'Sketch 冒烟测试', 'processing', 'sketch') RETURNING id`
  );
  const fileId = rows[0].id;
  try {
    const r = await importSketch(fileId, buf);
    console.log('import result:', r);

    const frames = (await pool.query('SELECT name, width, height, thumb_url FROM frames WHERE file_id = $1', [fileId])).rows;
    console.log('frames:', JSON.stringify(frames));
    const nodes = (await pool.query('SELECT name, type, x, y, width, height, props FROM nodes WHERE file_id = $1 ORDER BY id', [fileId])).rows;
    console.log('nodes:');
    for (const n of nodes) {
      console.log(`  ${n.name} [${n.type}] (${n.x},${n.y} ${n.width}x${n.height}) radius=${n.props.cornerRadius ?? '-'} exports=${JSON.stringify(n.props.exportPresets ?? [])}`);
    }
    const text = nodes.find((n) => n.type === 'TEXT');
    console.log('text props:', JSON.stringify(text?.props.text));
    const oval = nodes.find((n) => n.type === 'OVAL');
    console.log('gradient css:', oval?.props.fills?.[0]?.css);
    const group = nodes.find((n) => n.type === 'GROUP');
    const card = nodes.find((n) => n.name === '卡片背景');
    console.log('group->card parent ok:', !!group && !!card, '| card strokeWeight:', card?.props.strokeWeight, card?.props.strokeAlign);

    const svg = await pool.query('SELECT thumb_url FROM frames WHERE file_id = $1 LIMIT 1', [fileId]);
    const res = await fetch(`http://127.0.0.1:3000${svg.rows[0].thumb_url}`);
    const svgText = await res.text();
    console.log('svg status:', res.status, '| has rect:', svgText.includes('<rect'), '| has text:', svgText.includes('欢迎回来'), '| has gradient def:', svgText.includes('linearGradient'));
  } finally {
    await pool.query('DELETE FROM design_files WHERE id = $1', [fileId]);
    await pool.end();
  }
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
