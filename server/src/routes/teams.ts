import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db.js';
import { editGuard } from './authz.js';

export const teamsRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 令牌只在服务端存 sha256，明文仅创建时返回一次 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 创建团队 */
teamsRouter.post('/', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: '请输入团队名称' });
  if (name.length > 60) return res.status(400).json({ error: '团队名称过长（最多 60 字）' });
  const { rows } = await pool.query(
    `INSERT INTO teams (name) VALUES ($1) RETURNING id, name, created_at`,
    [name]
  );
  res.json(rows[0]);
});

/** 团队列表（含项目数） */
teamsRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.created_at,
            count(p.id) AS project_count
     FROM teams t
     LEFT JOIN projects p ON p.team_id = t.id
     GROUP BY t.id
     ORDER BY t.created_at DESC
     LIMIT 200`
  );
  res.json(rows);
});

/** 删除团队（项目与设计稿级联删除） */
teamsRouter.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM teams WHERE id = $1', [req.params.id]);
  res.json({ deleted: rowCount === 1 });
});

/** 团队成员列表 */
teamsRouter.get('/:id/members', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, team_id, name, email, role, created_at FROM team_members
     WHERE team_id = $1 ORDER BY created_at DESC LIMIT 500`,
    [req.params.id]
  );
  res.json(rows);
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = new Set(['admin', 'collaborator']);

/** 邮箱邀请成员（role: admin=管理员可编辑可删除 / collaborator=协作者只读） */
teamsRouter.post('/:id/members', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const role = req.body?.role === 'collaborator' ? 'collaborator' : 'admin';
  if (!email) return res.status(400).json({ error: '请输入成员邮箱' });
  if (!EMAIL_RE.test(email) || email.length > 120) return res.status(400).json({ error: '邮箱格式不正确' });
  const t = await pool.query('SELECT 1 FROM teams WHERE id = $1', [req.params.id]);
  if (!t.rows[0]) return res.status(404).json({ error: '团队不存在' });
  const dup = await pool.query('SELECT 1 FROM team_members WHERE team_id = $1 AND email = $2', [req.params.id, email]);
  if (dup.rows[0]) return res.status(409).json({ error: '该邮箱已在团队中' });
  const name = email.split('@')[0].slice(0, 30);
  const { rows } = await pool.query(
    `INSERT INTO team_members (team_id, name, email, role) VALUES ($1, $2, $3, $4)
     RETURNING id, team_id, name, email, role, created_at`,
    [req.params.id, name, email, role]
  );
  res.json(rows[0]);
});

/** 修改成员角色 */
teamsRouter.patch('/:id/members/:memberId', async (req, res) => {
  const role = typeof req.body?.role === 'string' ? req.body.role : '';
  if (!ROLES.has(role)) return res.status(400).json({ error: "role 必须是 'admin' 或 'collaborator'" });
  const { rows } = await pool.query(
    `UPDATE team_members SET role = $3 WHERE id = $1 AND team_id = $2
     RETURNING id, team_id, name, email, role, created_at`,
    [req.params.memberId, req.params.id, role]
  );
  if (!rows[0]) return res.status(404).json({ error: '成员不存在' });
  res.json(rows[0]);
});

/** 移除团队成员 */
teamsRouter.delete('/:id/members/:memberId', async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM team_members WHERE id = $1 AND team_id = $2',
    [req.params.memberId, req.params.id]
  );
  res.json({ deleted: rowCount === 1 });
});

// ---------- 团队级「导入令牌」（Figma 插件用） ----------

/** 令牌列表：只返回前缀与时间，不返回明文/哈希 */
teamsRouter.get('/:id/import-tokens', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: '非法的团队 ID' });
  const denied = await editGuard(req.params.id, req);
  if (denied) return res.status(403).json({ error: denied });
  const t = await pool.query('SELECT 1 FROM teams WHERE id = $1', [req.params.id]);
  if (!t.rows[0]) return res.status(404).json({ error: '团队不存在' });
  const { rows } = await pool.query(
    `SELECT id, prefix, created_at, last_used_at, revoked_at
     FROM import_tokens WHERE team_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.params.id]
  );
  res.json(rows);
});

/** 生成令牌：明文只在这次响应里出现，之后服务端只有哈希 */
teamsRouter.post('/:id/import-tokens', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: '非法的团队 ID' });
  const denied = await editGuard(req.params.id, req);
  if (denied) return res.status(403).json({ error: denied });
  const t = await pool.query('SELECT 1 FROM teams WHERE id = $1', [req.params.id]);
  if (!t.rows[0]) return res.status(404).json({ error: '团队不存在' });
  const active = await pool.query(
    'SELECT count(*)::int AS n FROM import_tokens WHERE team_id = $1 AND revoked_at IS NULL',
    [req.params.id]
  );
  if (active.rows[0].n >= 10) {
    return res.status(400).json({ error: '该团队已有 10 个未撤销的导入令牌，请先撤销不用的再生成' });
  }
  const token = `imp_${randomBytes(24).toString('base64url')}`;
  const { rows } = await pool.query(
    `INSERT INTO import_tokens (team_id, hash, prefix) VALUES ($1, $2, $3)
     RETURNING id, prefix, created_at`,
    [req.params.id, hashToken(token), token.slice(0, 12)]
  );
  res.status(201).json({ ...rows[0], token });
});

/** 撤销令牌（立即生效，插件再用会返回 401） */
teamsRouter.delete('/:id/import-tokens/:tokenId', async (req, res) => {
  if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.tokenId)) {
    return res.status(400).json({ error: '非法的 ID 格式' });
  }
  const denied = await editGuard(req.params.id, req);
  if (denied) return res.status(403).json({ error: denied });
  const { rows } = await pool.query(
    `UPDATE import_tokens SET revoked_at = now()
     WHERE id = $1 AND team_id = $2 AND revoked_at IS NULL
     RETURNING id, revoked_at`,
    [req.params.tokenId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: '令牌不存在或已撤销' });
  res.json({ revoked: true, id: rows[0].id, revoked_at: rows[0].revoked_at });
});
