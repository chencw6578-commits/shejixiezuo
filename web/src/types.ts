export interface PageRow {
  id: string;
  name: string;
  sort_order?: number;
}

export interface FrameRow {
  id: string;
  node_id: string;
  name: string;
  page_name: string | null;
  page_id?: string | null;
  page_sort?: number;
  width: number;
  height: number;
  thumb_url: string | null;
  sort_order: number;
  /** 导入平台（插件导入时写入）：ios / android / web */
  platform?: string | null;
  scale?: number | null;
}

export interface FileDetail {
  id: string;
  figma_key: string;
  name: string;
  version: string | null;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  error: string | null;
  source?: 'figma' | 'sketch' | 'psd';
  project_id?: string | null;
  team_id?: string | null;
  created_at: string;
  frame_count?: number;
  frames?: FrameRow[];
  pages?: PageRow[];
}

export interface ParsedColor {
  hex: string;
  alpha: number;
  rgba: string;
}

export interface ParsedFill {
  type: 'solid' | 'gradient' | 'image' | 'other';
  visible: boolean;
  opacity: number;
  color?: ParsedColor;
  css?: string | null;
  scaleMode?: string;
}

export interface ParsedEffect {
  type: string;
  css?: string;
  offsetX?: number;
  offsetY?: number;
  radius?: number;
  spread?: number;
  color?: ParsedColor;
}

export interface ParsedTextStyle {
  family?: string;
  postScript?: string;
  weight?: number;
  size?: number;
  lineHeight?: number;
  letterSpacing?: number;
  alignHorizontal?: string;
  alignVertical?: string;
  textDecoration?: string;
  textCase?: string;
  color?: ParsedColor;
}

export interface ParsedNodeProps {
  opacity: number;
  fills: ParsedFill[];
  strokes: ParsedFill[];
  strokeWeight?: number;
  strokeAlign?: string;
  effects: ParsedEffect[];
  cornerRadius?: number;
  cornerRadii?: number[];
  blendMode?: string;
  text?: ParsedTextStyle & { content: string };
  exportPresets: { format: string; suffix: string; scale: number }[];
  hasImageFill: boolean;
}

export interface LayerNode {
  id: number;          // 数据库行 id（自增 = 插入顺序）
  node_id: string;     // Figma 节点 id
  parent_id: string | null;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  props: ParsedNodeProps;
  render_url?: string | null;  // 渲染资产（矢量 SVG / 位图），有则优先替代 CSS 近似
  children?: LayerNode[];
}

export interface FrameDetail {
  frame: {
    id: string;
    file_id: string;
    node_id: string;
    name: string;
    page_name: string | null;
    width: number;
    height: number;
    thumb_url: string | null;
    platform?: string | null;
    scale?: number | null;
  };
  nodes: LayerNode[];
}

export interface ExportResult {
  id: string;
  url: string;
  format: string;
  scale: number;
  size: number;
}

export interface ProjectFrameRow {
  id: string;
  file_id: string;
  name: string;
  page_name: string | null;
  page_id?: string | null;
  page_sort?: number;
  sort_order?: number;
  width: number;
  height: number;
  thumb_url: string | null;
  file_name: string;
  source: string;
  /** 画布自由坐标（null = 尚未排布，首次进入时自动铺一次） */
  canvas_x?: number | null;
  canvas_y?: number | null;
  platform?: string | null;
  scale?: number | null;
}

/** 项目画板页里的编组（pages 表，属于某份设计稿） */
export interface ProjectPageRow {
  id: string;
  file_id: string;
  name: string;
  sort_order?: number;
  file_name?: string;
}

export interface SpecData {
  colors: { hex: string; rgba: string; alpha: number; count: number }[];
  gradients: { css: string; count: number }[];
  fonts: { family: string; size: number; weight: number; count: number }[];
  stats: { nodeCount: number; imageFillCount: number };
}
