import { Router } from 'express';
import { pool } from '../db.js';
import {
  clearSessionCookie,
  getSessionUser,
  hashPassword,
  setSessionCookie,
  verifyPassword,
} from '../auth.js';

export const authRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- 注册 ----------
authRouter.post('/register', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const name = String(req.body?.name ?? '').trim();

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
  res.status(201).json({ id: user.uid, email, name: name || email.split('@')[0] });
});

// ---------- 登录 ----------
authRouter.post('/login', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');

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

// ---------- 退出 ----------
authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ---------- 当前用户 ----------
authRouter.get('/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  res.json(user);
});
