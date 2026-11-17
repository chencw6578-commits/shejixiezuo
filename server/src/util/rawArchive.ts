import { gzipSync, gunzipSync } from 'node:zlib';

/**
 * design_files.raw 的压缩存档编解码。
 *
 * 背景：raw 保存整份 Figma/Sketch/插件 JSON 快照，是全库最大的单行数据，
 * 但全代码库只写不读（纯保险存档）。JSON 文本 gzip 压缩率通常 70–90%，
 * 直接压缩能把这一项的数据库占用砍掉大半，且读取端无需改动。
 *
 * 存储格式（存进 JSONB 列的是一个 JSON 字符串）：
 *   新格式：以 "GZIP1:" 开头的字符串，后接 gzip(base64(JSON))
 *   旧格式：原始 JSON 对象/数组（历史数据，读时原样返回，向后兼容）
 */
const PREFIX = 'GZIP1:';

/**
 * 把对象编码为可存入 JSONB 列的文本。
 * 注意：pg 会把字符串参数直接交给 Postgres 按 JSON 解析，因此返回值必须是
 * 合法 JSON 文本 —— 这里用 JSON.stringify 包一层，让压缩串成为 JSON string。
 */
export function encodeRaw(raw: unknown): string {
  const json = JSON.stringify(raw ?? {});
  try {
    const gz = gzipSync(Buffer.from(json, 'utf8'), { level: 6 }).toString('base64');
    return JSON.stringify(PREFIX + gz);
  } catch {
    // 理论上不会发生；保底仍存原 JSON 文本，绝不丢数据
    return json;
  }
}

/**
 * 解码存档（供将来需要读取 raw 时使用；当前业务无读取点）。
 * 兼容三种输入：新格式字符串、旧格式 JSON 字符串、旧格式对象。
 */
export function decodeRaw<T = unknown>(stored: unknown): T {
  if (typeof stored === 'string' && stored.startsWith(PREFIX)) {
    try {
      const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
      return JSON.parse(gunzipSync(buf).toString('utf8')) as T;
    } catch {
      return undefined as T;
    }
  }
  if (typeof stored === 'string') {
    try {
      return JSON.parse(stored) as T;
    } catch {
      return stored as T;
    }
  }
  return stored as T;
}
