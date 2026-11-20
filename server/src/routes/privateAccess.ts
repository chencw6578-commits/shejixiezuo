import type { Request, RequestHandler, Response } from 'express';
import { getSessionUser } from '../auth.js';
import { privateTeamStorage } from '../config.js';
import { pool } from '../db.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const resources = {
  team: 'FROM teams t WHERE t.id = $1 AND tm.team_id = t.id',
  project: 'FROM projects p WHERE p.id = $1 AND tm.team_id = p.team_id',
  file: 'FROM design_files f JOIN projects p ON p.id = f.project_id WHERE f.id = $1 AND tm.team_id = p.team_id',
  frame: 'FROM frames fr JOIN design_files f ON f.id = fr.file_id JOIN projects p ON p.id = f.project_id WHERE fr.id = $1 AND tm.team_id = p.team_id',
  comment: 'FROM comments c JOIN frames fr ON fr.id = c.frame_id JOIN design_files f ON f.id = fr.file_id JOIN projects p ON p.id = f.project_id WHERE c.id = $1 AND tm.team_id = p.team_id',
} as const;
type Resource = keyof typeof resources;

export async function canReadTeamResource(resource: Resource, id: unknown, email: string): Promise<boolean> {
  if (typeof id !== 'string' || !uuid.test(id)) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM team_members tm
     WHERE tm.email = $2 AND EXISTS (SELECT 1 ${resources[resource]}) LIMIT 1`,
    [id, email.trim().toLowerCase()]
  );
  return rows.length > 0;
}

export function requirePrivateAccess(resource: Resource, idOf: (req: Request) => unknown): RequestHandler {
  return (req, res, next) => {
    if (!privateTeamStorage) return next();
    res.setHeader('Cache-Control', 'private, no-store');
    const user = getSessionUser(req);
    if (!user) {
      res.status(401).json({ error: '请先登录' });
      return;
    }
    void canReadTeamResource(resource, idOf(req), user.email)
      .then((allowed) => {
        if (allowed) next();
        else res.status(404).json({ error: '资源不存在或无权访问' });
      })
      .catch((err: unknown) => {
        console.error('[private-access] membership check failed:', err);
        res.status(500).json({ error: '权限检查失败' });
      });
  };
}

export function requireTeamProject(projectId: unknown, res: Response): boolean {
  if (!privateTeamStorage || (typeof projectId === 'string' && uuid.test(projectId))) return true;
  res.status(400).json({ error: '请选择一个团队项目' });
  return false;
}
