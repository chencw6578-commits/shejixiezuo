import { config } from '../config.js';

const API = 'https://api.figma.com/v1';

export interface FigmaColor {
  r: number; g: number; b: number; a: number;
}

export interface Rect {
  x: number; y: number; width: number; height: number;
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  absoluteBoundingBox?: Rect;
  absoluteRenderBounds?: Rect | null;
  fills?: unknown[];
  strokes?: unknown[];
  strokeWeight?: number;
  strokeAlign?: string;
  effects?: unknown[];
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  opacity?: number;
  blendMode?: string;
  characters?: string;
  style?: Record<string, unknown>;
  exportSettings?: ExportSetting[];
  [key: string]: unknown;
}

export interface ExportSetting {
  format: 'PNG' | 'SVG' | 'PDF' | 'JPG';
  suffix?: string;
  constraint?: { type: string; value: number };
}

export interface FileResponse {
  name: string;
  version: string;
  document: FigmaNode;
  [key: string]: unknown;
}

export interface ImagesResponse {
  err: string | null;
  images: Record<string, string | null>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function figmaFetch<T>(path: string, retries = 3): Promise<T> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${API}${path}`, {
      headers: { 'X-Figma-Token': config.figmaToken },
    });
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after') ?? 0);
      const delay = retryAfter > 0 ? retryAfter * 1000 : Math.min(2000 * 2 ** attempt, 15000);
      lastErr = new Error(`Figma API ${res.status}: ${await res.text().catch(() => '')}`);
      if (attempt < retries) {
        await sleep(delay);
        continue;
      }
    }
    if (!res.ok) {
      throw new Error(`Figma API ${res.status}: ${await res.text().catch(() => '')}`);
    }
    return (await res.json()) as T;
  }
  throw lastErr ?? new Error('Figma API failed');
}

/** 拉取完整文件 JSON（节点树）。 */
export function getFile(key: string): Promise<FileResponse> {
  return figmaFetch<FileResponse>(`/files/${key}`);
}

/** 浅层元信息（name/version），depth=1 避免拉整棵树。 */
export function getFileMeta(key: string): Promise<Pick<FileResponse, 'name' | 'version'>> {
  return figmaFetch<FileResponse>(`/files/${key}?depth=1`);
}

/** 按节点批量导出渲染图，返回 nodeId → 临时下载 URL。 */
export function getImages(
  key: string,
  ids: string[],
  format: 'png' | 'svg' | 'pdf' | 'jpg' = 'png',
  scale = 2
): Promise<ImagesResponse> {
  const unique = [...new Set(ids)];
  return figmaFetch<ImagesResponse>(
    `/images/${key}?ids=${encodeURIComponent(unique.join(','))}&format=${format}&scale=${scale}`
  );
}

/** 从 Figma 链接中提取 file key。 */
export function parseFileKey(url: string): string | null {
  const m = url.match(/figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

/** 下载图片字节。 */
export async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载切图失败 ${res.status}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}
