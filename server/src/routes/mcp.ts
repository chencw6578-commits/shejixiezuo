/**
 * MCP HTTP 传输（Streamable HTTP 简化实现：JSON 响应模式）。
 *
 * 授权（三种凭据并存，按优先级）：
 *   1. dhat_ OAuth 2.1 访问令牌：由 /authorize 授权签发，绑定单个团队且只读，
 *      存 oauth_access_tokens；校验 audience(resource)、过期与撤销。
 *      它不写 import_tokens，因此无法调用 /api/plugin/* 的上传接口。
 *   2. Bearer === 环境变量 MCP_TOKEN：管理员全开（部署级凭据，UI 不引导）
 *   3. Bearer 匹配 import_tokens：与 Figma 插件共用，按 scope 收敛团队（旧配置兼容）
 *   无 Authorization：仅本地开发放行或显式 MCP_ALLOW_ANONYMOUS=1；线上返回 401，
 *   并带 WWW-Authenticate 指向 RFC 9728 protected resource metadata，
 *   让支持 OAuth 的客户端自动发起授权，而不是只报一句「缺令牌」。
 *
 * AI 工具接入：
 *   方式一（推荐）url: <服务地址>/mcp，配置里不写 headers，客户端自动完成授权
 *   方式二（兼容）url + headers: Authorization: Bearer <导入令牌>
 */
import { Router, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { handleRpcMessage, SERVER_INFO } from '../mcp/handler.js';
import type { McpCtx } from '../mcp/tools.js';
import { pool } from '../db.js';
import { canonicalResource, publicOrigin } from './oauth.js';

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
  // 无令牌：只允许本地开发（非 production 且非 Vercel）或显式开关。
  // 线上环境若放开匿名，任何人知道 /mcp URL 就能以 scope=all 读全库设计稿，
  // 因此默认拒绝；/mcp 与 /api/mcp 共用本校验。
  if (!m) {
    const allowAnonymous =
      (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) ||
      process.env.MCP_ALLOW_ANONYMOUS === '1';
    return { ctx: { teamId: null, scope: 'all' }, ok: allowAnonymous };
  }
  const bearer = m[1];

  // 1) OAuth 2.1 访问令牌：只按授权时选定的团队放行，绝不放宽到全库
  if (bearer.startsWith('dhat_')) {
    const { rows } = await pool.query<{ team_id: string }>(
      `SELECT team_id FROM oauth_access_tokens
       WHERE token_hash = $1 AND resource = $2
         AND revoked_at IS NULL AND expires_at > now()`,
      [hashToken(bearer), canonicalResource(req)]
    );
    if (!rows[0]) return { ctx: { teamId: null, scope: 'all' }, ok: false };
    return { ctx: { teamId: rows[0].team_id, scope: 'team' }, ok: true };
  }

  // 2) 可选的管理员全开令牌（环境变量）
  const envToken = process.env.MCP_TOKEN;
  if (envToken && bearer === envToken) {
    return { ctx: { teamId: null, scope: 'all' }, ok: true };
  }

  // 3) 校验导入令牌（与 Figma 插件同一张表，保留已发出配置的兼容性）
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

mcpRouter.get('/mcp', (req, res) => {
  res.json({
    server: SERVER_INFO.name,
    version: SERVER_INFO.version,
    transport: 'streamable-http (JSON response mode)',
    usage: 'POST JSON-RPC 2.0 messages here; methods: initialize, tools/list, tools/call',
    auth: '方式一：OAuth 2.1 授权（配置无需 headers）；方式二：Authorization: Bearer <导入令牌>',
    authorization_servers: [publicOrigin(req)],
    resource_metadata: `${publicOrigin(req)}/.well-known/oauth-protected-resource/mcp`,
  });
});

mcpRouter.post('/mcp', async (req: Request, res: Response) => {
  const { ctx, ok } = await resolveCtx(req);
  if (!ok) {
    // RFC 9728：401 必须告诉客户端去哪里取 protected resource metadata，
    // 支持 OAuth 的 MCP 客户端据此自动发现授权服务并弹出登录/同意页。
    res.setHeader(
      'WWW-Authenticate',
      `Bearer resource_metadata="${publicOrigin(req)}/.well-known/oauth-protected-resource/mcp", scope="mcp:read"`
    );
    res.status(401).json({
      jsonrpc: '2.0', id: null,
      error: { code: -32001, message: 'unauthorized: 需要 OAuth 2.1 授权或 Bearer <导入令牌>' },
    });
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
