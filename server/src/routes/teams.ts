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
