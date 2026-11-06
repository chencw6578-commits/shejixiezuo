import { Router } from 'express';
import { pool } from '../db.js';

export const teamsRouter = Router();

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
