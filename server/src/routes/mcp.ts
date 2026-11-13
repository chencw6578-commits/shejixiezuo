/**
 * MCP HTTP 传输（Streamable HTTP 简化实现：JSON 响应模式）。
 *
 * 授权：与 Figma 插件共用同一套 import_tokens。
 *   - 无 Authorization：本地开发全开（ctx = 全部）
 *   - Bearer === 环境变量 MCP_TOKEN：管理员全开
 *   - Bearer 匹配 import_tokens（仅存哈希）：按令牌 scope 收敛到团队
 *   - Bearer 非法：返回 401
 * 这样 AI 编码工具只能读到该用户/团队的设计稿，而不是全库。
 *
 * AI 工具接入：
 *   url: <服务地址>/mcp
 *   header: Authorization: Bearer <导入令牌>
 */
import { Router, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { handleRpcMessage, SERVER_INFO } from '../mcp/handler.js';
import type { McpCtx } from '../mcp/tools.js';
import { pool } from '../db.js';

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export const mcpRouter = Router();

interface CtxResult {
  ctx: McpCtx;
  ok: boolean;
}

/** 从 Authorization 头解析 MCP 上下文（授权范围）。 */
async function resolveCtx(req: Request): Promise<CtxResult> {
  const header = (req.headers.authorization ?? '').trim();
  const m = /^Bearer\s+(.+)$/i.exec(header);
  // 无令牌：本地开发放开（与改动前行为一致）
  if (!m) return { ctx: { teamId: null, scope: 'all' }, ok: true };
  const bearer = m[1];

  // 可选的管理员全开令牌（环境变量）
  const envToken = process.env.MCP_TOKEN;
  if (envToken && bearer === envToken) {
    return { ctx: { teamId: null, scope: 'all' }, ok: true };
  }

  // 校验导入令牌（与 Figma 插件同一张表）
  const { rows } = await pool.query<{ scope: string; team_id: string }>(
    `SELECT it.scope, t.id AS team_id
     FROM import_tokens it JOIN teams t ON t.id = it.team_id
     WHERE it.hash = $1 AND it.revoked_at IS NULL`,
    [hashToken(bearer)]
  );
  if (!rows[0]) return { ctx: { teamId: null, scope: 'all' }, ok: false };
  await pool.query('UPDATE import_tokens SET last_used_at = now() WHERE hash = $1', [hashToken(bearer)]);
  return {
    ctx: { teamId: rows[0].team_id, scope: rows[0].scope === 'all' ? 'all' : 'team' },
    ok: true,
  };
}

mcpRouter.get('/mcp', (_req, res) => {
  res.json({
    server: SERVER_INFO.name,
    version: SERVER_INFO.version,
    transport: 'streamable-http (JSON response mode)',
    usage: 'POST JSON-RPC 2.0 messages here; methods: initialize, tools/list, tools/call',
    auth: 'Authorization: Bearer <导入令牌>（与 Figma 插件同一套 import_tokens）',
  });
});

mcpRouter.post('/mcp', async (req: Request, res: Response) => {
  const { ctx, ok } = await resolveCtx(req);
  if (!ok) {
    res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } });
    return;
  }
  const body = req.body as
    | { jsonrpc?: string; method?: string }
    | Array<Record<string, unknown>>
    | undefined;
  if (!body) {
    res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const msg of messages) {
    const r = await handleRpcMessage(msg as Parameters<typeof handleRpcMessage>[0], ctx);
    if (r) responses.push(r);
  }
  if (responses.length === 0) {
    res.status(202).json({ jsonrpc: '2.0', id: null, result: {} }); // 通知
    return;
  }
  res.json(Array.isArray(body) ? responses : responses[0]);
});
