import { Router, type Response } from 'express';
import { pool } from '../db.js';
import { isFigmaConfigured } from '../config.js';
import { FigmaApiError, getFileMeta, parseFigmaUrl } from '../figma/client.js';
import { enqueueImport, fetchImportData, newErrorId, userFacingFailure } from '../jobs/importFile.js';
import { editGuard, fileTeamId } from './authz.js';

export const filesRouter = Router();

const ROUTE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 校验路径里的 UUID；不合法时直接返回 400 JSON，避免 Postgres uuid 转换抛未捕获异常 */
function badUuid(res: Response, ...values: string[]): boolean {
  if (values.some((v) => !ROUTE_UUID_RE.test(v))) {
    res.status(400).json({ error: '非法的 ID 格式：路径参数必须是 UUID' });
    return true;
  }
  return false;
}

/** 把 Figma 错误映射成具体、可操作的提示（不包含令牌或响应体） */
function respondFigmaError(res: Response, err: unknown) {
  if (err instanceof FigmaApiError) {
    // 先区分「令牌问题」与「文件权限问题」，避免把令牌错误说成文件未公开
    if (/invalid token|token.*(invalid|expired)/i.test(err.detail)) {
      return res.status(401).json({
        error: 'Figma 令牌无效或已过期：请检查服务端 FIGMA_TOKEN，或在导入弹窗「高级选项」里填你自己的个人令牌',
      });
    }
    if (/scope/i.test(err.detail)) {
      return res.status(401).json({
        error:
          'Figma 令牌权限不足：当前令牌缺少 file_content:read 权限，请重新生成令牌（或在「高级选项」填有该权限的个人令牌）',
      });
    }
    switch (err.status) {
      case 401:
        return res.status(401).json({
          error: 'Figma 令牌无效或已过期：请检查服务端 FIGMA_TOKEN，或在导入弹窗「高级选项」里填你自己的个人令牌',
        });
      case 403:
        return res.status(403).json({
          error:
            '该 Figma 文件不可访问（403）：请在 Figma 分享设置里改为「任何知道链接的人可查看」，或展开「高级选项」填入有权限的个人令牌',
        });
      case 404:
        return res.status(404).json({
          error:
            '找不到该 Figma 文件或指定画板（404）：请确认链接完整正确，并确认 Figma 分享设置为「任何知道链接的人可查看」',
        });
      case 429: {
        const wait = err.retryAfterSeconds;
        const hint =
          wait >= 3600
            ? `Figma 账号级限流已触发（约 ${Math.ceil(wait / 3600)} 小时后恢复）`
            : wait > 0
              ? `Figma 接口限流（约 ${wait} 秒后恢复）`
              : 'Figma 接口限流';
        return res.status(429).json({
          error: `${hint}：请稍后重试；如需立刻导入，可展开「高级选项」填入你自己的个人令牌，或使用 Figma 插件导入`,
        });
      }
      case 504:
        return res.status(504).json({
          error: `${err.message}：大文件可改用带 node-id 的单画板链接减少数据量，或稍后重试`,
        });
      default:
        return res.status(502).json({ error: `Figma 接口请求失败（${err.status}），请稍后重试` });
    }
  }
  const name = (err as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return res.status(504).json({
      error: '读取 Figma 数据超时：大文件可改用带 node-id 的单画板链接，或稍后重试',
    });
  }
  // 未知异常（TypeError 等）：不把 JS 原生文案抛给用户，只给错误编号，完整堆栈进后端日志
  const errId = newErrorId();
  console.error(`[import] unexpected error ${errId}:`, err);
  return res.status(502).json({ error: userFacingFailure(errId) });
}

/**
 * 导入 Figma 文件。
 * body: { url, projectId?, token? }
 * - url 支持 /design/:key、/file/:key，可带 ?node-id=（- 转 :）
 * - token 为用户个人令牌（可选）；缺省时用服务端 FIGMA_TOKEN
 */
filesRouter.post('/', async (req, res) => {
  const { url, projectId, token } = req.body ?? {};
  let teamId: string | null = null;
  if (projectId) {
    const p = await pool.query<{ team_id: string | null }>('SELECT team_id FROM projects WHERE id = $1', [projectId]);
    if (!p.rows[0]) return res.status(404).json({ error: '项目不存在' });
    teamId = p.rows[0].team_id;
  }
  const denied = await editGuard(teamId, req);
  if (denied) return res.status(403).json({ error: denied });

  const rawUrl = typeof url === 'string' ? url.trim() : '';
  if (!rawUrl) {
    return res.status(400).json({ error: '请粘贴 Figma 文件链接，例如 https://www.figma.com/design/xxxxx/文件名' });
  }
  const parsed = parseFigmaUrl(rawUrl);
  if (!parsed) {
    return res.status(400).json({
      error:
        '无法识别的链接：这不是 Figma 文件链接，或缺少 file key（应形如 https://www.figma.com/design/xxxxx/文件名）',
    });
  }

  const userToken = typeof token === 'string' ? token.trim() : '';
  if (!userToken && !isFigmaConfigured()) {
    return res.status(503).json({
      error: '服务端未配置 Figma 令牌：请展开「高级选项」填入你自己的个人令牌后再导入',
    });
  }

  let prefetched;
  try {
    prefetched = await fetchImportData(parsed.key, {
      nodeId: parsed.nodeId,
      token: userToken || undefined,
    });
  } catch (err) {
    return respondFigmaError(res, err);
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO design_files (figma_key, name, version, status, project_id)
     VALUES ($1, $2, $3, 'pending', $4) RETURNING id`,
    [parsed.key, prefetched.name, prefetched.version, projectId ?? null]
  );
  const id = rows[0].id;
  void enqueueImport(id, parsed.key, {
    nodeId: parsed.nodeId,
    token: userToken || undefined,
    prefetched,
  });
  res.json({
    id,
    name: prefetched.name,
    status: 'pending',
    nodeId: parsed.nodeId,
    frameCount: prefetched.frames.length,
  });
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
      `SELECT id, node_id, name, page_name, page_id, page_sort, width, height, thumb_url, sort_order, platform, scale
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
export const ensurePages = async (fileId: string) => {
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
  if (existing) return res.status(409).json({ error: `已存在同名页面「${existing.name}」` });
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
  const { rows: [dup] } = await pool.query(
    'SELECT id FROM pages WHERE file_id = $1 AND name = $2 AND id <> $3::uuid',
    [req.params.id, name, req.params.pageId]
  );
  if (dup) return res.status(409).json({ error: `已存在同名页面「${name}」` });
  const { rows: [pg] } = await pool.query(
    'UPDATE pages SET name = $1 WHERE id = $2 AND file_id = $3 RETURNING id, name',
    [name, req.params.pageId, req.params.id]
  );
  if (!pg) return res.status(404).json({ error: '页面不存在' });
  await pool.query('UPDATE frames SET page_name = $1 WHERE page_id = $2', [name, pg.id]);
  res.json(pg);
});

/**
 * 删除页面（编组），两种语义：
 * - 默认（dissolve）：解散编组，画板回落为未分组
 * - ?mode=content：删除编组及其中的画板（图层/评论随外键级联删除）
 */
filesRouter.delete('/:id/pages/:pageId', async (req, res) => {
  const denied = await editGuard(await fileTeamId(req.params.id), req);
  if (denied) return res.status(403).json({ error: denied });
  const pageId = req.params.pageId;
  const { rows: [pg] } = await pool.query(
    'SELECT id FROM pages WHERE id = $1::uuid AND file_id = $2::uuid',
    [pageId, req.params.id]
  );
  if (!pg) return res.status(404).json({ error: '页面不存在' });
  const cascade = req.query.mode === 'content';
  let deletedFrames = 0;
  if (cascade) {
    const del = await pool.query<{ id: string }>(
      'DELETE FROM frames WHERE page_id = $1::uuid RETURNING id',
      [pg.id]
    );
    deletedFrames = del.rowCount ?? 0;
    if (del.rows.length) {
      await pool.query('DELETE FROM assets WHERE frame_id = ANY($1::uuid[])', [del.rows.map((r) => r.id)]);
    }
  } else {
    // 解散编组：画板按原组内顺序追加到「未分组」末尾
    const { rows: [{ next }] } = await pool.query<{ next: number }>(
      'SELECT COALESCE(MAX(page_sort), -1) + 1 AS next FROM frames WHERE file_id = $1::uuid AND page_id IS NULL',
      [req.params.id]
    );
    await pool.query(
      `UPDATE frames f SET page_id = NULL, page_name = NULL, page_sort = $1 + t.ord - 1
       FROM (
         SELECT id, row_number() OVER (ORDER BY page_sort, sort_order, name) AS ord
         FROM frames WHERE page_id = $2::uuid
       ) t
       WHERE f.id = t.id`,
      [next, pg.id]
    );
  }
  await pool.query('DELETE FROM pages WHERE id = $1::uuid', [pg.id]);
  res.json({ ok: true, deletedFrames });
});

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** 解析请求体里的 frameIds（去重，忽略非法值） */
const readFrameIds = (body: unknown): string[] => {
  const raw = (body as { frameIds?: unknown })?.frameIds;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((v): v is string => typeof v === 'string' && UUID_RE.test(v)))].slice(0, 500);
};

/** 校验画板都属于该设计稿，返回目标页面信息（pageId=null 表示未分组） */
const resolveMoveTarget = async (fileId: string, pageId: string | null) => {
  if (!pageId) return { pageId: null, pageName: null as string | null };
  const { rows: [pg] } = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM pages WHERE id = $1::uuid AND file_id = $2::uuid',
    [pageId, fileId]
  );
  return pg ? { pageId: pg.id, pageName: pg.name } : null;
};

/** 移动画板到页面（pageId 传 null 表示移出为未分组） */
filesRouter.patch('/:id/frames/:frameId/page', async (req, res) => {
  if (badUuid(res, req.params.id, req.params.frameId)) return;
  const denied = await editGuard(await fileTeamId(req.params.id), req);
  if (denied) return res.status(403).json({ error: denied });
  const pageId = (req.body as { pageId?: string | null }).pageId ?? null;
  const frame = (
    await pool.query<{ id: string }>(
      'SELECT id FROM frames WHERE id = $1::uuid AND file_id = $2::uuid',
      [req.params.frameId, req.params.id]
    )
  ).rows[0];
  if (!frame) return res.status(404).json({ error: '画板不存在' });
  if (pageId) {
    const target = await resolveMoveTarget(req.params.id, pageId);
    if (!target) return res.status(404).json({ error: '目标页面不存在' });
    const { rows: [{ next }] } = await pool.query<{ next: number }>(
      'SELECT COALESCE(MAX(page_sort), -1) + 1 AS next FROM frames WHERE file_id = $1::uuid AND page_id = $2::uuid',
      [req.params.id, target.pageId]
    );
    await pool.query(
      'UPDATE frames SET page_id = $1::uuid, page_name = $2, page_sort = $3 WHERE id = $4::uuid',
      [target.pageId, target.pageName, next, frame.id]
    );
  } else {
    const { rows: [{ next }] } = await pool.query<{ next: number }>(
      'SELECT COALESCE(MAX(page_sort), -1) + 1 AS next FROM frames WHERE file_id = $1::uuid AND page_id IS NULL',
      [req.params.id]
    );
    await pool.query(
      'UPDATE frames SET page_id = NULL, page_name = NULL, page_sort = $1 WHERE id = $2::uuid',
      [next, frame.id]
    );
  }
  res.json({ ok: true });
});

/** 批量移动画板到页面（追加到编组末尾；pageId 传 null 表示移出为未分组） */
filesRouter.patch('/:id/frames/page', async (req, res) => {
  const denied = await editGuard(await fileTeamId(req.params.id), req);
  if (denied) return res.status(403).json({ error: denied });
  const frameIds = readFrameIds(req.body);
  if (!frameIds.length) return res.status(400).json({ error: '请选择要移动的画板' });
  const target = await resolveMoveTarget(req.params.id, (req.body as { pageId?: string | null }).pageId ?? null);
  if (!target) return res.status(404).json({ error: '目标页面不存在' });
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM frames WHERE file_id = $1::uuid AND id = ANY($2::uuid[])',
    [req.params.id, frameIds]
  );
  if (rows.length !== frameIds.length) return res.status(404).json({ error: '部分画板不属于该设计稿' });

  if (target.pageId) {
    const { rows: [{ next }] } = await pool.query<{ next: number }>(
      'SELECT COALESCE(MAX(page_sort), -1) + 1 AS next FROM frames WHERE file_id = $1::uuid AND page_id = $2::uuid',
      [req.params.id, target.pageId]
    );
    await pool.query(
      `UPDATE frames f SET page_id = $1::uuid, page_name = $2, page_sort = $3 + t.ord
       FROM unnest($4::uuid[]) WITH ORDINALITY AS t(id, ord)
       WHERE f.id = t.id AND f.file_id = $5::uuid`,
      [target.pageId, target.pageName, next, frameIds, req.params.id]
    );
  } else {
    // 移出为未分组：追加到「未分组」末尾
    const { rows: [{ next }] } = await pool.query<{ next: number }>(
      'SELECT COALESCE(MAX(page_sort), -1) + 1 AS next FROM frames WHERE file_id = $1::uuid AND page_id IS NULL',
      [req.params.id]
    );
    await pool.query(
      `UPDATE frames f SET page_id = NULL, page_name = NULL, page_sort = $1 + t.ord - 1
       FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id, ord)
       WHERE f.id = t.id AND f.file_id = $3::uuid`,
      [next, frameIds, req.params.id]
    );
  }
  res.json({ ok: true, moved: frameIds.length });
});

/**
 * 批量保存画布自由坐标：拖动落位后写回 frames.canvas_x/canvas_y。
 * body: { positions: [{ id, x, y }] }
 */
filesRouter.patch('/:id/frames/position', async (req, res) => {
  const denied = await editGuard(await fileTeamId(req.params.id), req);
  if (denied) return res.status(403).json({ error: denied });
  const raw = (req.body as { positions?: { id?: string; x?: number; y?: number }[] })?.positions;
  const positions = Array.isArray(raw)
    ? raw.filter(
        (p) =>
          typeof p?.id === 'string' &&
          typeof p.x === 'number' &&
          Number.isFinite(p.x) &&
          typeof p.y === 'number' &&
          Number.isFinite(p.y)
      )
    : [];
  if (!positions.length) return res.status(400).json({ error: '缺少画板坐标' });
  const ids = positions.map((p) => p.id as string);
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM frames WHERE file_id = $1::uuid AND id = ANY($2::uuid[])',
    [req.params.id, ids]
  );
  if (rows.length !== ids.length) return res.status(404).json({ error: '部分画板不属于该设计稿' });
  await pool.query(
    `UPDATE frames f SET canvas_x = v.x, canvas_y = v.y
     FROM unnest($1::uuid[], $2::real[], $3::real[]) AS v(id, x, y)
     WHERE f.id = v.id AND f.file_id = $4::uuid`,
    [ids, positions.map((p) => p.x), positions.map((p) => p.y), req.params.id]
  );
  res.json({ ok: true, saved: ids.length });
});

/**
 * 编组内排序：frameIds 为目标编组的完整顺序（会自动把画板移入目标编组）。
 * pageId 传 null 表示未分组。
 */
filesRouter.patch('/:id/frames/order', async (req, res) => {
  const denied = await editGuard(await fileTeamId(req.params.id), req);
  if (denied) return res.status(403).json({ error: denied });
  const frameIds = readFrameIds(req.body);
  if (!frameIds.length) return res.status(400).json({ error: '缺少画板顺序' });
  const target = await resolveMoveTarget(req.params.id, (req.body as { pageId?: string | null }).pageId ?? null);
  if (!target) return res.status(404).json({ error: '目标页面不存在' });
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM frames WHERE file_id = $1::uuid AND id = ANY($2::uuid[])',
    [req.params.id, frameIds]
  );
  if (rows.length !== frameIds.length) return res.status(404).json({ error: '部分画板不属于该设计稿' });
  await pool.query(
    `UPDATE frames f SET page_id = $1::uuid, page_name = $2, page_sort = t.ord - 1
     FROM unnest($3::uuid[]) WITH ORDINALITY AS t(id, ord)
     WHERE f.id = t.id AND f.file_id = $4::uuid`,
    [target.pageId, target.pageName, frameIds, req.params.id]
  );
  res.json({ ok: true, ordered: frameIds.length });
});

/** 画板详情（含全部图层，平铺，客户端组树） */
filesRouter.get('/:id/frames/:frameId', async (req, res) => {
  // 非法 UUID 直接 400：避免把脏参数传给 Postgres 触发未捕获异常导致进程退出
  if (badUuid(res, req.params.id, req.params.frameId)) return;
  const frame = (
    await pool.query(
      `SELECT id, file_id, node_id, name, page_name, page_id, page_sort, width, height, thumb_url, platform, scale
       FROM frames WHERE id = $1 AND file_id = $2`,
      [req.params.frameId, req.params.id]
    )
  ).rows[0];
  if (!frame) return res.status(404).json({ error: '画板不存在' });
  const nodes = (
    await pool.query(
      `SELECT id, node_id, parent_id, name, type, x, y, width, height, props, render_url
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
    return respondFigmaError(res, err);
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

/** 重命名设计稿 */
filesRouter.patch('/:id', async (req, res) => {
  const denied = await editGuard(await fileTeamId(req.params.id), req);
  if (denied) return res.status(403).json({ error: denied });
  const name = typeof (req.body as { name?: unknown })?.name === 'string' ? (req.body as { name: string }).name.trim() : '';
  if (!name || name.length > 100) return res.status(400).json({ error: '名称需为 1-100 个字符' });
  const { rows } = await pool.query(
    'UPDATE design_files SET name = $1 WHERE id = $2::uuid RETURNING id, name',
    [name, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: '文件不存在' });
  res.json(rows[0]);
});

/** 重命名画板 */
filesRouter.patch('/:id/frames/:frameId', async (req, res) => {
  if (badUuid(res, req.params.id, req.params.frameId)) return;
  const denied = await editGuard(await fileTeamId(req.params.id), req);
  if (denied) return res.status(403).json({ error: denied });
  const name = typeof (req.body as { name?: unknown })?.name === 'string' ? (req.body as { name: string }).name.trim() : '';
  if (!name || name.length > 100) return res.status(400).json({ error: '名称需为 1-100 个字符' });
  const { rows } = await pool.query(
    'UPDATE frames SET name = $1 WHERE id = $2::uuid AND file_id = $3::uuid RETURNING id, name',
    [name, req.params.frameId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: '画板不存在' });
  res.json(rows[0]);
});

/** 删除画板（nodes / comments 由外键级联删除） */
filesRouter.delete('/:id/frames/:frameId', async (req, res) => {
  if (badUuid(res, req.params.id, req.params.frameId)) return;
  const denied = await editGuard(await fileTeamId(req.params.id), req);
  if (denied) return res.status(403).json({ error: denied });
  const { rowCount } = await pool.query(
    'DELETE FROM frames WHERE id = $1::uuid AND file_id = $2::uuid',
    [req.params.frameId, req.params.id]
  );
  if (!rowCount) return res.status(404).json({ error: '画板不存在' });
  res.json({ ok: true });
});

// ---------- 原型交互与静态原型导出（必须注册在 /:id 之前，避免路径被吞） ----------

/** 配置/清除图层「原型交互：跳转到某画板」 */
filesRouter.patch('/:id/nodes/:nodeId', async (req, res) => {
  const { id, nodeId } = req.params;
  const denied = await editGuard(await fileTeamId(id), req);
  if (denied) return res.status(403).json({ error: denied });
  // 文本图层内容：写回 props.text.content（画布按此渲染）
  const textContent = (req.body as { text?: unknown }).text;
  if (typeof textContent === 'string') {
    const r = await pool.query(
      `UPDATE nodes SET props = jsonb_set(props, '{text,content}', to_jsonb($1::text), true)
       WHERE file_id = $2 AND node_id = $3`,
      [textContent, id, nodeId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: '图层不存在' });
    return res.json({ ok: true });
  }
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
