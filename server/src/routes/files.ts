import { Router } from 'express';
import { pool } from '../db.js';
import { parseFileKey, getFileMeta } from '../figma/client.js';
import { enqueueImport } from '../jobs/importFile.js';
import { isFigmaConfigured } from '../config.js';
import { editGuard, fileTeamId } from './authz.js';

export const filesRouter = Router();

/** 导入 Figma 文件（可指定所属项目） */
filesRouter.post('/', async (req, res) => {
  const { url, projectId } = req.body ?? {};
  let teamId: string | null = null;
  if (projectId) {
    const p = await pool.query<{ team_id: string | null }>('SELECT team_id FROM projects WHERE id = $1', [projectId]);
    if (!p.rows[0]) return res.status(404).json({ error: '项目不存在' });
    teamId = p.rows[0].team_id;
  }
  const denied = await editGuard(teamId, req);
  if (denied) return res.status(403).json({ error: denied });
  if (!isFigmaConfigured()) {
    return res.status(503).json({ error: '服务端未配置 FIGMA_TOKEN，请先在 .env 中设置' });
  }
  const figmaKey = typeof url === 'string' ? parseFileKey(url) : null;
  if (!figmaKey) {
    return res.status(400).json({ error: '无法识别的 Figma 链接，请粘贴形如 https://www.figma.com/design/... 的链接' });
  }
  let name = figmaKey;
  let version: string | null = null;
  try {
    const meta = await getFileMeta(figmaKey);
    name = meta.name;
    version = meta.version ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(502).json({ error: `获取 Figma 文件失败：${message}` });
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO design_files (figma_key, name, version, status, project_id) VALUES ($1, $2, $3, 'pending', $4) RETURNING id`,
    [figmaKey, name, version, projectId ?? null]
  );
  const id = rows[0].id;
  void enqueueImport(id, figmaKey);
  res.json({ id, name, status: 'pending' });
});

/** 文件列表（支持 ?projectId= 过滤；无参数返回未归属项目的文件） */
filesRouter.get('/', async (req, res) => {
  const { projectId } = req.query;
  if (typeof projectId === 'string' && projectId) {
    const { rows } = await pool.query(
      `SELECT f.id, f.name, f.status, f.error, f.source, f.created_at,
              (SELECT count(*) FROM frames fr WHERE fr.file_id = f.id) AS frame_count
       FROM design_files f
       WHERE f.project_id = $1
       ORDER BY f.created_at DESC LIMIT 200`,
      [projectId]
    );
    return res.json(rows);
  }
  const { rows } = await pool.query(
    `SELECT f.id, f.name, f.status, f.error, f.source, f.created_at,
            (SELECT count(*) FROM frames fr WHERE fr.file_id = f.id) AS frame_count
     FROM design_files f
     WHERE f.project_id IS NULL
     ORDER BY f.created_at DESC LIMIT 100`
  );
  res.json(rows);
});

/** 文件详情（含画板列表） */
filesRouter.get('/:id', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: '文件不存在' });
  const file = (
    await pool.query(
      `SELECT f.id, f.figma_key, f.name, f.version, f.status, f.error, f.project_id, p.team_id, f.created_at
       FROM design_files f LEFT JOIN projects p ON p.id = f.project_id WHERE f.id = $1`,
      [req.params.id]
    )
  ).rows[0];
  if (!file) return res.status(404).json({ error: '文件不存在' });
  await ensurePages(req.params.id);
  const frames = (
    await pool.query(
      `SELECT id, node_id, name, page_name, page_id, width, height, thumb_url, sort_order
       FROM frames WHERE file_id = $1 ORDER BY sort_order, name`,
      [req.params.id]
    )
  ).rows;
  const pages = (
    await pool.query(
      'SELECT id, name, sort_order FROM pages WHERE file_id = $1 ORDER BY sort_order, created_at',
      [req.params.id]
    )
  ).rows;
  res.json({ ...file, frames, pages });
});

// ---------- 页面（画板编组） ----------

/** 页面回填：历史上按 page_name 存储的画板，首次访问时物化成 pages 记录并挂接 */
const ensurePages = async (fileId: string) => {
  await pool.query(
    `INSERT INTO pages (file_id, name, sort_order)
     SELECT DISTINCT $1::uuid, page_name, 0 FROM frames
     WHERE file_id = $1::uuid AND page_name IS NOT NULL AND page_name <> ''
     ON CONFLICT (file_id, name) DO NOTHING`,
    [fileId]
  );
  await pool.query(
    `UPDATE frames fr SET page_id = pg.id
     FROM pages pg
     WHERE pg.file_id = fr.file_id AND pg.name = fr.page_name AND fr.page_id IS NULL
       AND fr.file_id = $1::uuid`,
    [fileId]
  );
};

/** 新建页面 */
filesRouter.post('/:id/pages', async (req, res) => {
  const denied = await editGuard(await fileTeamId(req.params.id), req);
  if (denied) return res.status(403).json({ error: denied });
  const name = ((req.body as { name?: string }).name ?? '').trim();
  if (!name) return res.status(400).json({ error: '页面名称不能为空' });
  if (name.length > 50) return res.status(400).json({ error: '页面名称过长（≤50 字符）' });
  const { rows: [existing] } = await pool.query(
    'SELECT id, name FROM pages WHERE file_id = $1 AND name = $2',
    [req.params.id, name]
  );
  if (existing) return res.json(existing);
  const { rows: [pg] } = await pool.query(
    'INSERT INTO pages (file_id, name) VALUES ($1, $2) RETURNING id, name',
    [req.params.id, name]
  );
  res.status(201).json(pg);
});

/** 重命名页面（同步 frames.page_name 保持兼容） */
filesRouter.patch('/:id/pages/:pageId', async (req, res) => {
  const denied = await editGuard(await fileTeamId(req.params.id), req);
  if (denied) return res.status(403).json({ error: denied });
  const name = ((req.body as { name?: string }).name ?? '').trim();
  if (!name) return res.status(400).json({ error: '页面名称不能为空' });
  if (name.length > 50) return res.status(400).json({ error: '页面名称过长（≤50 字符）' });
  const { rows: [pg] } = await pool.query(
    'UPDATE pages SET name = $1 WHERE id = $2 AND file_id = $3 RETURNING id, name',
    [name, req.params.pageId, req.params.id]
  );
  if (!pg) return res.status(404).json({ error: '页面不存在' });
  await pool.query('UPDATE frames SET page_name = $1 WHERE page_id = $2', [name, pg.id]);
  res.json(pg);
});

/** 删除页面（画板回落为未分组） */
filesRouter.delete('/:id/pages/:pageId', async (req, res) => {
  const denied = await editGuard(await fileTeamId(req.params.id), req);
  if (denied) return res.status(403).json({ error: denied });
  const { rows: [pg] } = await pool.query(
    'DELETE FROM pages WHERE id = $1 AND file_id = $2 RETURNING id',
    [req.params.pageId, req.params.id]
  );
  if (!pg) return res.status(404).json({ error: '页面不存在' });
  await pool.query("UPDATE frames SET page_id = NULL, page_name = NULL WHERE page_id = $1", [pg.id]);
  res.json({ ok: true });
});

/** 移动画板到页面（pageId 传 null 表示移出为未分组） */
filesRouter.patch('/:id/frames/:frameId/page', async (req, res) => {
  const denied = await editGuard(await fileTeamId(req.params.id), req);
  if (denied) return res.status(403).json({ error: denied });
  const pageId = (req.body as { pageId?: string | null }).pageId ?? null;
  const frame = (
    await pool.query<{ id: string }>(
      'SELECT id FROM frames WHERE id = $1 AND file_id = $2',
      [req.params.frameId, req.params.id]
    )
  ).rows[0];
  if (!frame) return res.status(404).json({ error: '画板不存在' });
  if (pageId) {
    const { rows: [pg] } = await pool.query<{ id: string; name: string }>(
      'SELECT id, name FROM pages WHERE id = $1 AND file_id = $2',
      [pageId, req.params.id]
    );
    if (!pg) return res.status(404).json({ error: '目标页面不存在' });
    await pool.query('UPDATE frames SET page_id = $1, page_name = $2 WHERE id = $3', [pg.id, pg.name, frame.id]);
  } else {
    await pool.query('UPDATE frames SET page_id = NULL, page_name = NULL WHERE id = $1', [frame.id]);
  }
  res.json({ ok: true });
});

/** 画板详情（含全部图层，平铺，客户端组树） */
filesRouter.get('/:id/frames/:frameId', async (req, res) => {
  const frame = (
    await pool.query(
      `SELECT id, file_id, node_id, name, page_name, width, height, thumb_url
       FROM frames WHERE id = $1 AND file_id = $2`,
      [req.params.frameId, req.params.id]
    )
  ).rows[0];
  if (!frame) return res.status(404).json({ error: '画板不存在' });
  const nodes = (
    await pool.query(
      `SELECT id, node_id, parent_id, name, type, x, y, width, height, props
       FROM nodes WHERE frame_id = $1 ORDER BY id`,
      [req.params.frameId]
    )
  ).rows;
  res.json({ frame, nodes });
});

/** 手动同步：版本有变化才重新导入 */
filesRouter.post('/:id/sync', async (req, res) => {
  const file = (
    await pool.query<{ id: string; figma_key: string; version: string | null; status: string }>(
      'SELECT id, figma_key, version, status FROM design_files WHERE id = $1',
      [req.params.id]
    )
  ).rows[0];
  if (!file) return res.status(404).json({ error: '文件不存在' });
  if (file.status === 'pending' || file.status === 'processing') {
    return res.status(409).json({ error: '文件正在处理中，请稍候' });
  }
  try {
    const meta = await getFileMeta(file.figma_key);
    if (file.status === 'ready' && meta.version === file.version) {
      return res.json({ updated: false, version: meta.version });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(502).json({ error: `获取 Figma 文件失败：${message}` });
  }
  await pool.query("UPDATE design_files SET status = 'pending', error = NULL WHERE id = $1", [file.id]);
  void enqueueImport(file.id, file.figma_key);
  res.json({ updated: true });
});

/** 设计规范聚合：色板 / 渐变 / 字体 */
filesRouter.get('/:id/spec', async (req, res) => {
  const file = (
    await pool.query('SELECT id, name FROM design_files WHERE id = $1', [req.params.id])
  ).rows[0];
  if (!file) return res.status(404).json({ error: '文件不存在' });

  const { rows } = await pool.query<{ props: {
    fills?: { type: string; visible: boolean; color?: { hex: string; rgba: string; alpha: number }; css?: string }[];
    text?: { family?: string; size?: number; weight?: number; lineHeight?: number };
  } }>('SELECT props FROM nodes WHERE file_id = $1', [req.params.id]);

  const colors = new Map<string, { hex: string; rgba: string; alpha: number; count: number }>();
  const gradients = new Map<string, { css: string; count: number }>();
  const fonts = new Map<string, { family: string; size: number; weight: number; count: number }>();
  let imageFillCount = 0;

  for (const { props } of rows) {
    for (const f of props.fills ?? []) {
      if (!f.visible) continue;
      if (f.type === 'solid' && f.color) {
        const c = colors.get(f.color.hex) ?? { ...f.color, count: 0 };
        c.count++;
        colors.set(f.color.hex, c);
      } else if (f.type === 'gradient' && f.css) {
        const g = gradients.get(f.css) ?? { css: f.css, count: 0 };
        g.count++;
        gradients.set(f.css, g);
      } else if (f.type === 'image') {
        imageFillCount++;
      }
    }
    const t = props.text;
    if (t?.family && t.size) {
      const key = `${t.family}|${t.size}|${t.weight ?? 400}`;
      const f = fonts.get(key) ?? { family: t.family, size: t.size, weight: t.weight ?? 400, count: 0 };
      f.count++;
      fonts.set(key, f);
    }
  }

  const byCountDesc = <T extends { count: number }>(m: Map<string, T>) =>
    [...m.values()].sort((a, b) => b.count - a.count);

  res.json({
    colors: byCountDesc(colors).slice(0, 80),
    gradients: byCountDesc(gradients).slice(0, 24),
    fonts: byCountDesc(fonts).slice(0, 40),
    stats: { nodeCount: rows.length, imageFillCount },
  });
});

filesRouter.delete('/:id', async (req, res) => {
  const denied = await editGuard(await fileTeamId(req.params.id), req);
  if (denied) return res.status(403).json({ error: denied });
  await pool.query('DELETE FROM design_files WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---------- 原型交互与静态原型导出（必须注册在 /:id 之前，避免路径被吞） ----------

/** 配置/清除图层「原型交互：跳转到某画板」 */
filesRouter.patch('/:id/nodes/:nodeId', async (req, res) => {
  const { id, nodeId } = req.params;
  const denied = await editGuard(await fileTeamId(id), req);
  if (denied) return res.status(403).json({ error: denied });
  const interaction = (req.body as { interaction?: { targetFrameId?: string } | null }).interaction;
  if (interaction === null || interaction === undefined) {
    await pool.query(`UPDATE nodes SET props = props - 'interaction' WHERE file_id = $1 AND node_id = $2`, [
      id,
      nodeId,
    ]);
    return res.json({ ok: true });
  }
  const target = interaction.targetFrameId;
  if (typeof target !== 'string' || !target) {
    return res.status(400).json({ error: 'interaction.targetFrameId 必填（清除请传 null）' });
  }
  const t = await pool.query('SELECT 1 FROM frames WHERE id = $1 AND file_id = $2', [target, id]);
  if (t.rowCount === 0) {
    return res.status(400).json({ error: '目标画板不属于该设计稿' });
  }
  await pool.query(
    `UPDATE nodes SET props = props || $1::jsonb WHERE file_id = $2 AND node_id = $3`,
    [JSON.stringify({ interaction: { type: 'navigate', targetFrameId: target } }), id, nodeId]
  );
  res.json({ ok: true });
});

/** 原型预览：单文件 HTML（同源引用 /storage 画板渲染图） */
filesRouter.get('/:id/prototype', async (req, res) => {
  const { buildPrototypeHtml } = await import('../prototype.js');
  try {
    const html = await buildPrototypeHtml(req.params.id);
    if (!html) return res.status(404).json({ error: '该设计稿还没有画板' });
    res.type('html').send(html);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '原型生成失败' });
  }
});

/** 原型导出：可分发的 zip（index.html + assets 画板图 + README） */
filesRouter.get('/:id/prototype.zip', async (req, res) => {
  const { buildPrototypeZip } = await import('../prototype.js');
  try {
    const zip = await buildPrototypeZip(req.params.id);
    if (!zip) return res.status(404).json({ error: '该设计稿还没有画板' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zip.name)}`);
    res.send(zip.buf);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '原型导出失败' });
  }
});
