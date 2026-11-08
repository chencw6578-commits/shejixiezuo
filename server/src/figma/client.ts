import { config } from '../config.js';

const API = 'https://api.figma.com/v1';
/** 元数据类请求（文件信息、浅层页面结构）：响应小，20s 足够 */
const META_TIMEOUT_MS = 20_000;
/** 节点子树 / 渲染导出：大画板可能很慢，单独给 60s */
const NODE_TIMEOUT_MS = 60_000;

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

/** 按节点取子树：GET /v1/files/:key/nodes 的响应 */
export interface NodesResponse {
  name?: string;
  version?: string;
  lastModified?: string;
  nodes: Record<string, { document: FigmaNode } | null>;
}

/** Figma REST 错误：只保留状态码与简述，不带响应体（避免把令牌等内容抛给调用方/日志） */
export class FigmaApiError extends Error {
  status: number;
  /** Figma 返回的具体原因（用于区分「令牌无效 / 权限不足 / 文件不可见」） */
  detail: string;
  /** 429 时 Figma 给出的建议等待秒数（可能很大） */
  retryAfterSeconds: number;
  constructor(status: number, message: string, detail = '', retryAfterSeconds = 0) {
    super(message);
    this.name = 'FigmaApiError';
    this.status = status;
    this.detail = detail;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 是否为 AbortSignal.timeout 触发的超时（Node 18+ 抛 DOMException/TimeoutError） */
function isTimeoutError(err: unknown): boolean {
  const e = err as { name?: string } | null;
  return e?.name === 'TimeoutError' || e?.name === 'AbortError';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 令牌只经请求头使用；缺失时直接报 401，避免带着空头请求 Figma。 */
function resolveToken(token?: string): string {
  const t = (token ?? config.figmaToken ?? '').trim();
  if (!t) throw new FigmaApiError(401, '未配置 Figma 令牌');
  return t;
}

interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
}

async function figmaFetch<T>(path: string, token?: string, opts: FetchOptions = {}): Promise<T> {
  const auth = resolveToken(token);
  const timeoutMs = opts.timeoutMs ?? META_TIMEOUT_MS;
  const retries = opts.retries ?? 1;
  const shortPath = path.length > 140 ? `${path.slice(0, 140)}…` : path;
  let lastErr: FigmaApiError | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const startedAt = Date.now();
    let res: globalThis.Response;
    try {
      res = await fetch(`${API}${path}`, {
        headers: { 'X-Figma-Token': auth },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (isTimeoutError(err)) {
        console.warn(`[figma] GET ${shortPath} timeout=${timeoutMs}ms elapsed=${Date.now() - startedAt}ms`);
        throw new FigmaApiError(504, `Figma 响应超时（${Math.round(timeoutMs / 1000)}s）`);
      }
      throw err;
    }
    // 只记录端点/状态码/耗时，从不记录令牌或响应体
    console.log(`[figma] GET ${shortPath} status=${res.status} elapsed=${Date.now() - startedAt}ms attempt=${attempt + 1}`);
    const retryAfter = Number(res.headers.get('retry-after') ?? 0);
    // 5xx / 429 重试一次（单次请求受 timeoutMs 控制）
    if (res.status === 429 || res.status >= 500) {
      lastErr = new FigmaApiError(res.status, `Figma API ${res.status}`, '', retryAfter);
      if (attempt < retries) {
        const delay = retryAfter > 0 ? retryAfter * 1000 : 1500 * (attempt + 1);
        await sleep(Math.min(delay, 5000));
        continue;
      }
    }
    if (!res.ok) {
      // 读取 body 里的原因，用于区分「令牌无效 / scope 不足 / 文件不可见」
      // 注意：body 只用于分类，不会原样返回给前端（避免泄漏服务端细节）
      let detail = '';
      let errorStatus = res.status;
      try {
        const text = await res.text();
        const parsed = JSON.parse(text) as { status?: number; err?: string; message?: string };
        if (typeof parsed.status === 'number' && parsed.status >= 400) errorStatus = parsed.status;
        detail = String(parsed.err ?? parsed.message ?? '');
      } catch {
        /* ignore */
      }
      throw new FigmaApiError(errorStatus, `Figma API ${errorStatus}`, detail, retryAfter);
    }
    return (await res.json()) as T;
  }
  throw lastErr ?? new FigmaApiError(502, 'Figma API 请求失败');
}

/** 拉取完整文件 JSON（节点树）。 */
export function getFile(key: string, token?: string): Promise<FileResponse> {
  return figmaFetch<FileResponse>(`/files/${key}`, token);
}

/** 浅层元信息（name/version），depth 控制返回的节点深度。 */
export function getFileMeta(key: string, token?: string): Promise<Pick<FileResponse, 'name' | 'version'>> {
  return figmaFetch<FileResponse>(`/files/${key}?depth=1`, token);
}

/** 指定深度的文件树（depth=2：页面 + 页面下一层画板）。 */
export function getFileDepth(key: string, depth: number, token?: string): Promise<FileResponse> {
  return figmaFetch<FileResponse>(`/files/${key}?depth=${depth}`, token);
}

/** 只取指定节点的子树：GET /v1/files/:key/nodes?ids=... */
export function getNodes(key: string, ids: string[], token?: string): Promise<NodesResponse> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) throw new FigmaApiError(400, '缺少节点 id');
  return figmaFetch<NodesResponse>(
    `/files/${key}/nodes?ids=${encodeURIComponent(unique.join(','))}`,
    token,
    { timeoutMs: NODE_TIMEOUT_MS }
  );
}

/** 按节点批量导出渲染图，返回 nodeId → 临时下载 URL。 */
export function getImages(
  key: string,
  ids: string[],
  format: 'png' | 'svg' | 'pdf' | 'jpg' = 'png',
  scale = 2,
  token?: string
): Promise<ImagesResponse> {
  const unique = [...new Set(ids)];
  return figmaFetch<ImagesResponse>(
    `/images/${key}?ids=${encodeURIComponent(unique.join(','))}&format=${format}&scale=${scale}`,
    token,
    { timeoutMs: NODE_TIMEOUT_MS }
  );
}

/** 从 Figma 链接中提取 file key。 */
export function parseFileKey(url: string): string | null {
  const m = url.match(/figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

export interface ParsedFigmaUrl {
  key: string;
  /** ?node-id=1-2 → 1:2；无该参数为 null */
  nodeId: string | null;
}

/** 解析 Figma 文件链接：file key + 可选 node id（node-id 的 - 转 :） */
export function parseFigmaUrl(url: string): ParsedFigmaUrl | null {
  const key = parseFileKey(url);
  if (!key) return null;
  let nodeId: string | null = null;
  try {
    const u = new URL(url);
    const raw = u.searchParams.get('node-id');
    if (raw) nodeId = decodeURIComponent(raw).replace(/-/g, ':');
  } catch {
    const m = url.match(/[?&]node-id=([^&#]+)/);
    if (m) nodeId = decodeURIComponent(m[1]).replace(/-/g, ':');
  }
  return { key, nodeId };
}

/** 下载图片字节。 */
export async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(NODE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`下载切图失败 ${res.status}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}
