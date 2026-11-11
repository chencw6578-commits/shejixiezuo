import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db.js';
import { editGuard, manageGuard, ownerGuard, teamRole } from './authz.js';
import { getSessionUser } from '../auth.js';
import { createTeamInvite } from './invites.js';
import { emailConfig } from '../config.js';

export const teamsRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 令牌只在服务端存 sha256，明文仅创建时返回一次 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 创建团队（需登录；建团队者自动成为所有者并写入成员表） */
teamsRouter.post('/', async (req, res) => {
  const session = getSessionUser(req);
  if (!session) return res.status(401).json({ error: '请先登录后再创建团队' });
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: '请输入团队名称' });
  if (name.length > 60) return res.status(400).json({ error: '团队名称过长（最多 60 字）' });
  const t = await pool.query(
    `INSERT INTO teams (name, owner_id) VALUES ($1, $2) RETURNING id, name, created_at`,
    [name, session.uid]
  );
  const team = t.rows[0];
  await pool.query(
    `INSERT INTO team_members (team_id, name, email, role) VALUES ($1, $2, $3, 'owner')`,
    [team.id, session.email.split('@')[0].slice(0, 30) || '所有者', session.email]
  );
  res.json(team);
});

/** 团队列表（含项目数 + 当前登录用户在该团队的角色，未登录时 my_role 为 null） */
teamsRouter.get('/', async (req, res) => {
  const session = getSessionUser(req);
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.created_at,
            count(p.id) AS project_count,
            tm.role AS my_role
     FROM teams t
     LEFT JOIN projects p ON p.team_id = t.id
     LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.email = $1::text
     GROUP BY t.id, tm.role
     ORDER BY t.created_at DESC
     LIMIT 200`,
    [session?.email ?? null]
  );
  res.json(rows);
});

/** 团队重命名（所有者 / 管理员；校验规则与创建团队一致） */
teamsRouter.patch('/:id/rename', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: '非法的团队 ID' });
  const denied = await manageGuard(req.params.id, req);
  if (denied) return res.status(denied === '团队不存在' ? 404 : 403).json({ error: denied });
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: '请输入团队名称' });
  if (name.length > 60) return res.status(400).json({ error: '团队名称过长（最多 60 字）' });
  const { rows } = await pool.query(
    'UPDATE teams SET name = $1 WHERE id = $2 RETURNING id, name',
    [name, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: '团队不存在' });
  res.json(rows[0]);
});

/** 删除团队（仅所有者；项目与设计稿级联删除） */
teamsRouter.delete('/:id', async (req, res) => {
  const denied = await ownerGuard(req.params.id, req);
  if (denied) return res.status(denied === '团队不存在' ? 404 : 403).json({ error: denied });
  const { rowCount } = await pool.query('DELETE FROM teams WHERE id = $1', [req.params.id]);
  res.json({ deleted: rowCount === 1 });
});

/** 移交所有权（仅所有者；目标成员成为 owner，原所有者降为 admin） */
teamsRouter.post('/:id/transfer', async (req, res) => {
  const denied = await ownerGuard(req.params.id, req);
  if (denied) return res.status(denied === '团队不存在' ? 404 : 403).json({ error: denied });
  const memberId = typeof req.body?.memberId === 'string' ? req.body.memberId : '';
  if (!UUID_RE.test(memberId)) return res.status(400).json({ error: '非法的成员 ID' });

  const target = await pool.query<{ id: string; email: string; role: string }>(
    'SELECT id, email, role FROM team_members WHERE id = $1 AND team_id = $2',
    [memberId, req.params.id]
  );
  if (!target.rows[0]) return res.status(404).json({ error: '目标成员不存在' });
  if (target.rows[0].role === 'owner') return res.status(400).json({ error: '该成员已经是所有者' });

  const session = getSessionUser(req);
  const myEmail = session?.email?.trim().toLowerCase() ?? '';
  // teams.owner_id 指向注册用户；被邀请成员若尚未注册则保持 NULL，
  // ownerGuard 已按 team_members.role='owner' 兜底
  const u = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1 LIMIT 1', [
    target.rows[0].email,
  ]);
  await pool.query('BEGIN');
  try {
    await pool.query('UPDATE team_members SET role = $3 WHERE id = $1 AND team_id = $2', [
      memberId,
      req.params.id,
      'owner',
    ]);
    await pool.query(
      "UPDATE team_members SET role = 'admin' WHERE team_id = $1 AND email = $2 AND role = 'owner'",
      [req.params.id, myEmail]
    );
    if (u.rows[0]) {
      await pool.query('UPDATE teams SET owner_id = $2 WHERE id = $1', [req.params.id, u.rows[0].id]);
    }
    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK');
    throw err;
  }
  res.json({ transferred: true, to: target.rows[0].email });
});

/** 退出团队（管理员 / 协作者；所有者需先移交或删除团队） */
teamsRouter.post('/:id/leave', async (req, res) => {
  const session = getSessionUser(req);
  if (!session) return res.status(401).json({ error: '请先登录后再退出团队' });
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: '非法的团队 ID' });
  const role = await teamRole(req.params.id, req);
  if (role === 'owner') {
    return res.status(403).json({ error: '所有者不能直接退出团队，请先移交所有权或删除团队' });
  }
  const { rowCount } = await pool.query(
    'DELETE FROM team_members WHERE team_id = $1 AND email = $2',
    [req.params.id, session.email.trim().toLowerCase()]
  );
  if (rowCount === 0) return res.status(404).json({ error: '你不是该团队成员' });
  res.json({ left: true });
});

/** 团队成员列表：昵称优先取账号表 users.name（与头像下拉同源），未注册的邀请成员回退成员表历史值 */
teamsRouter.get('/:id/members', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT tm.id, tm.team_id,
            COALESCE(
              (SELECT u.name FROM users u WHERE LOWER(u.email) = LOWER(tm.email) LIMIT 1),
              tm.name
            ) AS name,
            tm.email, tm.role, tm.created_at
     FROM team_members tm
     WHERE tm.team_id = $1 ORDER BY tm.created_at DESC LIMIT 500`,
    [req.params.id]
  );
  res.json(rows);
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = new Set(['admin', 'collaborator']);

/** 邮箱邀请成员（owner/admin 可操作；role: admin=管理员可编辑可删除 / collaborator=协作者只读） */
teamsRouter.post('/:id/members', async (req, res) => {
  const denied = await manageGuard(req.params.id, req);
  if (denied) return res.status(403).json({ error: denied });
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

/** 修改成员角色（owner/admin 可操作；所有者角色不可被改动，所有权转让本期不开放） */
teamsRouter.patch('/:id/members/:memberId', async (req, res) => {
  const denied = await manageGuard(req.params.id, req);
  if (denied) return res.status(403).json({ error: denied });
  const role = typeof req.body?.role === 'string' ? req.body.role : '';
  if (!ROLES.has(role)) return res.status(400).json({ error: "role 必须是 'admin' 或 'collaborator'" });
  const target = await pool.query("SELECT role FROM team_members WHERE id = $1 AND team_id = $2", [
    req.params.memberId,
    req.params.id,
  ]);
  if (!target.rows[0]) return res.status(404).json({ error: '成员不存在' });
  if (target.rows[0].role === 'owner') return res.status(403).json({ error: '不能修改团队所有者的角色' });
  const { rows } = await pool.query(
    `UPDATE team_members SET role = $3 WHERE id = $1 AND team_id = $2
     RETURNING id, team_id, name, email, role, created_at`,
    [req.params.memberId, req.params.id, role]
  );
  res.json(rows[0]);
});

/** 移除团队成员（owner/admin 可操作；所有者不可被移除，可解散团队） */
teamsRouter.delete('/:id/members/:memberId', async (req, res) => {
  const denied = await manageGuard(req.params.id, req);
  if (denied) return res.status(403).json({ error: denied });
  const target = await pool.query("SELECT role FROM team_members WHERE id = $1 AND team_id = $2", [
    req.params.memberId,
    req.params.id,
  ]);
  if (!target.rows[0]) return res.status(404).json({ error: '成员不存在' });
  if (target.rows[0].role === 'owner') return res.status(403).json({ error: '不能移除团队所有者（可解散团队）' });
  const { rowCount } = await pool.query(
    'DELETE FROM team_members WHERE id = $1 AND team_id = $2',
    [req.params.memberId, req.params.id]
  );
  res.json({ deleted: rowCount === 1 });
});

// ---------- 团队邀请 ----------

/**
 * 创建邀请（owner/admin），两种模式：
 * - mode='link'：不需要邮箱，生成不绑定邮箱的邀请链接（7 天内可多人使用），返回 inviteUrl
 * - mode='email'：把邮箱直接写入团队成员表（不发邮件、不生成链接），返回 member
 */
teamsRouter.post('/:id/invites', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: '非法的团队 ID' });
  const denied = await manageGuard(req.params.id, req);
  if (denied) return res.status(403).json({ error: denied });

  const role = req.body?.role === 'admin' ? 'admin' : 'collaborator';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const mode = req.body?.mode === 'link' || !email ? 'link' : 'email';

  const t = await pool.query<{ id: string }>('SELECT id FROM teams WHERE id = $1', [req.params.id]);
  if (!t.rows[0]) return res.status(404).json({ error: '团队不存在' });
  const session = getSessionUser(req);

  if (mode === 'email') {
    // 邮箱邀请：直接加入成员，不需要对方接受
    if (!EMAIL_RE.test(email) || email.length > 120) return res.status(400).json({ error: '邮箱格式不正确' });
    const dup = await pool.query('SELECT 1 FROM team_members WHERE team_id = $1 AND email = $2', [
      req.params.id,
      email,
    ]);
    if (dup.rows[0]) return res.status(409).json({ error: '该邮箱已在团队中，无需重复添加' });
    const { rows } = await pool.query(
      `INSERT INTO team_members (team_id, name, email, role) VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, created_at`,
      [req.params.id, email.split('@')[0].slice(0, 30), email, role]
    );
    return res.status(201).json({ mode, member: rows[0] });
  }

  // 链接邀请：不绑定邮箱，7 天内可多人使用
  const { token, invite } = await createTeamInvite(
    req.params.id,
    null,
    role,
    session?.email ?? '',
    emailConfig.webBaseUrl
  );
  res.status(201).json({
    ...invite,
    inviteUrl: `${emailConfig.webBaseUrl}/invite?token=${token}`,
  });
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
    `SELECT id, prefix, scope, created_at, last_used_at
     FROM import_tokens WHERE team_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC LIMIT 50`,
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
  const scope = req.body?.scope === 'team' ? 'team' : 'all';
  const active = await pool.query(
    'SELECT count(*)::int AS n FROM import_tokens WHERE team_id = $1 AND revoked_at IS NULL',
    [req.params.id]
  );
  if (active.rows[0].n >= 10) {
    return res.status(400).json({ error: '该团队已有 10 个未撤销的导入令牌，请先撤销不用的再生成' });
  }
  const token = `imp_${randomBytes(24).toString('base64url')}`;
  const { rows } = await pool.query(
    `INSERT INTO import_tokens (team_id, hash, prefix, scope) VALUES ($1, $2, $3, $4)
     RETURNING id, prefix, scope, created_at`,
    [req.params.id, hashToken(token), token.slice(0, 12), scope]
  );
  res.status(201).json({ ...rows[0], token });
});

/** 撤销令牌：直接从数据库删除（不可恢复），插件再用会返回 401 */
teamsRouter.delete('/:id/import-tokens/:tokenId', async (req, res) => {
  if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.tokenId)) {
    return res.status(400).json({ error: '非法的 ID 格式' });
  }
  const denied = await editGuard(req.params.id, req);
  if (denied) return res.status(403).json({ error: denied });
  const { rows } = await pool.query(
    `DELETE FROM import_tokens
     WHERE id = $1 AND team_id = $2
     RETURNING id`,
    [req.params.tokenId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: '令牌不存在或已删除' });
  res.json({ deleted: true, id: rows[0].id });
});
