import { Router } from 'express';
import { pool } from '../db.js';
import {
  clearSessionCookie,
  getSessionUser,
  hashPassword,
  setSessionCookie,
  verifyPassword,
} from '../auth.js';
import { consumeEmailToken, sendPasswordResetEmail, sendVerificationEmail } from '../email/index.js';

export const authRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- 简易限流（进程内滑动窗口）：IP+邮箱 维度 ----------
const buckets = new Map<string, number[]>();

/** windowMs 内最多 limit 次；超出返回 false */
function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    return false;
  }
  arr.push(now);
  buckets.set(key, arr);
  // 防止 Map 无限增长：超过 1 万个 key 时清理过期项
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) {
      if (v.every((t) => now - t >= windowMs)) buckets.delete(k);
    }
  }
  return true;
}

function clientIp(req: { ip?: string; socket?: { remoteAddress?: string } }): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

// ---------- 注册 ----------
authRouter.post('/register', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const name = String(req.body?.name ?? '').trim();

  if (!rateLimit(`reg:${clientIp(req)}`, 10, 60_000)) {
    return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  }
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
  if (password.length < 8) return res.status(400).json({ error: '密码至少 8 位' });

  const exists = await pool.query('SELECT 1 FROM users WHERE email = $1 LIMIT 1', [email]);
  if (exists.rowCount) return res.status(409).json({ error: '该邮箱已注册，请直接登录' });

  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [email, name || email.split('@')[0], hashPassword(password)]
  );
  const user = { uid: rows[0].id, email };
  setSessionCookie(res, user);
  // 软验证：注册即登录可用，验证邮件异步发送，失败不阻断注册
  sendVerificationEmail(user.uid, email).catch((err) => {
    console.error('[auth] send verification email failed:', err?.message ?? err);
  });
  res.status(201).json({ id: user.uid, email, name: name || email.split('@')[0] });
});

// ---------- 登录 ----------
authRouter.post('/login', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');

  if (!rateLimit(`login:${clientIp(req)}:${email}`, 10, 60_000)) {
    return res.status(429).json({ error: '尝试过于频繁，请一分钟后再试' });
  }

  const { rows } = await pool.query<{ id: string; email: string; name: string; password_hash: string }>(
    'SELECT id, email, name, password_hash FROM users WHERE email = $1 LIMIT 1',
    [email]
  );
  const row = rows[0];
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: '邮箱或密码不正确' });
  }
  const user = { uid: row.id, email: row.email };
  setSessionCookie(res, user);
  res.json({ id: row.id, email: row.email, name: row.name });
});

// ---------- 邮箱验证（邮件链接落地页调用） ----------
authRouter.post('/verify', async (req, res) => {
  const token = String(req.body?.token ?? '').trim();
  if (!token) return res.status(400).json({ error: '缺少验证令牌' });

  try {
    const uid = await consumeEmailToken(token, 'verify');
    if (!uid) return res.status(400).json({ error: '链接无效或已过期，请重新发送验证邮件' });
    await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [uid]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth] verify failed:', err);
    res.status(500).json({ error: '验证失败，请稍后再试' });
  }
});

// ---------- 重发验证邮件（模糊响应，不暴露邮箱是否注册） ----------
authRouter.post('/resend-verification', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  // 登录态下允许不带邮箱；未登录时必须带
  const target = email || getSessionUser(req)?.email || '';
  if (!EMAIL_RE.test(target) || !rateLimit(`resend:${clientIp(req)}:${target}`, 1, 60_000)) {
    // 限流或邮箱非法时也返回成功文案，避免被用来探测
    return res.json({ ok: true });
  }

  const { rows } = await pool.query<{ id: string; verified: boolean }>(
    'SELECT id, verified FROM users WHERE email = $1 LIMIT 1',
    [target]
  );
  const row = rows[0];
  if (row && !row.verified) {
    sendVerificationEmail(row.id, target).catch((err) => {
      console.error('[auth] resend verification email failed:', err?.message ?? err);
    });
  }
  res.json({ ok: true });
});

// ---------- 忘记密码（模糊响应，不暴露邮箱是否注册） ----------
authRouter.post('/forgot-password', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || !rateLimit(`forgot:${clientIp(req)}:${email}`, 1, 60_000)) {
    return res.json({ ok: true });
  }
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE email = $1 LIMIT 1',
    [email]
  );
  if (rows[0]) {
    sendPasswordResetEmail(rows[0].id, email).catch((err) => {
      console.error('[auth] send password reset email failed:', err?.message ?? err);
    });
  }
  res.json({ ok: true });
});

// ---------- 重置密码（邮件链接落地后调用） ----------
authRouter.post('/reset-password', async (req, res) => {
  const token = String(req.body?.token ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!token) return res.status(400).json({ error: '缺少重置令牌' });
  if (password.length < 8) return res.status(400).json({ error: '密码至少 8 位' });

  try {
    const uid = await consumeEmailToken(token, 'reset');
    if (!uid) return res.status(400).json({ error: '链接无效或已过期，请重新发送重置邮件' });
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(password), uid]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth] reset password failed:', err);
    res.status(500).json({ error: '重置失败，请稍后再试' });
  }
});

// ---------- 退出 ----------
authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ---------- 当前用户 ----------
authRouter.get('/me', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  const fallbackName = user.email.split('@')[0];
  try {
    const { rows } = await pool.query<{ name: string | null; verified: boolean }>(
      'SELECT name, verified FROM users WHERE id = $1 LIMIT 1',
      [user.uid]
    );
    res.json({
      id: user.uid,
      email: user.email,
      name: rows[0]?.name || fallbackName,
      verified: rows[0]?.verified ?? false,
    });
  } catch {
    res.json({ id: user.uid, email: user.email, name: fallbackName, verified: false });
  }
});

/** 修改当前账号昵称：users.name 是头像下拉与团队成员列表共用的唯一真源 */
authRouter.patch('/me', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: '请输入昵称' });
  if (name.length > 30) return res.status(400).json({ error: '昵称最多 30 个字符' });
  try {
    const { rows } = await pool.query<{ name: string; verified: boolean }>(
      'UPDATE users SET name = $1 WHERE id = $2 RETURNING name, verified',
      [name, user.uid]
    );
    if (!rows[0]) return res.status(404).json({ error: '账号不存在' });
    res.json({ id: user.uid, email: user.email, name: rows[0].name, verified: rows[0].verified });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '修改昵称失败' });
  }
});
