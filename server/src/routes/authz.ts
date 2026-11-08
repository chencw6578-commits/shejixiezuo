import { pool } from '../db.js';
import { getSessionUser } from '../auth.js';
import type { Request } from 'express';

export type MemberRole = 'owner' | 'admin' | 'collaborator';

/**
 * 解析当前请求身份在指定团队中的角色。
 * 身份优先取登录会话 cookie（邮箱注册登录），其次兼容 X-Member-Email 头
 * （前端「以此身份体验」写入 localStorage 后自动附带）；
 * 均未携带 = 所有者，拥有最高权限。
 */
export async function teamRole(teamId: string | null | undefined, req: Request): Promise<MemberRole> {
  if (!teamId) return 'owner';
  const session = getSessionUser(req);
  const email = (session?.email ?? req.header('x-member-email') ?? '').trim().toLowerCase();
  if (!email) return 'owner';
  const { rows } = await pool.query<{ role: string }>(
    'SELECT role FROM team_members WHERE team_id = $1 AND email = $2 LIMIT 1',
    [teamId, email]
  );
  return rows[0]?.role === 'collaborator' ? 'collaborator' : 'admin';
}

/** 协作者只读校验。返回 null 表示放行，否则为 403 错误消息。 */
export async function editGuard(teamId: string | null | undefined, req: Request): Promise<string | null> {
  const role = await teamRole(teamId, req);
  if (role === 'collaborator') {
    return '协作者身份为只读（仅可查看与评论），删除/编辑/导入需要管理员权限';
  }
  return null;
}

/** 设计稿所属团队（经项目关联），无项目归属返回 null */
export async function fileTeamId(fileId: string): Promise<string | null> {
  const { rows } = await pool.query<{ team_id: string | null }>(
    `SELECT p.team_id FROM design_files f LEFT JOIN projects p ON p.id = f.project_id WHERE f.id = $1`,
    [fileId]
  );
  return rows[0]?.team_id ?? null;
}
