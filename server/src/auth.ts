import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * 邮箱注册登录的最小认证实现：
 * - 密码：scrypt + 随机盐，存 `scrypt:salt:hash`
 * - 会话：HMAC 签名的无状态 token，HttpOnly cookie（30 天）
 */

const DEV_SECRET = 'designhub-dev-secret';

/**
 * 会话签名与公开分享链接 HMAC 共用的密钥。
 *
 * 生产环境（Vercel 或 NODE_ENV=production）缺少 AUTH_SECRET 时立即抛错，
 * 绝不使用可猜测的默认密钥——否则任何人都能伪造管理员会话或分享链接。
 * 校验发生在模块加载时（import 即 fail fast），避免"带病启动"后部分接口可用。
 * 本地开发允许缺省以便开箱即用，但打印一次性警告。
 */
function resolveSecret(): string {
  const v = process.env.AUTH_SECRET?.trim();
  if (v) return v;
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
    throw new Error(
      'AUTH_SECRET is required in production/Vercel. '
      + 'Generate one with `openssl rand -hex 32` and set it in the deployment environment.'
    );
  }
  console.warn('[auth] AUTH_SECRET 未设置，使用开发默认密钥（仅限本地，切勿用于生产）');
  return DEV_SECRET;
}

const SECRET = resolveSecret();

/** 供其它模块（如公开分享链接 HMAC）复用同一个密钥口径 */
export function sessionSecret(): string {
  return SECRET;
}
export const SESSION_COOKIE = 'dh_session';
const SESSION_DAYS = 30;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export interface SessionUser {
  uid: string;
  email: string;
}

// ---------- 密码 ----------

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const calc = scryptSync(password, salt, 64);
  const expect = Buffer.from(hash, 'hex');
  return calc.length === expect.length && timingSafeEqual(calc, expect);
}

// ---------- 会话 token ----------

const b64u = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export function signToken(user: SessionUser): string {
  const payload = {
    ...user,
    exp: Date.now() + SESSION_DAYS * 86400_000,
  };
  const body = b64u(JSON.stringify(payload));
  const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token: string): SessionUser | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expect = createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionUser & { exp: number };
    if (!payload.exp || payload.exp < Date.now()) return null;
    return { uid: payload.uid, email: payload.email };
  } catch {
    return null;
  }
}

// ---------- cookie ----------

function readCookies(req: Request): Record<string, string> {
  const header = req.header('cookie') ?? '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** 从会话 cookie 解析当前登录用户；未登录返回 null */
export function getSessionUser(req: Request): SessionUser | null {
  const token = readCookies(req)[SESSION_COOKIE];
  return token ? verifyToken(token) : null;
}

export function setSessionCookie(res: Response, user: SessionUser) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(signToken(user))}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax`
  );
}

export function clearSessionCookie(res: Response) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

/** 登录校验中间件：未登录返回 401 */
export function requireUser(req: Request, res: Response, next: NextFunction) {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: '请先登录' });
    return;
  }
  req.user = user;
  next();
}
