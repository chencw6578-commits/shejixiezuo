import type { FigmaNode } from './client.js';
import { parseNodeSubtree, type ParsedFrame } from './parse.js';

/** 当前网站支持的插件导出 schema 版本 */
export const PLUGIN_SCHEMA_VERSION = 1;

/** 可读的校验错误：路由直接返回 400 + message */
export class PluginImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginImportError';
  }
}

export interface PluginImportResult {
  name: string;
  version: string | null;
  frames: ParsedFrame[];
  raw: unknown;
  /** 被跳过的畸形画板数量 */
  skipped: number;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 校验并转换 Figma 插件导出的 JSON（schemaVersion 1）。
 * 复用 REST 导入同一套解析（parseNodeSubtree）：单个畸形画板/节点只跳过，不影响整次导入。
 */
export function parsePluginExport(input: unknown): PluginImportResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PluginImportError('这不是本插件导出的文件：顶层应为 JSON 对象');
  }
  const obj = input as Record<string, unknown>;
  const schemaVersion = obj.schemaVersion;
  if (schemaVersion === undefined || schemaVersion === null) {
    throw new PluginImportError(
      '这不是本插件导出的文件：缺少 schemaVersion（请用 Figma 插件「导出画板 JSON」重新导出）'
    );
  }
  if (Number(schemaVersion) !== PLUGIN_SCHEMA_VERSION) {
    throw new PluginImportError(
      `schema 版本 ${String(schemaVersion)} 不支持：当前网站仅支持版本 ${PLUGIN_SCHEMA_VERSION}，请更新插件后重新导出`
    );
  }

  const artboards = obj.artboards;
  if (!Array.isArray(artboards)) {
    throw new PluginImportError('这不是本插件导出的文件：缺少 artboards 数组');
  }
  if (artboards.length === 0) {
    throw new PluginImportError(
      'JSON 里没有画板：请在 Figma 中选中画板（FRAME / COMPONENT / INSTANCE）后重新导出'
    );
  }

  const file = (obj.file && typeof obj.file === 'object' ? obj.file : {}) as Record<string, unknown>;
  const name = asText(file.name) ?? 'Figma 插件导入';
  const pageName = asText(file.pageName) ?? undefined;
  const version = asText(obj.exportedAt);

  const frames: ParsedFrame[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  artboards.forEach((item, index) => {
    if (typeof item !== 'object' || item === null) {
      skipped++;
      console.warn(`[plugin-import] skip artboard #${index}: not an object`);
      return;
    }
    const node = item as FigmaNode;
    const id = asText(node.id);
    if (!id) {
      skipped++;
      console.warn(`[plugin-import] skip artboard #${index}: missing id`);
      return;
    }
    if (!asText(node.type)) {
      skipped++;
      console.warn(`[plugin-import] skip artboard ${id}: missing type`);
      return;
    }
    try {
      const parsed = parseNodeSubtree(node, pageName ?? asText(node.name) ?? 'Page 1');
      for (const frame of parsed) {
        if (seen.has(frame.nodeId)) {
          console.warn(`[plugin-import] skip duplicate frame ${frame.nodeId}`);
          continue;
        }
        seen.add(frame.nodeId);
        frames.push(frame);
      }
    } catch (err) {
      skipped++;
      console.warn(
        `[plugin-import] skip artboard ${id}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  });

  if (!frames.length) {
    throw new PluginImportError(
      '未找到可导入的画板：选中的节点里没有 FRAME / COMPONENT / INSTANCE 画板'
    );
  }
  frames.forEach((frame, index) => {
    frame.sortOrder = index;
  });

  return { name, version, frames, raw: input, skipped };
}
