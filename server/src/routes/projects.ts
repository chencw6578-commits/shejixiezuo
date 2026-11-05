import { Router } from 'express';
import { pool } from '../db.js';

export const projectsRouter = Router();

/** 创建项目（可归属团队） */
projectsRouter.post('/', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const teamId = typeof req.body?.teamId === 'string' && req.body.teamId ? req.body.teamId : null;
  if (!name) return res.status(400).json({ error: '请输入项目名称' });
  if (name.length > 60) return res.status(400).json({ error: '项目名称过长（最多 60 字）' });
  if (teamId) {
    const t = await pool.query('SELECT 1 FROM teams WHERE id = $1', [teamId]);
    if (!t.rows[0]) return res.status(404).json({ error: '团队不存在' });
  }
  const { rows } = await pool.query(
    `INSERT INTO projects (name, team_id) VALUES ($1, $2) RETURNING id, name, created_at`,
    [name, teamId]
  );
  res.json(rows[0]);
});

/** 项目列表（?teamId= 按团队过滤；不传返回全部项目） */
projectsRouter.get('/', async (req, res) => {
  const { teamId } = req.query;
  const hasTeam = typeof teamId === 'string' && teamId;
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.created_at,
            count(f.id) AS file_count,
            max(f.created_at) AS last_file_at
     FROM projects p
     LEFT JOIN design_files f ON f.project_id = p.id
     ${hasTeam ? 'WHERE p.team_id = $1' : ''}
     GROUP BY p.id
     ORDER BY max(f.created_at) DESC NULLS LAST, p.created_at DESC
     LIMIT 200`,
    hasTeam ? [teamId] : []
  );
  res.json(rows);
});

/** 项目详情（含所属团队） */
projectsRouter.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.created_at, p.team_id, t.name AS team_name
     FROM projects p LEFT JOIN teams t ON t.id = p.team_id
     WHERE p.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: '项目不存在' });
  res.json(rows[0]);
});

/** 删除项目（其中设计稿一并删除，画板/图层级联） */
projectsRouter.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
  res.json({ deleted: rowCount === 1 });
});
