import { Router, type Request } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db.js';
import { getSessionUser } from '../auth.js';

/**
 * 团队邀请流（两种方式）：
 * - 链接邀请：owner/admin 选好角色生成邀请链接（email 为 NULL），7 天内可被多人使用，
 *   任何登录用户打开 /invite?token= 接受后即按链接角色入队，不绑定邮箱
 * - 邮箱邀请：不生成链接、不发邮件，直接把邮箱写入团队成员表
 */

export const invitesRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export interface InviteRow {
  id: string;
  team_id: string;
  email: string | null;
  role: 'admin' | 'collaborator';
  expires_at: string;
}

/**
 * 创建链接邀请：返回明文 token（拼进邀请链接），库里只存哈希。
 * 链接邀请不绑定邮箱（email 为 NULL）、可多人使用，也不发送邮件。
 */
export async function createTeamInvite(
  teamId: string,
  email: string | null,
  role: 'admin' | 'collaborator',
  invitedBy: string,
  webBaseUrl: string
): Promise<{ token: string; invite: InviteRow }> {
  const token = randomBytes(32).toString('base64url');
  const { rows } = await pool.query<InviteRow>(
    `INSERT INTO team_invites (team_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')
     RETURNING id, team_id, email, role, expires_at`,
    [teamId, email, role, hashToken(token), invitedBy]
  );
  return { token, invite: rows[0] };
}

/** 核验邀请：返回邀请 + 团队名；无效/过期返回 null。链接邀请（email 为 NULL）可多人使用，不受 accepted_at 限制 */
async function validInvite(token: string) {
  const { rows } = await pool.query<{
    id: string;
    team_id: string;
    team_name: string;
    email: string | null;
    role: string;
    accepted_at: Date | null;
  }>(
    `SELECT i.id, i.team_id, t.name AS team_name, i.email, i.role, i.accepted_at
     FROM team_invites i JOIN teams t ON t.id = i.team_id
     WHERE i.token_hash = $1 AND i.expires_at > now()
       AND (i.email IS NULL OR i.accepted_at IS NULL)`,
    [hashToken(token)]
  );
  return rows[0] ?? null;
}

// ---------- 邀请信息（公开，落地页展示用，不泄露敏感字段） ----------
invitesRouter.get('/info', async (req: Request, res) => {
  const token = String(req.query?.token ?? '').trim();
  if (!token) return res.status(400).json({ error: '缺少邀请令牌' });
  const inv = await validInvite(token);
  if (!inv) return res.status(400).json({ error: '邀请链接无效或已过期' });
  res.json({ teamName: inv.team_name, email: inv.email, role: inv.role });
});

// ---------- 接受邀请（需登录） ----------
// 邮箱绑定邀请（email 非空）：登录邮箱须一致，一次性
// 链接邀请（email 为 NULL）：任何登录用户可接受，按链接角色入队，链接 7 天内可重复使用
invitesRouter.post('/accept', async (req: Request, res) => {
  const session = getSessionUser(req);
  if (!session) return res.status(401).json({ error: '请先登录后再接受邀请' });
  const token = String(req.body?.token ?? '').trim();
  if (!token) return res.status(400).json({ error: '缺少邀请令牌' });

  const inv = await validInvite(token);
  if (!inv) return res.status(400).json({ error: '邀请链接无效或已过期' });

  const email = inv.email ?? session.email.trim().toLowerCase();
  if (inv.email && inv.email !== session.email.trim().toLowerCase()) {
    return res.status(403).json({ error: `本邀请仅限 ${inv.email} 接受，请用该邮箱登录` });
  }

  const dup = await pool.query('SELECT 1 FROM team_members WHERE team_id = $1 AND email = $2', [
    inv.team_id,
    email,
  ]);
  if (!dup.rows[0]) {
    await pool.query(
      `INSERT INTO team_members (team_id, name, email, role) VALUES ($1, $2, $3, $4)`,
      [inv.team_id, email.split('@')[0].slice(0, 30), email, inv.role]
    );
  }
  // 邮箱绑定邀请标记已用（一次性）；链接邀请保持可用，直到过期
  if (inv.email) {
    await pool.query('UPDATE team_invites SET accepted_at = now() WHERE id = $1', [inv.id]);
  }
  res.json({ ok: true, teamId: inv.team_id, teamName: inv.team_name, role: inv.role });
});
