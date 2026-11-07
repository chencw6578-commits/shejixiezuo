/**
 * 测试项目种子（可重复执行 / 幂等）：团队「666」下的「功能测试」项目
 *  - 10 张不同尺寸画板 + 真实节点树（GROUP / RECTANGLE / ELLIPSE / FRAME / TEXT）
 *  - 编组：首页模块（5）、详情模块（4），剩余 1 张未分组
 *  - 数据全部写服务端数据库，不写 localStorage
 *
 * 运行（server 目录）：npx tsx scripts/seedTestProject.ts
 */
import { initDb, pool } from '../src/db.js';

type TextSpec = { content: string; size: number; weight?: number; lineHeight?: number; align?: 'LEFT' | 'CENTER' | 'RIGHT'; color?: string };

interface N {
  id: string;
  parent?: string;
  name: string;
  type: string;
  x: number; y: number; w: number; h: number;
  fill?: string;
  radius?: number;
  border?: { color: string; width: number };
  shadow?: boolean;
  text?: TextSpec;
}

const rgbaOf = (hex: string, alpha = 1) => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { hex, alpha, rgba: `rgba(${r}, ${g}, ${b}, ${alpha})` };
};
const fillOf = (hex: string, alpha = 1) => ({ type: 'solid', visible: true, opacity: 1, color: rgbaOf(hex, alpha), css: rgbaOf(hex, alpha).rgba });

const toProps = (n: N) => {
  const textColor = n.text?.color ?? n.fill ?? '#111827';
  return {
    opacity: 1,
    fills: n.text ? [fillOf(textColor)] : n.fill ? [fillOf(n.fill)] : [],
    strokes: n.border ? [fillOf(n.border.color)] : [],
    strokeWeight: n.border?.width,
    strokeAlign: 'INSIDE',
    effects: n.shadow
      ? [{ type: 'DROP_SHADOW', offsetX: 0, offsetY: 2, radius: 8, spread: 0, color: rgbaOf('#1B2A4A', 0.08), css: '0px 2px 8px 0px rgba(27, 42, 74, 0.08)' }]
      : [],
    cornerRadius: n.radius ?? 0,
    exportPresets: [],
    hasImageFill: false,
    ...(n.text
      ? {
          fills: [fillOf(textColor)],
          text: {
            family: 'PingFang SC',
            weight: n.text.weight ?? 400,
            size: n.text.size,
            lineHeight: n.text.lineHeight ?? Math.round(n.text.size * 1.45),
            alignHorizontal: n.text.align ?? 'LEFT',
            alignVertical: 'CENTER',
            color: rgbaOf(textColor),
            content: n.text.content,
          },
        }
      : {}),
  };
};

const C = { bg: '#F4F5F7', card: '#FFFFFF', primary: '#6C4CF1', text: '#111827', sub: '#6B7280', line: '#EEF0F3', soft: '#F2F3F5' };

const T = (id: string, parent: string | null, name: string, x: number, y: number, w: number, h: number, t: TextSpec): N => ({
  id, parent: parent ?? undefined, name, type: 'TEXT', x, y, w, h, text: t, fill: t.color ?? C.text,
});
const R = (id: string, parent: string | null, name: string, x: number, y: number, w: number, h: number, fill: string, radius = 0, shadow = false): N => ({
  id, parent: parent ?? undefined, name, type: 'RECTANGLE', x, y, w, h, fill, radius, shadow,
});
const E = (id: string, parent: string | null, name: string, x: number, y: number, w: number, h: number, fill: string): N => ({
  id, parent: parent ?? undefined, name, type: 'ELLIPSE', x, y, w, h, fill,
});
const F = (id: string, parent: string | null, name: string, x: number, y: number, w: number, h: number, fill: string, radius = 0): N => ({
  id, parent: parent ?? undefined, name, type: 'FRAME', x, y, w, h, fill, radius,
});
const G = (id: string, name: string, x: number, y: number, w: number, h: number): N => ({ id, name, type: 'GROUP', x, y, w, h });

/** 一套通用节点树：适配任意画板尺寸，覆盖 GROUP/RECT/FRAME/ELLIPSE/TEXT */
function pageNodes(W: number, H: number, title: string): N[] {
  const pad = W >= 768 ? 48 : 20;
  const cardW = W - pad * 2;
  const cardY = 104;
  const cardH = Math.min(320, H - cardY - 64);
  return [
    F('bar', null, '顶部栏', 0, 0, W, 88, C.card),
    T('barTitle', 'bar', '页面标题', pad, 30, W - pad * 2, 32, { content: title, size: W >= 768 ? 22 : 18, weight: 600 }),
    G('card', '内容卡片', pad, cardY, cardW, cardH),
    R('cardBg', 'card', '卡片背景', 0, 0, cardW, cardH, C.card, 16, true),
    T('cardTitle', 'card', '卡片标题', 24, 24, cardW - 48, 30, { content: `${title} · 标题`, size: 18, weight: 600 }),
    T('cardDesc', 'card', '卡片说明', 24, 62, cardW - 48, 44, { content: '用于验证属性面板、量距与文本编辑的说明文字。', size: 14, lineHeight: 22, color: C.sub }),
    F('cover', 'card', '封面容器', 24, 122, 120, 120, C.soft, 12),
    E('avatar', 'cover', '头像圆形', 20, 20, 80, 80, C.primary),
    T('price', 'cover', '价格标签', 8, 88, 104, 24, { content: '¥ 199', size: 13, weight: 600, align: 'CENTER', color: C.text }),
    R('cta', 'card', '主按钮', 24, Math.max(122 + 120 + 16, cardH - 68), cardW - 48, 44, C.primary, 8),
    T('ctaText', 'cta', '按钮文字', 12, 11, cardW - 72, 22, { content: '立即体验', size: 15, weight: 600, align: 'CENTER', color: '#FFFFFF' }),
    E('deco', null, '右上角装饰圆', W - pad - 44, cardY - 20, 64, 64, '#EFEBFF'),
    R('footer', null, '底部说明条', pad, H - 56, cardW, 32, C.soft, 6),
    T('footerText', 'footer', '底部文字', 12, 6, cardW - 24, 20, { content: '功能测试画板 · 可自由拖动与编组', size: 12, color: C.sub }),
  ];
}

interface FrameSpec { name: string; w: number; h: number; group: '首页模块' | '详情模块' | null }
const FRAMES: FrameSpec[] = [
  { name: '首页 · 390', w: 390, h: 844, group: '首页模块' },
  { name: '首页 · 375', w: 375, h: 812, group: '首页模块' },
  { name: '首页 · 414', w: 414, h: 896, group: '首页模块' },
  { name: '列表 · 320', w: 320, h: 568, group: '首页模块' },
  { name: '列表 · 768', w: 768, h: 1024, group: '首页模块' },
  { name: '详情 · 390', w: 390, h: 844, group: '详情模块' },
  { name: '详情 · 414', w: 414, h: 896, group: '详情模块' },
  { name: '详情 · 1440', w: 1440, h: 900, group: '详情模块' },
  { name: '后台 · 1280', w: 1280, h: 800, group: '详情模块' },
  { name: '草稿 · 360', w: 360, h: 640, group: null },
];

const TEAM_NAME = '666';
const PROJECT_NAME = '功能测试 · 画板能力验证';
const FIGMA_KEY = 'test-project-func';

async function ensureTeam() {
  const found = await pool.query<{ id: string }>('SELECT id FROM teams WHERE name = $1', [TEAM_NAME]);
  if (found.rows[0]) return found.rows[0].id;
  const { rows } = await pool.query<{ id: string }>('INSERT INTO teams (name) VALUES ($1) RETURNING id', [TEAM_NAME]);
  return rows[0].id;
}

async function ensureProject(teamId: string) {
  const found = await pool.query<{ id: string }>('SELECT id FROM projects WHERE name = $1 AND team_id = $2', [PROJECT_NAME, teamId]);
  if (found.rows[0]) return found.rows[0].id;
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO projects (name, team_id) VALUES ($1, $2) RETURNING id',
    [PROJECT_NAME, teamId]
  );
  return rows[0].id;
}

async function ensureFile(projectId: string) {
  const found = await pool.query<{ id: string }>('SELECT id FROM design_files WHERE figma_key = $1', [FIGMA_KEY]);
  if (found.rows[0]) {
    await pool.query('UPDATE design_files SET project_id = $1, status = $2 WHERE id = $3', [projectId, 'ready', found.rows[0].id]);
    return found.rows[0].id;
  }
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO design_files (figma_key, name, version, status, project_id)
     VALUES ($1, $2, 'seed-func', 'ready', $3) RETURNING id`,
    [FIGMA_KEY, '移动端 · 功能测试', projectId]
  );
  return rows[0].id;
}

async function ensurePage(fileId: string, name: string, sort: number) {
  const found = await pool.query<{ id: string }>('SELECT id FROM pages WHERE file_id = $1 AND name = $2', [fileId, name]);
  if (found.rows[0]) {
    await pool.query('UPDATE pages SET sort_order = $1 WHERE id = $2', [sort, found.rows[0].id]);
    return found.rows[0].id;
  }
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO pages (file_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id',
    [fileId, name, sort]
  );
  return rows[0].id;
}

async function ensureFrame(fileId: string, spec: FrameSpec, index: number, pageId: string | null) {
  const nodeId = `${FIGMA_KEY}:${spec.name}`;
  // 网格排布：每行 4 张，间距 96；不重叠
  const colW = 1560;
  const rowH = 1120;
  const x = (index % 4) * colW;
  const y = Math.floor(index / 4) * rowH;
  const found = await pool.query<{ id: string }>('SELECT id FROM frames WHERE file_id = $1 AND node_id = $2', [fileId, nodeId]);
  if (found.rows[0]) {
    await pool.query(
      `UPDATE frames SET name = $2, width = $3, height = $4, sort_order = $5,
         canvas_x = $6, canvas_y = $7, page_id = $8, page_name = $9, page_sort = $10
       WHERE file_id = $1 AND node_id = $11`,
      [fileId, spec.name, spec.w, spec.h, index, x, y, pageId, spec.group, index, nodeId]
    );
    return found.rows[0].id;
  }
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO frames (file_id, node_id, name, width, height, sort_order, canvas_x, canvas_y, page_id, page_name, page_sort, thumb_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [fileId, nodeId, spec.name, spec.w, spec.h, index, x, y, pageId, spec.group, index, spec.w <= 768 ? '/storage/demo/phone.svg' : null]
  );
  return rows[0].id;
}

async function main() {
  await initDb();
  const teamId = await ensureTeam();
  const projectId = await ensureProject(teamId);
  const fileId = await ensureFile(projectId);

  const groups: Record<string, string> = {
    首页模块: await ensurePage(fileId, '首页模块', 0),
    详情模块: await ensurePage(fileId, '详情模块', 1),
  };

  let total = 0;
  for (let i = 0; i < FRAMES.length; i++) {
    const spec = FRAMES[i];
    const pageId = spec.group ? groups[spec.group] : null;
    const frameId = await ensureFrame(fileId, spec, i, pageId);
    const nodes = pageNodes(spec.w, spec.h, spec.name);
    await pool.query('DELETE FROM nodes WHERE frame_id = $1', [frameId]);
    for (const n of nodes) {
      await pool.query(
        `INSERT INTO nodes (file_id, frame_id, node_id, parent_id, name, type, x, y, width, height, visible, props)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, $11)`,
        [
          fileId, frameId,
          `${FIGMA_KEY}:${spec.name}:${n.id}`,
          n.parent ? `${FIGMA_KEY}:${spec.name}:${n.parent}` : null,
          n.name, n.type, n.x, n.y, n.w, n.h,
          JSON.stringify(toProps(n)),
        ]
      );
      total++;
    }
    console.log(`seeded ${spec.name} (${nodes.length} nodes, group=${spec.group ?? '未分组'})`);
  }
  console.log(`done: project=${PROJECT_NAME} frames=${FRAMES.length} nodes=${total}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
