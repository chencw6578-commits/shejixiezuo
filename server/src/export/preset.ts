/**
 * 解析「Figma 真正标记要导出的图层」。
 *
 * 设计师通常把 Export 预设打在图标外层的容器（如 20×20 Frame）上，而网站里
 * 用户很容易点到它内部的 Vector 路径。若按子节点包围盒裁剪，就会得到
 * 「尺寸不是 Figma 设置值 + 四边被切断」的碎图。
 *
 * 规则：
 *  - 选中图层自身带预设 → 用自身 bbox（Figma 导出的边界就是它）；
 *  - 自身无预设 → 沿 parent_id 向上找最近的带预设「小图标容器」，用该祖先的
 *    bbox 与预设（尺寸、边缘都与 Figma 标记一致）；
 *  - 都找不到 → 用「自身 + 全部后代」的包围盒并集，并补上描边外扩，
 *    保证随便点一个图层也不会把溢出内容/描边切掉。
 */
import { pool } from '../db.js';

export interface ExportPreset {
  format: string;
  scale: number;
  suffix: string;
}

export interface CropBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExportTarget {
  /** 实际应导出的节点（自身或最近带预设的祖先） */
  nodeId: string;
  name: string;
  /** 是否就是用户点中的那个图层 */
  own: boolean;
  preset: ExportPreset | null;
  /** 裁剪框（画板坐标系，单位 px） */
  bounds: CropBounds;
  /** 非 null 表示已上溯到父级 Figma 标记，供前端如实说明 */
  resolvedFrom: { node_id: string; name: string; format: string; scale: number } | null;
}

interface NodeRow {
  node_id: string;
  parent_id: string | null;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  props: {
    exportPresets?: ExportPreset[];
    strokeWeight?: number;
    strokes?: unknown[];
  } | null;
}

function presetsOf(n: NodeRow | undefined): ExportPreset[] {
  const ps = n?.props?.exportPresets;
  return Array.isArray(ps) ? ps.filter((p) => p && typeof p.scale === 'number') : [];
}

/** 自身 + 全部后代的包围盒并集，外加可见描边的一半外扩（近似 Figma renderBounds）。 */
function renderBounds(
  rootId: string,
  byId: Map<string, NodeRow>,
  childrenOf: Map<string, NodeRow[]>
): CropBounds {
  const root = byId.get(rootId)!;
  let x0 = root.x;
  let y0 = root.y;
  let x1 = root.x + root.width;
  let y1 = root.y + root.height;
  let stroke = 0;
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    if (!n) continue;
    x0 = Math.min(x0, n.x);
    y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + n.width);
    y1 = Math.max(y1, n.y + n.height);
    if ((n.props?.strokes?.length ?? 0) > 0 && (n.props?.strokeWeight ?? 0) > 0) {
      stroke = Math.max(stroke, n.props!.strokeWeight! / 2);
    }
    for (const c of childrenOf.get(id) ?? []) stack.push(c.node_id);
  }
  return {
    x: x0 - stroke,
    y: y0 - stroke,
    width: Math.max(1, x1 - x0 + stroke * 2),
    height: Math.max(1, y1 - y0 + stroke * 2),
  };
}

export interface NodeIndex {
  rows: NodeRow[];
  byId: Map<string, NodeRow>;
  childrenOf: Map<string, NodeRow[]>;
}

/** 一次加载画板全部节点；批量导出时复用，避免每个图层都查一次全表。 */
export async function loadNodeIndex(fileId: string, frameId: string): Promise<NodeIndex> {
  const { rows } = await pool.query<NodeRow>(
    `SELECT node_id, parent_id, name, x, y, width, height, props
     FROM nodes WHERE frame_id = $1 AND file_id = $2`,
    [frameId, fileId]
  );
  const byId = new Map(rows.map((r) => [r.node_id, r]));
  const childrenOf = new Map<string, NodeRow[]>();
  for (const n of rows) {
    if (!n.parent_id) continue;
    const list = childrenOf.get(n.parent_id) ?? [];
    list.push(n);
    childrenOf.set(n.parent_id, list);
  }
  return { rows, byId, childrenOf };
}

export function resolveFromIndex(index: NodeIndex, nodeId: string): ExportTarget | null {
  const { byId, childrenOf } = index;
  const self = byId.get(nodeId);
  if (!self) return null;

  const own = presetsOf(self);
  if (own.length) {
    return {
      nodeId,
      name: self.name,
      own: true,
      preset: own[0],
      bounds: { x: self.x, y: self.y, width: self.width, height: self.height },
      resolvedFrom: null,
    };
  }

  // 只认「小图标容器」：避免选中卡片里的一段文字时，误按整块卡片的预设导出
  let cur = self.parent_id ? byId.get(self.parent_id) : undefined;
  let depth = 0;
  while (cur && depth++ < 8) {
    const ps = presetsOf(cur);
    const small =
      cur.width <= 256 && cur.height <= 256 &&
      cur.width <= Math.max(64, self.width * 4) &&
      cur.height <= Math.max(64, self.height * 4);
    if (ps.length && small) {
      return {
        nodeId: cur.node_id,
        name: cur.name,
        own: false,
        preset: ps[0],
        bounds: { x: cur.x, y: cur.y, width: cur.width, height: cur.height },
        resolvedFrom: {
          node_id: cur.node_id,
          name: cur.name,
          format: ps[0].format,
          scale: ps[0].scale,
        },
      };
    }
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }

  return {
    nodeId,
    name: self.name,
    own: true,
    preset: null,
    bounds: renderBounds(nodeId, byId, childrenOf),
    resolvedFrom: null,
  };
}

/** 单张导出用的便捷入口。 */
export async function resolveExportTarget(
  fileId: string,
  frameId: string,
  nodeId: string
): Promise<ExportTarget | null> {
  return resolveFromIndex(await loadNodeIndex(fileId, frameId), nodeId);
}

/** 给画板详情接口的每个节点补上「最近的带 Figma 预设的祖先」，供前端默认倍率使用。 */
export function attachPresetAncestors<T extends NodeRow>(nodes: T[]): (T & {
  exportPresetAncestor: {
    node_id: string; name: string; format: string; scale: number; suffix: string;
    width: number; height: number;
  } | null;
})[] {
  const byId = new Map(nodes.map((n) => [n.node_id, n]));
  return nodes.map((n) => {
    if (presetsOf(n).length) return { ...n, exportPresetAncestor: null };
    let cur = n.parent_id ? byId.get(n.parent_id) : undefined;
    let depth = 0;
    let found: NodeRow | undefined;
    while (cur && depth++ < 8) {
      const ps = presetsOf(cur);
      const small =
        cur.width <= 256 && cur.height <= 256 &&
        cur.width <= Math.max(64, n.width * 4) &&
        cur.height <= Math.max(64, n.height * 4);
      if (ps.length && small) { found = cur; break; }
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    if (!found) return { ...n, exportPresetAncestor: null };
    const ps = presetsOf(found)[0];
    return {
      ...n,
      exportPresetAncestor: {
        node_id: found.node_id,
        name: found.name,
        format: ps.format,
        scale: ps.scale,
        suffix: ps.suffix ?? '',
        width: found.width,
        height: found.height,
      },
    };
  });
}
