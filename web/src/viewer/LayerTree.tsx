import { useMemo } from 'react';
import type { LayerNode } from '../types';

interface Props {
  nodes: LayerNode[];
  frameNodeId: string;
  selectedId: string | null;
  hoverId: string | null;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
}

const TYPE_ICON: Record<string, string> = {
  FRAME: 'F', GROUP: 'G', COMPONENT: 'C', INSTANCE: 'I', TEXT: 'T',
  RECTANGLE: 'R', ELLIPSE: 'E', VECTOR: 'V', LINE: 'L', SLICE: 'S',
  BOOLEAN_OPERATION: 'B', REGULAR_POLYGON: 'P', STAR: '☆',
};

const iconOf = (type: string) => TYPE_ICON[type] ?? '◆';

function buildTree(nodes: LayerNode[], rootParentId: string): LayerNode[] {
  const byParent = new Map<string, LayerNode[]>();
  for (const n of nodes) {
    const key = n.parent_id ?? rootParentId;
    const list = byParent.get(key) ?? [];
    list.push(n);
    byParent.set(key, list);
  }
  const attach = (list: LayerNode[]): LayerNode[] =>
    list.map((n) => {
      const children = byParent.get(n.node_id)?.filter((c) => c !== n);
      return children && children.length > 0 ? { ...n, children: attach(children) } : n;
    });
  return attach(byParent.get(rootParentId) ?? []);
}

export default function LayerTree({ nodes, frameNodeId, selectedId, hoverId, onSelect, onHover }: Props) {
  const tree = useMemo(() => buildTree(nodes, frameNodeId), [nodes, frameNodeId]);

  const render = (list: LayerNode[], depth: number): React.ReactNode =>
    list.map((n) => (
      <div key={n.node_id}>
        <div
          className={`tree-item ${selectedId === n.node_id ? 'is-selected' : ''} ${hoverId === n.node_id ? 'is-hover' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => onSelect(n.node_id)}
          onMouseEnter={() => onHover(n.node_id)}
          onMouseLeave={() => onHover(null)}
          title={n.name}
        >
          <span className={`tree-icon tree-icon-${n.type}`}>{iconOf(n.type)}</span>
          <span className="tree-name">{n.name}</span>
          <span className="tree-size">{Math.round(n.width)}×{Math.round(n.height)}</span>
        </div>
        {n.children && render(n.children, depth + 1)}
      </div>
    ));

  return (
    <div className="layer-tree">
      {tree.length === 0 && <p className="tree-empty">暂无图层</p>}
      {render(tree, 0)}
    </div>
  );
}
