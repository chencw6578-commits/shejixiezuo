import { Router, type Request } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db.js';
import { getSessionUser } from '../auth.js';
import { sendMail } from '../email/index.js';

/**
 * 团队邀请流：
 * - owner/admin 生成邀请（7 天有效、一次性、邮箱绑定）
 * - 被邀请人打开 /invite?token= 落地页，登录匹配邮箱后接受入队
 */

export const invitesRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export interface InviteRow {
  id: string;
  team_id: string;
  email: string;
  role: 'admin' | 'collaborator';
  expires_at: string;
}

/** 创建邀请：返回明文 token（拼进邀请链接），库里只存哈希 */
export async function createTeamInvite(
  teamId: string,
  email: string,
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
  await sendInviteEmail(teamId, email, role, `${webBaseUrl}/invite?token=${token}`);
  return { token, invite: rows[0] };
}

/** 核验邀请：返回邀请 + 团队名；无效/过期/已接受返回 null */
async function validInvite(token: string) {
  const { rows } = await pool.query<{
    id: string;
    team_id: string;
    team_name: string;
    email: string;
    role: string;
    accepted_at: Date | null;
  }>(
    `SELECT i.id, i.team_id, t.name AS team_name, i.email, i.role, i.accepted_at
     FROM team_invites i JOIN teams t ON t.id = i.team_id
     WHERE i.token_hash = $1 AND i.expires_at > now() AND i.accepted_at IS NULL`,
    [hashToken(token)]
  );
  return rows[0] ?? null;
}

async function sendInviteEmail(teamId: string, email: string, role: string, url: string) {
  const t = await pool.query<{ name: string }>('SELECT name FROM teams WHERE id = $1', [teamId]);
  const teamName = t.rows[0]?.name ?? '设计协作团队';
  const roleLabel = role === 'admin' ? '管理员' : '协作者（只读）';
  const html = `
<div style="max-width:520px;margin:0 auto;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2937;">
  <h2 style="font-size:18px;">团队邀请</h2>
  <p style="font-size:14px;line-height:1.7;color:#4b5563;">
    你被邀请以 <b>${roleLabel}</b> 身份加入 <b>${teamName}</b>。点击下面按钮接受邀请：
  </p>
  <p style="text-align:center;margin:28px 0;">
    <a href="${url}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;
       padding:10px 28px;border-radius:8px;font-size:14px;">接受邀请</a>
  </p>
  <p style="font-size:12px;line-height:1.7;color:#9ca3af;">
    如果按钮无法点击，请复制以下链接到浏览器打开（需用 <b>${email}</b> 登录）：<br/>
    <a href="${url}" style="color:#4f46e5;word-break:break-all;">${url}</a>
  </p>
  <p style="font-size:12px;color:#9ca3af;">链接 7 天内有效。若这不是你的操作，请忽略本邮件。</p>
</div>`;
  await sendMail({ to: email, subject: `邀请你加入 ${teamName} · 设计协作`, html });
}

// ---------- 邀请信息（公开，落地页展示用，不泄露敏感字段） ----------
invitesRouter.get('/info', async (req: Request, res) => {
  const token = String(req.query?.token ?? '').trim();
  if (!token) return res.status(400).json({ error: '缺少邀请令牌' });
  const inv = await validInvite(token);
  if (!inv) return res.status(400).json({ error: '邀请链接无效或已过期' });
  res.json({ teamName: inv.team_name, email: inv.email, role: inv.role });
});

// ---------- 接受邀请（需登录，且登录邮箱与被邀邮箱一致） ----------
invitesRouter.post('/accept', async (req: Request, res) => {
  const session = getSessionUser(req);
  if (!session) return res.status(401).json({ error: '请先登录后再接受邀请' });
  const token = String(req.body?.token ?? '').trim();
  if (!token) return res.status(400).json({ error: '缺少邀请令牌' });

  const inv = await validInvite(token);
  if (!inv) return res.status(400).json({ error: '邀请链接无效或已过期' });
  if (inv.email !== session.email.trim().toLowerCase()) {
    return res.status(403).json({ error: `本邀请仅限 ${inv.email} 接受，请用该邮箱登录` });
  }

  const dup = await pool.query('SELECT 1 FROM team_members WHERE team_id = $1 AND email = $2', [
    inv.team_id,
    inv.email,
  ]);
  if (!dup.rows[0]) {
    await pool.query(
      `INSERT INTO team_members (team_id, name, email, role) VALUES ($1, $2, $3, $4)`,
      [inv.team_id, inv.email.split('@')[0].slice(0, 30), inv.email, inv.role]
    );
  }
  await pool.query('UPDATE team_invites SET accepted_at = now() WHERE id = $1', [inv.id]);
  res.json({ ok: true, teamId: inv.team_id, teamName: inv.team_name, role: inv.role });
});
