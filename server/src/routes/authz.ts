import { pool } from '../db.js';
import { getSessionUser } from '../auth.js';
import type { Request } from 'express';

export type MemberRole = 'owner' | 'admin' | 'collaborator';

/**
 * 解析当前请求身份在指定团队中的角色。
 * 授权以登录会话 cookie（邮箱注册登录）为准。
 *
 * 权限规则（默认最小权限，修掉旧版「无身份 = 所有者」与「X-Member-Email 可伪造提权」两个越权洞）：
 * - 无团队上下文（个人空间）：登录即可写，未登录只读
 * - 团队上下文：以 team_members 表角色为准；不在成员表 / 未登录 = collaborator 只读
 * - X-Member-Email 头仅用于「以此身份体验」演示：仅当会话本人是 owner/admin 时，
 *   可以向下体验该团队更低角色（owner 可体验任意成员；admin 不可体验 owner），未登录时该头无效
 * - Figma 插件通道不走此函数（/api/plugin/* 用 Bearer 导入令牌独立鉴权）
 */
export async function teamRole(teamId: string | null | undefined, req: Request): Promise<MemberRole> {
  const session = getSessionUser(req);
  if (!session) return 'collaborator';
  const email = session.email.trim().toLowerCase();
  if (!teamId) {
    // 个人空间（项目不归属团队）：登录用户视为空间所有者，其余只读
    return 'owner';
  }
  const roleOf = async (e: string): Promise<MemberRole> => {
    const { rows } = await pool.query<{ role: string }>(
      'SELECT role FROM team_members WHERE team_id = $1 AND email = $2 LIMIT 1',
      [teamId, e]
    );
    const r = rows[0]?.role;
    return r === 'owner' || r === 'admin' ? r : 'collaborator';
  };
  const myRole = await roleOf(email);

  const asEmail = (req.header('x-member-email') ?? '').trim().toLowerCase();
  if (asEmail && asEmail !== email && myRole !== 'collaborator') {
    const asRole = await roleOf(asEmail);
    // 只允许向下体验：admin 不能体验 owner，任何人都不能凭空体验不存在的成员
    if (asEmail && (myRole === 'owner' || asRole !== 'owner')) {
      const target = await pool.query(
        'SELECT 1 FROM team_members WHERE team_id = $1 AND email = $2 LIMIT 1',
        [teamId, asEmail]
      );
      if (target.rows[0]) return asRole;
    }
  }
  return myRole;
}

/**
 * 写操作守卫（上传设计稿 / 增删项目 / 编辑）：owner、admin 放行，collaborator（含游客）拒绝。
 * 返回 null 表示放行，否则为 403 错误消息。
 */
export async function editGuard(teamId: string | null | undefined, req: Request): Promise<string | null> {
  const role = await teamRole(teamId, req);
  if (role === 'collaborator') {
    return '协作者身份为只读（仅可查看与评论），编辑 / 上传 / 删除需要管理员及以上权限';
  }
  return null;
}

/**
 * 成员管理守卫（邀请 / 移除 / 改角色 / 生成导入令牌）：owner、admin 放行。
 * 对 owner 本人的保护在路由层处理（管理员不得动所有者）。
 */
export async function manageGuard(teamId: string | null | undefined, req: Request): Promise<string | null> {
  const role = await teamRole(teamId, req);
  if (role === 'collaborator') {
    return '成员管理需要管理员及以上权限';
  }
  return null;
}

/**
 * 团队所有者守卫（删除团队）。
 * teams.owner_id 关联建团队账号的邮箱；历史遗留 owner_id 为 NULL 的团队，
 * 降级为成员表中 role='owner' 的成员可操作，都没有则拒绝。
 */
export async function ownerGuard(teamId: string, req: Request): Promise<string | null> {
  const session = getSessionUser(req);
  const email = session?.email?.trim().toLowerCase() ?? '';
  if (!email) return '请先登录后再操作团队';

  const t = await pool.query<{ owner_id: string | null }>('SELECT owner_id FROM teams WHERE id = $1', [teamId]);
  if (!t.rows[0]) return '团队不存在';
  if (t.rows[0].owner_id) {
    const { rows } = await pool.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [
      t.rows[0].owner_id,
    ]);
    if (rows[0]?.email === email) return null;
    return '只有团队所有者可以删除团队';
  }
  // 历史团队兜底：成员表中标记为 owner 的成员可操作
  const { rows } = await pool.query(
    "SELECT 1 FROM team_members WHERE team_id = $1 AND email = $2 AND role = 'owner' LIMIT 1",
    [teamId, email]
  );
  return rows[0] ? null : '只有团队所有者可以删除团队';
}

/** 设计稿所属团队（经项目关联），无项目归属返回 null */
export async function fileTeamId(fileId: string): Promise<string | null> {
  const { rows } = await pool.query<{ team_id: string | null }>(
    `SELECT p.team_id FROM design_files f LEFT JOIN projects p ON p.id = f.project_id WHERE f.id = $1`,
    [fileId]
  );
  return rows[0]?.team_id ?? null;
}
