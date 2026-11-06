/**
 * MCP 工具集：让 AI 编码工具（Claude Code / Cursor / Trae 等）直接读取设计稿。
 *
 * 场景：AI 开发时通过 MCP 拿到画板结构、图层规格（含 CSS）、设计规范聚合与设计图，
 * 从而按设计稿精准还原 UI，而不是凭空猜测间距与颜色。
 */
import { pool } from '../db.js';
import { getStorage } from '../storage/index.js';
import { renderLocalSlice } from '../export/local.js';

// ---------- 工具结果类型（MCP content blocks） ----------

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

interface ToolResult {
  content: Content[];
  isError?: boolean;
}

const json = (v: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(v, null, 1) }],
});

const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError: true } : {}),
});

// ---------- 输入 Schema（JSON Schema 子集） ----------

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });

// ---------- 节点规格输出 ----------

interface NodeRow {
  node_id: string;
  parent_id: string | null;
  name: string | null;
  type: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  props: {
    opacity?: number;
    fills?: Array<Record<string, unknown>>;
    strokes?: Array<Record<string, unknown>>;
    effects?: Array<Record<string, unknown>>;
    cornerRadius?: number;
    exportPresets?: Array<Record<string, unknown>>;
    text?: {
      family?: string;
      weight?: number;
      size?: number;
      lineHeight?: number;
      alignHorizontal?: string;
      characters?: string;
      color?: Record<string, unknown>;
    };
  };
}

const NODE_COLS = `node_id, parent_id, name, type, x, y, width, height, visible, props`;

async function frameNodes(fileId: string, frameId: string): Promise<NodeRow[]> {
  const { rows } = await pool.query<NodeRow>(
    `SELECT ${NODE_COLS} FROM nodes WHERE file_id = $1 AND frame_id = $2 ORDER BY id`,
    [fileId, frameId]
  );
  return rows;
}

function cssColor(c: unknown): string | null {
  if (!c || typeof c !== 'object') return typeof c === 'string' ? c : null;
  const o = c as Record<string, unknown>;
  if (typeof o.css === 'string') return o.css;
  if (typeof o.hex === 'string') {
    const a = typeof o.alpha === 'number' && o.alpha < 1
      ? o.hex + Math.round(o.alpha * 255).toString(16).padStart(2, '0')
      : o.hex;
    return a;
  }
  if (typeof o.r === 'number' && o.r <= 1) {
    const to = (v: number) => Math.round(v * 255);
    return `rgba(${to(o.r)}, ${to(o.g)}, ${to(o.b)}, ${typeof o.a === 'number' ? o.a : 1})`;
  }
  return null;
}

function firstFill(props: NodeRow['props']): string | null {
  const fills = Array.isArray(props?.fills) ? props.fills : [];
  const f = fills.find((x) => x && (x as Record<string, unknown>).visible !== false) as
    | Record<string, unknown>
    | undefined;
  if (!f) return null;
  const stops = f.gradientStops;
  if (Array.isArray(stops) && stops.length > 0) {
    const parts = stops
      .map((s) => {
        const o = s as Record<string, unknown>;
        const c = cssColor(o.color ?? o);
        const pos = typeof o.position === 'number' ? o.position : 0;
        return c ? `rgb ${pos} ${c}` : null;
      })
      .filter(Boolean)
      .join(', ');
    if (parts) return `linear-gradient(${parts})`;
  }
  return cssColor(f.color ?? f.css);
}

function borderOf(props: NodeRow['props']): string | null {
  const strokes = Array.isArray(props?.strokes) ? props.strokes : [];
  const st = strokes[0] as Record<string, unknown> | undefined;
  if (!st || st.visible === false) return null;
  const c = cssColor(st.color ?? st.css);
  if (!c) return null;
  const w = typeof st.weight === 'number' ? st.weight : 1;
  return `${w}px solid ${c}`;
}

function shadowOf(props: NodeRow['props']): string | null {
  const effects = Array.isArray(props?.effects) ? props.effects : [];
  const parts = effects
    .filter((e) => (e as Record<string, unknown>).visible !== false)
    .map((e) => {
      const o = e as Record<string, unknown>;
      const c = cssColor(o.color) ?? 'rgba(0,0,0,0.2)';
      const inner = o.type === 'INNER_SHADOW' ? 'inset ' : '';
      return `${inner}${o.offsetX ?? 0}px ${o.offsetY ?? 0}px ${o.radius ?? 0}px ${o.spread ?? 0}px ${c}`;
    });
  return parts.length ? parts.join(', ') : null;
}

/** 图层规格 → CSS（绝对定位由 AI 按布局上下文自行调整） */
function cssForNode(n: NodeRow): string {
  const lines: string[] = [
    `width: ${n.width}px;`,
    `height: ${n.height}px;`,
  ];
  const bg = firstFill(n.props);
  if (bg) lines.push(`background: ${bg};`);
  const border = borderOf(n.props);
  if (border) lines.push(`border: ${border};`);
  const r = Number(n.props?.cornerRadius) || 0;
  if (r > 0) lines.push(`border-radius: ${r}px;`);
  const shadow = shadowOf(n.props);
  if (shadow) lines.push(`box-shadow: ${shadow};`);
  if (typeof n.props?.opacity === 'number' && n.props.opacity < 1) {
    lines.push(`opacity: ${n.props.opacity};`);
  }
  const t = n.props?.text;
  if (t) {
    if (t.family) lines.push(`font-family: "${t.family}", sans-serif;`);
    lines.push(`font-size: ${t.size ?? 14}px;`);
    if (t.weight) lines.push(`font-weight: ${t.weight};`);
    lines.push(`line-height: ${t.lineHeight ?? Math.round((t.size ?? 14) * 1.4)}px;`);
    if (t.alignHorizontal && t.alignHorizontal !== 'LEFT') {
      lines.push(`text-align: ${t.alignHorizontal.toLowerCase()};`);
    }
    const color = cssColor(t.color) ?? firstFill(n.props);
    if (color) lines.push(`color: ${color};`);
    lines.push(`content: ${JSON.stringify(t.characters ?? n.name ?? '')};`);
  }
  return lines.join('\n');
}

function specOf(n: NodeRow) {
  const spec: Record<string, unknown> = {
    id: n.node_id,
    name: n.name,
    type: n.type,
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
  };
  const bg = firstFill(n.props);
  if (bg) spec.fill = bg;
  const border = borderOf(n.props);
  if (border) spec.border = border;
  const shadow = shadowOf(n.props);
  if (shadow) spec.shadow = shadow;
  if (Number(n.props?.cornerRadius) > 0) spec.cornerRadius = n.props.cornerRadius;
  if (typeof n.props?.opacity === 'number' && n.props.opacity < 1) spec.opacity = n.props.opacity;
  const t = n.props?.text;
  if (t) {
    spec.text = {
      characters: t.characters ?? n.name,
      fontFamily: t.family,
      fontSize: t.size,
      fontWeight: t.weight,
      lineHeight: t.lineHeight,
      align: t.alignHorizontal,
      color: cssColor(t.color),
    };
  }
  if (Array.isArray(n.props?.exportPresets) && n.props.exportPresets.length > 0) {
    spec.exportPresets = n.props.exportPresets;
  }
  spec.css = cssForNode(n);
  return spec;
}

/** 紧凑图层树（省略填充细节，只保留结构 + 几何 + 名称，用于理解布局）。根 = parent_id 为 NULL 或画板自身 node_id 的图层 */
function treeOf(rows: NodeRow[], frameNodeId: string | null): unknown {
  const byParent = new Map<string | null, NodeRow[]>();
  for (const n of rows) {
    const k = n.parent_id;
    const list = byParent.get(k) ?? [];
    list.push(n);
    byParent.set(k, list);
  }
  const roots = [...(byParent.get(null) ?? []), ...(frameNodeId ? byParent.get(frameNodeId) ?? [] : [])];
  const build = (n: NodeRow): Record<string, unknown> => {
    const o: Record<string, unknown> = {
      id: n.node_id,
      name: n.name,
      type: n.type,
      x: n.x,
      y: n.y,
      w: n.width,
      h: n.height,
    };
    if (n.type === 'TEXT') {
      o.text = n.props?.text?.characters ?? n.name;
      o.fontSize = n.props?.text?.size;
      o.color = cssColor(n.props?.text?.color) ?? firstFill(n.props);
    } else {
      const bg = firstFill(n.props);
      if (bg) o.fill = bg;
      if (Number(n.props?.cornerRadius) > 0) o.radius = n.props.cornerRadius;
    }
    const kids = byParent.get(n.node_id);
    if (kids && kids.length > 0) o.children = kids.map(build);
    return o;
  };
  return roots.map(build);
}

// ---------- 图片内容 ----------

async function frameThumbImage(frameId: string): Promise<ToolResult> {
  const { rows } = await pool.query<{ thumb_url: string | null; name: string }>(
    'SELECT thumb_url, name FROM frames WHERE id = $1',
    [frameId]
  );
  const f = rows[0];
  if (!f) return text(`画板不存在: ${frameId}`, true);
  if (!f.thumb_url || !f.thumb_url.startsWith('/storage/')) {
    return text(`画板「${f.name}」没有本地缩略图（Figma 远程文件请访问其 thumb_url）`, true);
  }
  const storage = await getStorage();
  const buf = await storage.get(f.thumb_url.replace(/^\/storage\//, ''));
  return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }] };
}

async function sliceImage(frameId: string, nodeId: string, scale: number): Promise<ToolResult> {
  const meta = (
    await pool.query<{ file_id: string; name: string; source: string; figma_key: string }>(
      `SELECT d.id AS file_id, d.name, d.source, d.figma_key
       FROM nodes n JOIN design_files d ON d.id = n.file_id
       WHERE n.frame_id = $1 LIMIT 1`,
      [frameId]
    )
  ).rows[0];
  if (!meta) return text(`画板不存在: ${frameId}`, true);
  const local = meta.source !== 'figma' || /^(DEMO)/.test(meta.figma_key);
  if (!local) {
    return text('远程 Figma 文件暂不支持返回位图，请使用 get_frame_tree / get_node 获取结构化规格', true);
  }
  const slice = await renderLocalSlice(meta.file_id, frameId, nodeId, 'PNG', scale);
  if (!slice) return text(`图层不存在或不可渲染: ${nodeId}`, true);
  return { content: [{ type: 'image', data: slice.buf.toString('base64'), mimeType: 'image/png' }] };
}

// ---------- 设计规范聚合 ----------

async function designTokens(fileId: string): Promise<ToolResult> {
  const { rows } = await pool.query<{ props: NodeRow['props'] }>(
    'SELECT props FROM nodes WHERE file_id = $1',
    [fileId]
  );
  const colors = new Map<string, number>();
  const textStyles = new Map<string, number>();
  const radii = new Map<number, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const { props } of rows) {
    const bg = firstFill(props);
    if (bg && !bg.startsWith('linear-gradient')) bump(colors, bg);
    const t = props?.text;
    if (t) {
      const color = cssColor(t.color) ?? firstFill(props);
      if (color) bump(colors, color);
      bump(
        textStyles,
        `${t.family ?? 'unknown'} ${t.size ?? 14}px/${t.lineHeight ?? '?'} w${t.weight ?? 400}`
      );
    }
    const r = Number(props?.cornerRadius) || 0;
    if (r > 0) radii.set(r, (radii.get(r) ?? 0) + 1);
  }
  const sorted = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
  return json({
    colors: sorted(colors).slice(0, 24),
    textStyles: sorted(textStyles).slice(0, 20),
    cornerRadius: [...radii.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value: `${value}px`, count })),
  });
}

// ---------- 工具定义与分发 ----------

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

const need = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v) throw new Error(`缺少参数 ${name}`);
  return v;
};

export const TOOLS: McpTool[] = [
  {
    name: 'list_projects',
    description: '列出所有项目（团队 → 项目 → 设计稿），返回项目 id、名称与设计稿数量。开发前先从这里拿 projectId。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const { rows } = await pool.query(
        `SELECT p.id, p.name, count(f.id) AS file_count
         FROM projects p LEFT JOIN design_files f ON f.project_id = p.id
         GROUP BY p.id ORDER BY p.created_at`
      );
      return json(rows);
    },
  },
  {
    name: 'list_files',
    description: '列出某项目下的设计稿（Figma/Sketch/PSD），返回设计稿 id、名称、来源与解析状态。',
    inputSchema: {
      type: 'object',
      properties: { projectId: str('项目 id，来自 list_projects') },
      required: ['projectId'],
    },
    async run(args) {
      const { rows } = await pool.query(
        'SELECT id, name, source, version, status FROM design_files WHERE project_id = $1 ORDER BY created_at',
        [need(args.projectId, 'projectId')]
      );
      return json(rows);
    },
  },
  {
    name: 'list_frames',
    description: '列出某设计稿下的全部画板（页面截图对应的根画板），返回画板 id、名称与尺寸。',
    inputSchema: {
      type: 'object',
      properties: { fileId: str('设计稿 id，来自 list_files') },
      required: ['fileId'],
    },
    async run(args) {
      const { rows } = await pool.query(
        'SELECT id, name, page_name, width, height FROM frames WHERE file_id = $1 ORDER BY sort_order',
        [need(args.fileId, 'fileId')]
      );
      return json(rows);
    },
  },
  {
    name: 'get_frame_tree',
    description: '获取画板的完整图层树（嵌套结构 + 几何 + 填充 + 文本），用于理解页面布局与实现 UI 结构。',
    inputSchema: {
      type: 'object',
      properties: { frameId: str('画板 id，来自 list_frames') },
      required: ['frameId'],
    },
    async run(args) {
      const frameId = need(args.frameId, 'frameId');
      const meta = (
        await pool.query<{ file_id: string; name: string; width: number; height: number; node_id: string }>(
          'SELECT file_id, name, width, height, node_id FROM frames WHERE id = $1',
          [frameId]
        )
      ).rows[0];
      if (!meta) return text(`画板不存在: ${frameId}`, true);
      const rows = await frameNodes(meta.file_id, frameId);
      return json({
        frame: { id: frameId, name: meta.name, width: meta.width, height: meta.height },
        tree: treeOf(rows, meta.node_id),
      });
    },
  },
  {
    name: 'get_node',
    description:
      '获取单个图层的完整规格（几何/填充/描边/阴影/圆角/文字样式）与生成好的 CSS，按 nodeId 或名称模糊匹配。实现某个具体组件时用。',
    inputSchema: {
      type: 'object',
      properties: {
        frameId: str('画板 id，来自 list_frames'),
        nodeId: str('图层 id（来自 get_frame_tree），与 nodeName 二选一'),
        nodeName: str('图层名称模糊匹配（如「登录按钮」），与 nodeId 二选一'),
      },
      required: ['frameId'],
    },
    async run(args) {
      const frameId = need(args.frameId, 'frameId');
      const meta = (
        await pool.query<{ file_id: string }>('SELECT file_id FROM frames WHERE id = $1', [frameId])
      ).rows[0];
      if (!meta) return text(`画板不存在: ${frameId}`, true);
      const rows = await frameNodes(meta.file_id, frameId);
      const nodeId = typeof args.nodeId === 'string' ? args.nodeId : '';
      const nodeName = typeof args.nodeName === 'string' ? args.nodeName.trim() : '';
      if (nodeId) {
        const n = rows.find((r) => r.node_id === nodeId);
        return n ? json(specOf(n)) : text(`图层不存在: ${nodeId}`, true);
      }
      if (nodeName) {
        const kw = nodeName.toLowerCase();
        const hits = rows.filter((r) => (r.name ?? '').toLowerCase().includes(kw));
        if (hits.length === 0) return text(`没有名称包含「${nodeName}」的图层`, true);
        if (hits.length > 1) {
          return json({
            message: `匹配到 ${hits.length} 个图层，请用 nodeId 精确获取`,
            matches: hits.map((h) => ({ id: h.node_id, name: h.name, type: h.type })),
          });
        }
        return json(specOf(hits[0]));
      }
      return text('请提供 nodeId 或 nodeName', true);
    },
  },
  {
    name: 'get_design_tokens',
    description: '聚合某设计稿全部图层的设计规范：使用频次排序的颜色、字体样式组合、圆角值。建立主题/变量时用。',
    inputSchema: {
      type: 'object',
      properties: { fileId: str('设计稿 id，来自 list_files') },
      required: ['fileId'],
    },
    async run(args) {
      return designTokens(need(args.fileId, 'fileId'));
    },
  },
  {
    name: 'get_image',
    description:
      '获取设计图：不带 nodeId 返回整块画板缩略图（可直接看设计）；带 nodeId 返回该图层的切图 PNG（scale 默认 2，最大 4）。多模态模型可借此「看到」设计稿。',
    inputSchema: {
      type: 'object',
      properties: {
        frameId: str('画板 id，来自 list_frames'),
        nodeId: str('可选：图层 id，返回单图层切图'),
        scale: num('可选：切图倍率 1-4，默认 2'),
      },
      required: ['frameId'],
    },
    async run(args) {
      const frameId = need(args.frameId, 'frameId');
      const scale = Math.min(4, Math.max(1, Number(args.scale) || 2));
      if (typeof args.nodeId === 'string' && args.nodeId) {
        return sliceImage(frameId, args.nodeId, scale);
      }
      return frameThumbImage(frameId);
    },
  },
];

export async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return text(`未知工具: ${name}`, true);
  try {
    return await tool.run(args ?? {});
  } catch (err) {
    return text(err instanceof Error ? err.message : String(err), true);
  }
}

export function toolList() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}
