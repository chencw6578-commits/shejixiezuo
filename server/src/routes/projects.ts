import { Router } from 'express';
import { pool } from '../db.js';

export const projectsRouter = Router();

/** 创建项目 */
projectsRouter.post('/', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: '请输入项目名称' });
  if (name.length > 60) return res.status(400).json({ error: '项目名称过长（最多 60 字）' });
  const { rows } = await pool.query(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id, name, created_at`,
    [name]
  );
  res.json(rows[0]);
});

/** 项目列表（含设计稿数量与最近更新时间） */
projectsRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.created_at,
            count(f.id) AS file_count,
            max(f.created_at) AS last_file_at
     FROM projects p
     LEFT JOIN design_files f ON f.project_id = p.id
     GROUP BY p.id
     ORDER BY max(f.created_at) DESC NULLS LAST, p.created_at DESC
     LIMIT 200`
  );
  res.json(rows);
});

/** 项目详情 */
projectsRouter.get('/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, created_at FROM projects WHERE id = $1', [
    req.params.id,
  ]);
  if (!rows[0]) return res.status(404).json({ error: '项目不存在' });
  res.json(rows[0]);
});

/** 删除项目（其中设计稿一并删除，画板/图层级联） */
projectsRouter.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
  res.json({ deleted: rowCount === 1 });
});
