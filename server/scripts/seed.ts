/**
 * 演示数据种子脚本：无 FIGMA_TOKEN 也能体验完整产品。
 *  - 纯 Node（zlib）生成画板缩略图 PNG
 *  - 插入 design_files / frames / nodes，与真实导入的数据结构完全一致
 *
 * 运行：npx tsx scripts/seed.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { initDb, pool } from '../src/db.js';

// ---------- 极简 PNG 生成 ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

interface Shape {
  kind: 'rect' | 'circle';
  x: number; y: number; w: number; h: number;
  color: [number, number, number];
}

/** 将形状列表光栅化为 PNG（后画的在上层）。 */
export function renderPng(width: number, height: number, shapes: Shape[]): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  const isInside = (s: Shape, px: number, py: number) => {
    if (s.kind === 'rect') return px >= s.x && px < s.x + s.w && py >= s.y && py < s.y + s.h;
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2;
    const rx = s.w / 2;
    const ry = s.h / 2;
    const dx = (px - cx) / rx;
    const dy = (py - cy) / ry;
    return dx * dx + dy * dy <= 1;
  };
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      let c: [number, number, number] = [255, 255, 255];
      for (const s of shapes) if (isInside(s, x, y)) c = s.color; // 顺序覆盖
      const off = rowStart + 1 + x * 3;
      raw[off] = c[0];
      raw[off + 1] = c[1];
      raw[off + 2] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 演示数据 ----------

const rgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

interface DemoLayer {
  nodeId: string;
  parentId: string | null;
  name: string;
  type: string;
  x: number; y: number; width: number; height: number;
  shape?: Shape;
  props: Record<string, unknown>;
}

interface DemoFrame {
  nodeId: string;
  name: string;
  width: number;
  height: number;
  layers: DemoLayer[];
}

const L = (
  nodeId: string, parentId: string, name: string, type: string,
  x: number, y: number, width: number, height: number,
  color: string | null,
  props: Record<string, unknown> = {},
  shape?: Shape
): DemoLayer => ({
  nodeId, parentId, name, type, x, y, width, height,
  props: {
    opacity: 1, fills: [], strokes: [], effects: [], exportPresets: [], hasImageFill: false,
    ...props,
  },
  shape: shape ?? undefined,
  ...(color
    ? { shape: shape ?? { kind: type === 'ELLIPSE' ? 'circle' : 'rect', x, y, width, height, color: rgb(color) } }
    : {}),
});

const solid = (hex: string, alpha = 1) => ({
  type: 'solid', visible: true, opacity: 1,
  color: { hex, alpha, rgba: `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${alpha})` },
  css: `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${alpha})`,
});

function homeFrame(): DemoFrame {
  const F = 'demo:home';
  const bg = '#F7F8FA';
  const card = '#FFFFFF';
  const blue = '#1B6DFF';
  const layers: DemoLayer[] = [
    L(`${F}:bg`, F, '页面背景', 'RECTANGLE', 0, 0, 375, 812, bg, { fills: [solid(bg)] }),
    L(`${F}:nav`, F, '顶部导航', 'RECTANGLE', 0, 0, 375, 88, blue, { fills: [solid(blue)] }),
    L(`${F}:nav-title`, F, '导航标题', 'TEXT', 130, 50, 115, 24, '#FFFFFF', {
      fills: [solid('#FFFFFF')],
      text: { family: 'PingFang SC', weight: 600, size: 17, lineHeight: 24, alignHorizontal: 'CENTER', color: solid('#FFFFFF').color },
    }),
  ];
  for (let i = 0; i < 4; i++) {
    const y = 104 + i * 96;
    layers.push(L(`${F}:card${i}`, F, `卡片 ${i + 1}`, 'RECTANGLE', 16, y, 343, 80, card, {
      fills: [solid(card)], cornerRadius: 12,
      effects: [{ type: 'DROP_SHADOW', offsetX: 0, offsetY: 2, radius: 8, spread: 0, color: { hex: '#1B2A4A', alpha: 0.08, rgba: 'rgba(27, 42, 74, 0.08)' }, css: '0px 2px 8px 0px rgba(27, 42, 74, 0.08)' }],
    }));
    layers.push(L(`${F}:card${i}-icon`, F, `卡片图标 ${i + 1}`, 'ELLIPSE', 32, y + 20, 40, 40, i % 2 ? '#E8F1FF' : '#FFF3E0'));
    layers.push(L(`${F}:card${i}-title`, F, `卡片标题 ${i + 1}`, 'TEXT', 88, y + 18, 120, 20, '#1D2129', {
      fills: [solid('#1D2129')],
      text: { family: 'PingFang SC', weight: 500, size: 15, lineHeight: 20, alignHorizontal: 'LEFT', color: solid('#1D2129').color },
    }));
    layers.push(L(`${F}:card${i}-desc`, F, `卡片描述 ${i + 1}`, 'TEXT', 88, y + 44, 180, 18, '#86909C', {
      fills: [solid('#86909C')],
      text: { family: 'PingFang SC', weight: 400, size: 13, lineHeight: 18, alignHorizontal: 'LEFT', color: solid('#86909C').color },
    }));
  }
  layers.push(L(`${F}:tab`, F, '底部标签栏', 'RECTANGLE', 0, 740, 375, 72, card, { fills: [solid(card)] }));
  layers.push(L(`${F}:tab-fab`, F, '发布按钮', 'ELLIPSE', 155, 712, 64, 64, blue, {
    fills: [solid(blue)],
    exportPresets: [
      { format: 'PNG', suffix: '@2x', scale: 2 },
      { format: 'PNG', suffix: '@3x', scale: 3 },
      { format: 'SVG', suffix: '', scale: 1 },
    ],
  }));
  return { nodeId: F, name: '首页 / Home', width: 375, height: 812, layers };
}

function loginFrame(): DemoFrame {
  const F = 'demo:login';
  const primary = '#1B6DFF';
  const text1 = '#1D2129';
  const text3 = '#86909C';
  const layers: DemoLayer[] = [
    L(`${F}:bg`, F, '背景', 'RECTANGLE', 0, 0, 375, 812, '#FFFFFF', { fills: [solid('#FFFFFF')] }),
    L(`${F}:hero`, F, '品牌区', 'RECTANGLE', 0, 0, 375, 280, '#EAF2FF', { fills: [solid('#EAF2FF')] }),
    L(`${F}:logo`, F, 'Logo', 'ELLIPSE', 148, 88, 80, 80, primary, { fills: [solid(primary)] }),
    L(`${F}:slogan`, F, '标语', 'TEXT', 88, 196, 200, 22, text3, {
      fills: [solid(text3)],
      text: { family: 'PingFang SC', weight: 400, size: 15, lineHeight: 22, alignHorizontal: 'CENTER', color: solid(text3).color },
    }),
    L(`${F}:input-1`, F, '输入框-手机号', 'RECTANGLE', 32, 320, 311, 48, '#F2F3F5', {
      fills: [solid('#F2F3F5')], cornerRadius: 8,
    }),
    L(`${F}:input-1-ph`, F, '占位文案-手机号', 'TEXT', 48, 334, 140, 20, text3, {
      fills: [solid(text3)],
      text: { family: 'PingFang SC', weight: 400, size: 14, lineHeight: 20, alignHorizontal: 'LEFT', color: solid(text3).color },
    }),
    L(`${F}:input-2`, F, '输入框-验证码', 'RECTANGLE', 32, 384, 311, 48, '#F2F3F5', {
      fills: [solid('#F2F3F5')], cornerRadius: 8,
    }),
    L(`${F}:input-2-ph`, F, '占位文案-验证码', 'TEXT', 48, 398, 140, 20, text3, {
      fills: [solid(text3)],
      text: { family: 'PingFang SC', weight: 400, size: 14, lineHeight: 20, alignHorizontal: 'LEFT', color: solid(text3).color },
    }),
    L(`${F}:btn`, F, '登录按钮', 'FRAME', 32, 464, 311, 48, primary, {
      fills: [solid(primary)], cornerRadius: 24,
      exportPresets: [
        { format: 'PNG', suffix: '@2x', scale: 2 },
        { format: 'PNG', suffix: '@3x', scale: 3 },
        { format: 'SVG', suffix: '', scale: 1 },
      ],
    }),
    L(`${F}:btn-label`, `${F}:btn`, '按钮文案', 'TEXT', 157, 478, 60, 20, '#FFFFFF', {
      fills: [solid('#FFFFFF')],
      text: { family: 'PingFang SC', weight: 500, size: 16, lineHeight: 20, alignHorizontal: 'CENTER', color: solid('#FFFFFF').color },
    }),
    L(`${F}:agree`, F, '用户协议', 'TEXT', 96, 544, 184, 18, text3, {
      fills: [solid(text3)],
      text: { family: 'PingFang SC', weight: 400, size: 12, lineHeight: 18, alignHorizontal: 'CENTER', color: solid(text3).color },
    }),
  ];
  return { nodeId: F, name: '登录 / Login', width: 375, height: 812, layers };
}

function profileFrame(): DemoFrame {
  const F = 'demo:profile';
  const card = '#FFFFFF';
  const primary = '#1B6DFF';
  const layers: DemoLayer[] = [
    L(`${F}:bg`, F, '页面背景', 'RECTANGLE', 0, 0, 375, 812, '#F7F8FA', { fills: [solid('#F7F8FA')] }),
    L(`${F}:header`, F, '头部', 'RECTANGLE', 0, 0, 375, 180, primary, { fills: [solid(primary)] }),
    L(`${F}:avatar`, F, '头像', 'ELLIPSE', 148, 44, 80, 80, '#FFFFFF'),
    L(`${F}:name`, F, '昵称', 'TEXT', 148, 136, 80, 22, '#FFFFFF', {
      fills: [solid('#FFFFFF')],
      text: { family: 'PingFang SC', weight: 600, size: 16, lineHeight: 22, alignHorizontal: 'CENTER', color: solid('#FFFFFF').color },
    }),
  ];
  const rows = ['我的订单', '我的收藏', '浏览历史', '设置'];
  for (let i = 0; i < rows.length; i++) {
    const y = 196 + i * 64;
    layers.push(L(`${F}:row${i}`, F, `菜单项-${rows[i]}`, 'RECTANGLE', 16, y, 343, 56, card, {
      fills: [solid(card)], cornerRadius: 8,
    }));
    layers.push(L(`${F}:row${i}-t`, F, `菜单文案-${rows[i]}`, 'TEXT', 40, y + 17, 120, 20, '#1D2129', {
      fills: [solid('#1D2129')],
      text: { family: 'PingFang SC', weight: 400, size: 15, lineHeight: 20, alignHorizontal: 'LEFT', color: solid('#1D2129').color },
    }));
    layers.push(L(`${F}:row${i}-arrow`, F, `箭头-${rows[i]}`, 'ELLIPSE', 335, y + 24, 8, 8, '#C9CDD4'));
  }
  return { nodeId: F, name: '我的 / Profile', width: 375, height: 812, layers };
}

// ---------- 收集页（第二批测试设计稿：同一布局的三种风格变体） ----------

interface CollectPal { bg: string; card: string; text: string; sub: string; accent: string; iconA: string; iconB: string }

function collectFrame(prefix: string, name: string, pal: CollectPal): DemoFrame {
  const F = `${prefix}:${name}`;
  const layers: DemoLayer[] = [
    L(`${F}:bg`, F, '页面背景', 'RECTANGLE', 0, 0, 375, 812, pal.bg, { fills: [solid(pal.bg)] }),
    L(`${F}:nav`, F, '顶部导航', 'RECTANGLE', 0, 0, 375, 88, pal.accent, { fills: [solid(pal.accent)] }),
    L(`${F}:nav-title`, F, '导航标题', 'TEXT', 130, 50, 115, 24, '#FFFFFF', {
      fills: [solid('#FFFFFF')],
      text: { family: 'PingFang SC', weight: 600, size: 17, lineHeight: 24, alignHorizontal: 'CENTER', color: solid('#FFFFFF').color },
    }),
    L(`${F}:search`, F, '搜索框', 'RECTANGLE', 16, 104, 343, 44, pal.card, { fills: [solid(pal.card)], cornerRadius: 22 }),
    L(`${F}:search-ph`, F, '搜索占位', 'TEXT', 36, 116, 120, 20, pal.sub, {
      fills: [solid(pal.sub)],
      text: { family: 'PingFang SC', weight: 400, size: 14, lineHeight: 20, alignHorizontal: 'LEFT', color: solid(pal.sub).color },
    }),
  ];
  for (let i = 0; i < 6; i++) {
    const x = 16 + (i % 2) * 177;
    const y = 164 + Math.floor(i / 2) * 156;
    layers.push(L(`${F}:card${i}`, F, `收集卡片 ${i + 1}`, 'RECTANGLE', x, y, 165, 140, pal.card, {
      fills: [solid(pal.card)], cornerRadius: 12,
      effects: [{ type: 'DROP_SHADOW', offsetX: 0, offsetY: 2, radius: 8, spread: 0, color: { hex: '#1B2A4A', alpha: 0.08, rgba: 'rgba(27, 42, 74, 0.08)' }, css: '0px 2px 8px 0px rgba(27, 42, 74, 0.08)' }],
    }));
    layers.push(L(`${F}:card${i}-icon`, F, `卡片图标 ${i + 1}`, 'ELLIPSE', x + 16, y + 16, 36, 36, i % 2 ? pal.iconA : pal.iconB));
    layers.push(L(`${F}:card${i}-t`, F, `卡片标题 ${i + 1}`, 'TEXT', x + 16, y + 62, 120, 20, pal.text, {
      fills: [solid(pal.text)],
      text: { family: 'PingFang SC', weight: 500, size: 14, lineHeight: 20, alignHorizontal: 'LEFT', color: solid(pal.text).color },
    }));
    layers.push(L(`${F}:card${i}-d`, F, `卡片描述 ${i + 1}`, 'TEXT', x + 16, y + 88, 130, 18, pal.sub, {
      fills: [solid(pal.sub)],
      text: { family: 'PingFang SC', weight: 400, size: 12, lineHeight: 18, alignHorizontal: 'LEFT', color: solid(pal.sub).color },
    }));
  }
  layers.push(L(`${F}:tab`, F, '底部标签栏', 'RECTANGLE', 0, 740, 375, 72, pal.card, { fills: [solid(pal.card)] }));
  layers.push(L(`${F}:fab`, F, '收藏按钮', 'ELLIPSE', 155, 712, 64, 64, pal.accent, {
    fills: [solid(pal.accent)],
    exportPresets: [
      { format: 'PNG', suffix: '@2x', scale: 2 },
      { format: 'PNG', suffix: '@3x', scale: 3 },
      { format: 'SVG', suffix: '', scale: 1 },
    ],
  }));
  return { nodeId: F, name, width: 375, height: 812, layers };
}

async function insertDemoFile(projectId: string, figmaKey: string, name: string, pageName: string, frames: DemoFrame[]) {
  const { rows: [file] } = await pool.query<{ id: string }>(
    `INSERT INTO design_files (figma_key, name, version, status, project_id)
     VALUES ($1, $2, 'demo-v1', 'ready', $3) RETURNING id`,
    [figmaKey, name, projectId]
  );
  const storageDir = path.resolve('storage');
  let sort = 0;
  for (const f of frames) {
    const scale = 2;
    const shapes = f.layers
      .map((l) => l.shape)
      .filter((s): s is Shape => !!s)
      .map((s) => ({ ...s, x: s.x * scale, y: s.y * scale, w: s.width * scale, h: s.height * scale }));
    const png = renderPng(f.width * scale, f.height * scale, shapes);
    const key = `files/${file.id}/frames/${f.nodeId}@2x.png`;
    const abs = path.join(storageDir, key);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, png);

    const { rows: [fr] } = await pool.query<{ id: string }>(
      `INSERT INTO frames (file_id, node_id, name, page_name, width, height, thumb_url, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [file.id, f.nodeId, f.name, pageName, f.width, f.height, `/storage/${key}`, sort++]
    );
    for (const l of f.layers) {
      await pool.query(
        `INSERT INTO nodes (file_id, frame_id, node_id, parent_id, name, type, x, y, width, height, visible, props)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, $11)`,
        [file.id, fr.id, l.nodeId, l.parentId, l.name, l.type, l.x, l.y, l.width, l.height, JSON.stringify(l.props)]
      );
    }
    console.log(`seeded frame: ${f.name} (${f.layers.length} layers)`);
  }
  console.log(`done. file id = ${file.id}`);
}

async function main() {
  await initDb();

  // 幂等：清掉旧演示数据
  await pool.query("DELETE FROM design_files WHERE figma_key IN ('DEMO', 'DEMO2')");
  // 演示团队 + 演示项目（幂等）
  const team = await pool.query<{ id: string }>('SELECT id FROM teams WHERE name = $1', ['演示团队']);
  const teamId =
    team.rows[0]?.id ??
    (await pool.query<{ id: string }>('INSERT INTO teams (name) VALUES ($1) RETURNING id', ['演示团队'])).rows[0].id;
  const proj = await pool.query<{ id: string }>('SELECT id FROM projects WHERE name = $1', ['演示项目']);
  const projectId =
    proj.rows[0]?.id ??
    (await pool.query<{ id: string }>('INSERT INTO projects (name, team_id) VALUES ($1, $2) RETURNING id', ['演示项目', teamId]))
      .rows[0].id;
  await pool.query('UPDATE projects SET team_id = $1 WHERE team_id IS NULL', [teamId]);
  // 其余未归属的稿子也挂到演示项目下
  await pool.query('UPDATE design_files SET project_id = $1 WHERE project_id IS NULL', [projectId]);

  await insertDemoFile(projectId, 'DEMO', '演示设计稿（本地示例）', '演示页面', [
    homeFrame(), loginFrame(), profileFrame(),
  ]);
  await insertDemoFile(projectId, 'DEMO2', '收集页', '收集页', [
    collectFrame('demo2', '首页（浅色）', { bg: '#F7F8FA', card: '#FFFFFF', text: '#1D2129', sub: '#86909C', accent: '#1B6DFF', iconA: '#E8F1FF', iconB: '#FFF3E0' }),
    collectFrame('demo2', '首页（深色）', { bg: '#12141A', card: '#1E2430', text: '#E8EAED', sub: '#9AA0A6', accent: '#3B82F6', iconA: '#1F3350', iconB: '#3A2F1E' }),
    collectFrame('demo2', '我的（圆角）', { bg: '#F6F9F8', card: '#FFFFFF', text: '#1D2129', sub: '#86909C', accent: '#10B981', iconA: '#D9F2E6', iconB: '#FFF7E0' }),
  ]);

  // 演示「原型交互」：按钮/标签栏跳转到目标画板（静态原型导出用）
  const addInteractions = async (figmaKey: string, links: Array<{ node: string; target: string }>) => {
    const { rows: [f] } = await pool.query<{ id: string }>(
      'SELECT id FROM design_files WHERE figma_key = $1',
      [figmaKey]
    );
    if (!f) return;
    const { rows: frames } = await pool.query<{ id: string; node_id: string }>(
      'SELECT id, node_id FROM frames WHERE file_id = $1',
      [f.id]
    );
    for (const l of links) {
      const target = frames.find((fr) => fr.node_id === l.target);
      if (!target) continue;
      await pool.query(
        `UPDATE nodes SET props = props || $1::jsonb WHERE file_id = $2 AND node_id = $3`,
        [JSON.stringify({ interaction: { type: 'navigate', targetFrameId: target.id } }), f.id, l.node]
      );
    }
  };
  await addInteractions('DEMO', [
    { node: 'demo:login:btn', target: 'demo:profile' },
    { node: 'demo:home:tab-fab', target: 'demo:login' },
    { node: 'demo:home:tab', target: 'demo:profile' },
    { node: 'demo:profile:header', target: 'demo:home' },
  ]);
  await addInteractions('DEMO2', [
    { node: 'demo2:首页（浅色）:tab', target: 'demo2:我的（圆角）' },
    { node: 'demo2:首页（浅色）:fab', target: 'demo2:首页（深色）' },
    { node: 'demo2:首页（深色）:tab', target: 'demo2:我的（圆角）' },
    { node: 'demo2:我的（圆角）:fab', target: 'demo2:首页（浅色）' },
    { node: 'demo2:我的（圆角）:tab', target: 'demo2:首页（浅色）' },
  ]);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
