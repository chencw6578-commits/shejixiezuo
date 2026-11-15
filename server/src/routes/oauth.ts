/**
 * MCP OAuth 2.1 授权服务（MCP 规范 2025-06-18；RFC 8414 / 9728 / 7591 / 8707）。
 *
 * 目的：让 AI 客户端的 MCP 配置里只写一个 url，令牌由客户端自动完成授权获取，
 * 用户不必手动复制粘贴。注意「配置里没有令牌」不等于「请求没有令牌」——
 * 规范明确要求每个 HTTP 请求都带 Authorization: Bearer <access-token>。
 *
 * 与既有鉴权的关系：
 *   - 本模块签发的 dhat_ 令牌只写 oauth_access_tokens，供 /mcp 校验；
 *     不写 import_tokens，因此无法调用 /api/plugin/* 的上传接口（只读隔离）。
 *   - /mcp 仍接受旧的 imp_ 导入令牌与 MCP_TOKEN，保证已发出的配置不失效。
 *   - 登录态复用网站自己的 dh_session cookie（getSessionUser），不另造账号体系。
 *
 * 路由挂载：本地常驻 app.use(oauthRouter) 直接暴露 /.well-known/*、/authorize 等；
 * Vercel 由 vercel.json 把这些外部路径 rewrite 到 /api/oauth/*，故同时挂在 /api/oauth。
 */
import express, { Router, type Request, type Response } from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { pool } from '../db.js';
import { getSessionUser, sessionSecret, type SessionUser } from '../auth.js';

export const oauthRouter = Router();

const ACCESS_TTL_MS = 30 * 86400_000;
const REFRESH_TTL_MS = 90 * 86400_000;
const CODE_TTL_MS = 10 * 60_000;
const CONSENT_TTL_MS = 10 * 60_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const randomToken = (prefix: string) => prefix + randomBytes(32).toString('base64url');
const esc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const field = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 公开基址按请求 host 推导：metadata、issuer、resource 与客户端实际访问的域名一致。 */
export function publicOrigin(req: Request): string {
  const proto = (req.header('x-forwarded-proto') ?? req.protocol ?? 'https').split(',')[0].trim();
  const host = (req.header('x-forwarded-host') ?? req.header('host') ?? '').trim();
  return `${proto}://${host}`;
}

/** RFC 8707 canonical resource：授权与令牌请求都必须指向这个 URI。 */
export function canonicalResource(req: Request): string {
  return `${publicOrigin(req)}/mcp`;
}

function appendParams(base: string, params: Record<string, string>): string {
  const sep = base.includes('?') ? '&' : '?';
  return base + sep + new URLSearchParams(params).toString();
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------- 通用中间件 ----------

/**
 * 本 router 同时挂在根路径（本地常驻）和 /api/oauth（Vercel rewrite），
 * 根挂载会让 middleware 经过所有请求。必须只在本模块负责的端点上生效，
 * 否则会截断 /api/* 的 OPTIONS 预检（例如 Figma 插件上传的 CORS 预检）。
 */
const OAUTH_PATH_RE =
  /^(?:\/api\/oauth)?\/(?:\.well-known\/oauth-(?:protected-resource(?:\/mcp)?|authorization-server)|authorize|token|register|revoke|decision|prm|asm)$/;
const urlencoded = express.urlencoded({ extended: false });

oauthRouter.use((req, res, next) => {
  if (!OAUTH_PATH_RE.test(req.path)) {
    next();
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  urlencoded(req, res, next);
});

// ---------- 元数据（RFC 9728 / RFC 8414） ----------

function protectedResourceMetadata(req: Request, res: Response) {
  const origin = publicOrigin(req);
  res.json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ['mcp:read'],
    bearer_methods_supported: ['header'],
  });
}

function authorizationServerMetadata(req: Request, res: Response) {
  const origin = publicOrigin(req);
  res.json({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    revocation_endpoint: `${origin}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp:read'],
  });
}

// 外部标准路径（本地常驻 + Vercel 客户端访问）
oauthRouter.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
oauthRouter.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata);
oauthRouter.get('/.well-known/oauth-authorization-server', authorizationServerMetadata);
// Vercel rewrite 后的内部路径（catch.mjs 会把 __vp=oauth/prm 还原成 /api/oauth/prm）
oauthRouter.get('/prm', protectedResourceMetadata);
oauthRouter.get('/asm', authorizationServerMetadata);

// ---------- 动态客户端注册（RFC 7591） ----------

/** 允许 https、localhost 回环与桌面客户端自定义 scheme；拒绝 javascript:/data:/file: */
export function isSafeRedirectUri(uri: string): boolean {
  if (!uri || uri.length > 500 || /\s/.test(uri)) return false;
  try {
    const u = new URL(uri);
    const p = u.protocol.toLowerCase();
    if (p === 'javascript:' || p === 'data:' || p === 'file:') return false;
    if (p === 'http:') {
      const h = u.hostname.toLowerCase();
      return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
    }
    if (p === 'https:') return true;
    // cursor:// / vscode:// / workbuddy:// 等原生客户端回调
    return /^[a-z][a-z0-9+.-]*:$/.test(p) && u.hostname.length > 0;
  } catch {
    return false;
  }
}

oauthRouter.post('/register', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const uris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.map((x) => field(x)).filter(isSafeRedirectUri)
    : [];
  if (!uris.length) {
    res.status(400).json({
      error: 'invalid_redirect_uri',
      error_description: 'redirect_uris 至少需要一个合法的 https、localhost 或自定义 scheme 回调地址',
    });
    return;
  }
  const clientId = randomToken('dhc_');
  const clientName = (field(body.client_name) || 'MCP 客户端').slice(0, 120);
  await pool.query(
    'INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)',
    [clientId, clientName, JSON.stringify(uris)]
  );
  res.status(201).json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: clientName,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
});

// ---------- 授权端点 ----------

interface AuthParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  resource: string;
  scope: string;
}

function readAuthParams(req: Request): AuthParams {
  const q = req.query as Record<string, unknown>;
  return {
    response_type: field(q.response_type),
    client_id: field(q.client_id),
    redirect_uri: field(q.redirect_uri),
    state: field(q.state),
    code_challenge: field(q.code_challenge),
    code_challenge_method: field(q.code_challenge_method) || 'S256',
    resource: field(q.resource),
    scope: field(q.scope),
  };
}

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

async function findClient(clientId: string): Promise<ClientRow | null> {
  if (!clientId) return null;
  const { rows } = await pool.query<ClientRow>(
    'SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = $1',
    [clientId]
  );
  return rows[0] ?? null;
}

async function listUserTeams(user: SessionUser): Promise<{ id: string; name: string }[]> {
  try {
    const { rows } = await pool.query<{ id: string; name: string }>(
      `SELECT DISTINCT t.id, t.name FROM teams t
       LEFT JOIN team_members tm ON tm.team_id = t.id
       WHERE t.owner_id = $1 OR (tm.email IS NOT NULL AND lower(tm.email) = lower($2))
       ORDER BY t.name`,
      [user.uid, user.email]
    );
    return rows;
  } catch (err) {
    console.error('[oauth] listUserTeams failed:', err);
    return [];
  }
}

async function userInTeam(user: SessionUser, teamId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM teams t
     LEFT JOIN team_members tm ON tm.team_id = t.id
     WHERE t.id = $1 AND (t.owner_id = $2 OR lower(coalesce(tm.email, '')) = lower($3))
     LIMIT 1`,
    [teamId, user.uid, user.email]
  );
  return Boolean(rowCount);
}

/** 同意页上下文：把已校验的授权参数签进隐藏字段，decision 时无需再信任客户端传参。 */
interface ConsentCtx {
  p: AuthParams;
  uid: string;
  exp: number;
}

function signCtx(raw: string): string {
  return createHmac('sha256', sessionSecret()).update('oauth-consent:' + raw).digest('base64url');
}

function verifyCtx(raw: string, sig: string): ConsentCtx | null {
  if (!raw || !sig || !safeEqual(sig, signCtx(raw))) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as ConsentCtx;
    if (!c?.p?.client_id || !c?.uid || !c?.exp || c.exp < Date.now()) return null;
    return c;
  } catch {
    return null;
  }
}

/** 导出供离线渲染预览使用：同意页 HTML 由本函数真实产出，不需要数据库。 */
export function renderConsent(
  res: Response,
  p: AuthParams,
  user: SessionUser,
  clientName: string,
  teams: { id: string; name: string }[],
  rawCtx: string,
  csrf: string
) {
  const teamOptions = teams.length
    ? `<div class="field"><label for="team">授权给哪个团队</label>
         <select id="team" name="team_id" required>
           ${teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}
         </select>
         <p class="hint">令牌只能读取这个团队的设计稿，且不能用于 Figma 插件上传。</p>
       </div>`
    : `<div class="warn">你的账号还没有加入任何团队。请先在网站里新建或加入团队，再回来授权。</div>`;
  const allowButton = teams.length
    ? `<button type="submit" name="decision" value="allow" class="primary">允许并连接</button>`
    : '';
  res.type('html').send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>授权 MCP 客户端 · 设计协作</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f6f8;color:#1f2329;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{width:100%;max-width:460px;background:#fff;border:1px solid #e8eaed;border-radius:14px;padding:28px}
.brand{font-size:12px;color:#6b7280;letter-spacing:.08em;margin-bottom:14px}
h1{font-size:19px;font-weight:600;margin:0 0 8px}
.sub{font-size:13px;color:#5f6368;margin:0 0 20px}
.row{display:flex;justify-content:space-between;gap:12px;border-top:1px solid #f0f1f3;padding:10px 0;font-size:13px}
.row span{color:#6b7280}.row b{font-weight:500;text-align:right;word-break:break-all}
.field{margin-top:20px}label{display:block;font-size:13px;margin-bottom:8px}
select{width:100%;padding:9px 10px;border:1px solid #d8dce3;border-radius:8px;background:#fff;font:inherit}
.hint{font-size:12px;color:#6b7280;margin:8px 0 0}
.warn{background:#fff7e6;border:1px solid #f5d9a0;color:#7a5310;border-radius:8px;padding:12px;font-size:13px;margin-top:18px}
.btns{display:flex;gap:10px;justify-content:flex-end;margin-top:24px}
button{font:inherit;padding:9px 18px;border-radius:8px;cursor:pointer;border:1px solid #d8dce3}
.ghost{background:#fff;color:#3c4043}.primary{background:#2563eb;border-color:#2563eb;color:#fff}
</style></head><body>
<div class="card">
  <div class="brand">设计协作 · MCP 授权</div>
  <h1>授权「${esc(clientName)}」读取设计稿</h1>
  <p class="sub">该客户端将通过 MCP 读取图层规格与 CSS。<b>只可读取</b>，不能上传或修改设计稿。</p>
  <div class="row"><span>当前登录账号</span><b>${esc(user.email)}</b></div>
  <div class="row"><span>请求范围</span><b>mcp:read（只读）</b></div>
  <form method="post" action="/api/oauth/decision">
    <input type="hidden" name="ctx" value="${esc(rawCtx)}">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    ${teamOptions}
    <div class="btns">
      <button type="submit" name="decision" value="deny" class="ghost">拒绝</button>
      ${allowButton}
    </div>
  </form>
</div></body></html>`);
}

oauthRouter.get('/authorize', async (req, res) => {
  const p = readAuthParams(req);
  if (p.response_type !== 'code') {
    res.status(400).json({ error: 'unsupported_response_type' });
    return;
  }
  const client = await findClient(p.client_id);
  if (!client || !client.redirect_uris.includes(p.redirect_uri)) {
    res.status(400).json({ error: 'invalid_request', error_description: 'client_id 或 redirect_uri 未注册' });
    return;
  }
  if (p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge)) {
    res.redirect(302, appendParams(p.redirect_uri, {
      error: 'invalid_request', error_description: 'PKCE S256 必填', state: p.state,
    }));
    return;
  }
  if (p.resource !== canonicalResource(req)) {
    res.redirect(302, appendParams(p.redirect_uri, {
      error: 'invalid_target', error_description: 'resource 必须指向本站 /mcp', state: p.state,
    }));
    return;
  }

  const user = getSessionUser(req);
  if (!user) {
    const next = appendParams('/authorize', {
      response_type: p.response_type,
      client_id: p.client_id,
      redirect_uri: p.redirect_uri,
      state: p.state,
      code_challenge: p.code_challenge,
      code_challenge_method: p.code_challenge_method,
      resource: p.resource,
      scope: p.scope,
    });
    res.redirect(302, `/login?next=${encodeURIComponent(next)}`);
    return;
  }

  const teams = await listUserTeams(user);
  const consent: ConsentCtx = { p, uid: user.uid, exp: Date.now() + CONSENT_TTL_MS };
  const rawCtx = b64u(JSON.stringify(consent));
  renderConsent(res, p, user, client.client_name || 'MCP 客户端', teams, rawCtx, signCtx(rawCtx));
});

oauthRouter.post('/decision', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawCtx = field(body.ctx);
  const ctx = verifyCtx(rawCtx, field(body.csrf));
  if (!ctx) {
    res.status(400).json({ error: 'invalid_request', error_description: '授权上下文无效或已过期，请重新发起连接' });
    return;
  }
  const user = getSessionUser(req);
  if (!user || user.uid !== ctx.uid) {
    res.status(401).json({ error: 'access_denied', error_description: '登录状态已变化，请重新发起连接' });
    return;
  }
  const client = await findClient(ctx.p.client_id);
  if (!client || !client.redirect_uris.includes(ctx.p.redirect_uri)) {
    res.status(400).json({ error: 'invalid_client' });
    return;
  }
  if (field(body.decision) !== 'allow') {
    res.redirect(302, appendParams(ctx.p.redirect_uri, { error: 'access_denied', state: ctx.p.state }));
    return;
  }
  const teamId = field(body.team_id);
  if (!(await userInTeam(user, teamId))) {
    res.redirect(302, appendParams(ctx.p.redirect_uri, { error: 'access_denied', state: ctx.p.state }));
    return;
  }
  const code = randomToken('dhcode_');
  await pool.query(
    `INSERT INTO oauth_auth_codes
       (code_hash, client_id, redirect_uri, code_challenge, code_challenge_method,
        resource, uid, team_id, scope, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'team', now() + ($9 || ' milliseconds')::interval)`,
    [
      sha256(code), ctx.p.client_id, ctx.p.redirect_uri, ctx.p.code_challenge,
      ctx.p.code_challenge_method, ctx.p.resource, user.uid, teamId, String(CODE_TTL_MS),
    ]
  );
  res.redirect(302, appendParams(ctx.p.redirect_uri, { code, state: ctx.p.state }));
});

// ---------- 令牌端点 ----------

interface IssuedToken {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function issueTokens(clientId: string, uid: string, teamId: string, resource: string): Promise<IssuedToken> {
  const access = randomToken('dhat_');
  const refresh = randomToken('dhrt_');
  await pool.query(
    `INSERT INTO oauth_access_tokens
       (token_hash, refresh_hash, client_id, uid, team_id, scope, resource,
        expires_at, refresh_expires_at)
     VALUES ($1,$2,$3,$4,$5,'team',$6,
             now() + ($7 || ' milliseconds')::interval,
             now() + ($8 || ' milliseconds')::interval)`,
    [
      sha256(access), sha256(refresh), clientId, uid, teamId, resource,
      String(ACCESS_TTL_MS), String(REFRESH_TTL_MS),
    ]
  );
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refresh,
    scope: 'mcp:read',
  };
}

function tokenError(res: Response, error: string, description: string) {
  res.status(400).json({ error, error_description: description });
}

oauthRouter.post('/token', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const grantType = field(body.grant_type);
  const clientId = field(body.client_id);
  const resource = field(body.resource) || canonicalResource(req);

  if (resource !== canonicalResource(req)) {
    tokenError(res, 'invalid_target', 'resource 必须指向本站 /mcp');
    return;
  }

  if (grantType === 'authorization_code') {
    const code = field(body.code);
    const verifier = field(body.code_verifier);
    const redirectUri = field(body.redirect_uri);
    if (!code || !verifier || !clientId) {
      tokenError(res, 'invalid_request', 'code / code_verifier / client_id 必填');
      return;
    }
    // 原子占用：并发重放同一 code 只有一次能成功
    const { rows } = await pool.query<{
      team_id: string;
      uid: string;
      code_challenge: string;
      redirect_uri: string;
      client_id: string;
      resource: string;
    }>(
      `UPDATE oauth_auth_codes SET used_at = now()
       WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING team_id, uid, code_challenge, redirect_uri, client_id, resource`,
      [sha256(code)]
    );
    const row = rows[0];
    if (!row) {
      tokenError(res, 'invalid_grant', '授权码无效、已使用或已过期');
      return;
    }
    const computed = createHash('sha256').update(verifier).digest('base64url');
    if (
      !safeEqual(computed, row.code_challenge) ||
      row.redirect_uri !== redirectUri ||
      row.client_id !== clientId ||
      row.resource !== resource
    ) {
      tokenError(res, 'invalid_grant', 'PKCE / client_id / redirect_uri / resource 校验失败');
      return;
    }
    const tokens = await issueTokens(clientId, row.uid, row.team_id, resource);
    res.json(tokens);
    return;
  }

  if (grantType === 'refresh_token') {
    const refresh = field(body.refresh_token);
    if (!refresh || !clientId) {
      tokenError(res, 'invalid_request', 'refresh_token / client_id 必填');
      return;
    }
    const { rows } = await pool.query<{ uid: string; team_id: string; client_id: string; resource: string }>(
      `UPDATE oauth_access_tokens SET refresh_hash = NULL
       WHERE refresh_hash = $1 AND revoked_at IS NULL
         AND refresh_expires_at > now()
       RETURNING uid, team_id, client_id, resource`,
      [sha256(refresh)]
    );
    const row = rows[0];
    if (!row || row.client_id !== clientId || row.resource !== resource) {
      tokenError(res, 'invalid_grant', 'refresh token 无效、已轮换或 resource 不匹配');
      return;
    }
    const tokens = await issueTokens(row.client_id, row.uid, row.team_id, resource);
    res.json(tokens);
    return;
  }

  tokenError(res, 'unsupported_grant_type', '仅支持 authorization_code 与 refresh_token');
});

// ---------- 撤销（RFC 7009） ----------

oauthRouter.post('/revoke', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = field(body.token);
  if (!token) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  await pool.query(
    `UPDATE oauth_access_tokens SET revoked_at = now(), refresh_hash = NULL
     WHERE token_hash = $1 OR refresh_hash = $1`,
    [sha256(token)]
  );
  res.json({ ok: true });
});
