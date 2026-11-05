import { Router } from 'express';
import { pool } from '../db.js';

export const commentsRouter = Router();

interface CommentRow {
  id: string;
  frame_id: string;
  parent_id: string | null;
  node_id: string | null;
  x: number | null;
  y: number | null;
  author: string;
  body: string;
  resolved: boolean;
  created_at: string;
}

/** 画板的全部评论（根 + 回复） */
commentsRouter.get('/frames/:frameId', async (req, res) => {
  const { rows } = await pool.query<CommentRow>(
    `SELECT id, frame_id, parent_id, node_id, x, y, author, body, resolved, created_at
     FROM comments WHERE frame_id = $1 ORDER BY created_at`,
    [req.params.frameId]
  );
  res.json(rows);
});

/** 新评论（根：可锚定图层或自由钉点） */
commentsRouter.post('/frames/:frameId', async (req, res) => {
  const { author, body, nodeId, x, y, resolved } = req.body ?? {};
  if (!author || !body) return res.status(400).json({ error: '缺少 author 或 body' });
  const { rows } = await pool.query<CommentRow>(
    `INSERT INTO comments (frame_id, node_id, x, y, author, body, resolved)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [req.params.frameId, nodeId ?? null, x ?? null, y ?? null, String(author).slice(0, 40), String(body).slice(0, 2000), !!resolved]
  );
  res.json(rows[0]);
});

/** 回复 */
commentsRouter.post('/:id/replies', async (req, res) => {
  const root = (await pool.query('SELECT id FROM comments WHERE id = $1', [req.params.id])).rows[0];
  if (!root) return res.status(404).json({ error: '评论不存在' });
  const { author, body } = req.body ?? {};
  if (!author || !body) return res.status(400).json({ error: '缺少 author 或 body' });
  const { rows } = await pool.query(
    `INSERT INTO comments (frame_id, parent_id, author, body)
     SELECT frame_id, $1, $2, $3 FROM comments WHERE id = $1 RETURNING *`,
    [req.params.id, String(author).slice(0, 40), String(body).slice(0, 2000)]
  );
  res.json(rows[0]);
});

/** 解决 / 取消解决 */
commentsRouter.post('/:id/resolve', async (req, res) => {
  const { resolved = true } = req.body ?? {};
  const { rows } = await pool.query(
    'UPDATE comments SET resolved = $2 WHERE id = $1 RETURNING id, resolved',
    [req.params.id, !!resolved]
  );
  if (!rows[0]) return res.status(404).json({ error: '评论不存在' });
  res.json(rows[0]);
});

commentsRouter.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM comments WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});
