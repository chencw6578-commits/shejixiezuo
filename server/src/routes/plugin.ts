import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { pool } from '../db.js';
import { getStorage } from '../storage/index.js';
import { PluginImportError, parsePluginExport } from '../figma/pluginImport.js';
import { newErrorId, userFacingFailure } from '../jobs/importFile.js';
import { batchInsert } from '../util/batchInsert.js';

export const pluginRouter = Router();

// 插件逐画板上传，单张 PNG 可能到达数 MB：单独放宽解析上限（必须挂在全局 1mb 解析器之前）
pluginRouter.use(express.json({ limit: '40mb' }));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORMS = new Set(['ios', 'android', 'web']);
const SCALES = new Set([1, 2, 3]);
/** 单张位图上限：超过则跳过并给出可读提示（不阻断画板与节点落库） */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 单次请求最多画板数：位图很大，插件默认逐个上传 */
const MAX_BOARDS_PER_REQUEST = 12;

/** 令牌作用范围：team=仅创建时的团队；all=创建该令牌的账号下全部团队 */
type TokenScope = 'all' | 'team';

interface PluginCtx {
  teamId: string;
  teamName: string;
  tokenId: string;
  scope: TokenScope;
}

type PluginReq = Request & { pluginCtx?: PluginCtx };

const ctxOf = (req: Request): PluginCtx => (req as PluginReq).pluginCtx as PluginCtx;

/** 每个项目的插件导入设计稿共用一条记录，保证重复导入可原位更新 */
const pluginFileKey = (projectId: string) => `plugin:project:${projectId}`;

/** Bearer 导入令牌鉴权：只存哈希，撤销立即失效 */
async function pluginAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const header = (req.header('authorization') ?? '').trim();
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m || !m[1].trim()) {
      return res.status(401).json({
        error: '缺少导入令牌：请在插件里填写网站「团队设置 → 导入令牌」生成的 imp_ 令牌',
      });
    }
    const token = m[1].trim();
    if (!/^imp_[A-Za-z0-9_-]{16,}$/.test(token)) {
      return res.status(401).json({ error: '导入令牌格式不正确（应以 imp_ 开头）' });
    }
    const hash = createHash('sha256').update(token).digest('hex');
    const { rows } = await pool.query<{
      id: string;
      team_id: string;
      team_name: string;
      scope: string;
    }>(
      `SELECT it.id, it.scope, t.id AS team_id, t.name AS team_name
       FROM import_tokens it JOIN teams t ON t.id = it.team_id
       WHERE it.hash = $1 AND it.revoked_at IS NULL LIMIT 1`,
      [hash]
    );
    if (!rows[0]) {
      return res.status(401).json({ error: '导入令牌无效或已撤销：请在网站「团队设置」重新生成' });
    }
    await pool.query('UPDATE import_tokens SET last_used_at = now() WHERE id = $1', [rows[0].id]);
    (req as PluginReq).pluginCtx = {
      teamId: rows[0].team_id,
      teamName: rows[0].team_name,
      tokenId: rows[0].id,
      scope: rows[0].scope === 'all' ? 'all' : 'team',
    };
    next();
  } catch (err) {
    const errId = newErrorId();
    console.error(`[plugin-api] auth failed ${errId}:`, err);
    res.status(502).json({ error: userFacingFailure(errId) });
  }
}

pluginRouter.use(pluginAuth);

/** 未归属团队的伪 ID：team_id IS NULL 的历史项目归到这里（仅「全部团队」令牌可见） */
const UNASSIGNED_TEAM = 'unassigned';

/** 令牌是否有权访问某个团队 */
async function teamAccess(
  rawTeamId: string,
  ctx: PluginCtx
): Promise<{ ok: true; teamId: string | null } | { ok: false; status: 404 | 403 }> {
  if (rawTeamId === UNASSIGNED_TEAM) {
    return ctx.scope === 'all' ? { ok: true, teamId: null } : { ok: false, status: 403 };
  }
  if (!UUID_RE.test(rawTeamId)) return { ok: false, status: 404 };
  if (ctx.scope === 'team' && rawTeamId !== ctx.teamId) return { ok: false, status: 403 };
  const t = await pool.query('SELECT 1 FROM teams WHERE id = $1', [rawTeamId]);
  return t.rows[0] ? { ok: true, teamId: rawTeamId } : { ok: false, status: 404 };
}

/** 项目访问：不存在 404；存在但令牌无权访问 403（不能伪装成空列表） */
async function projectAccess(
  projectId: string,
  ctx: PluginCtx
): Promise<
  | { ok: true; project: { id: string; name: string; team_id: string | null } }
  | { ok: false; status: 404 | 403 }
> {
  const { rows } = await pool.query<{ id: string; name: string; team_id: string | null }>(
    'SELECT id, name, team_id FROM projects WHERE id = $1',
    [projectId]
  );
  const project = rows[0];
  if (!project) return { ok: false, status: 404 };
  if (ctx.scope === 'all') return { ok: true, project };
  return project.team_id === ctx.teamId ? { ok: true, project } : { ok: false, status: 403 };
}

/** 越权固定文案：明确是权限问题，而不是「没有数据」 */
function forbidden(res: Response, what: '团队' | '项目' | '编组') {
  return res.status(403).json({
    error: `令牌无权访问该${what}（权限问题）：请在网站「团队设置」重新生成作用范围为「全部团队」的导入令牌`,
  });
}

/** 取（或创建）项目下共用的插件导入设计稿 */
async function ensurePluginFile(
  projectId: string,
  platform?: string,
  scale?: number
): Promise<string> {
  const key = pluginFileKey(projectId);
  const existing = await pool.query<{ id: string }>(
    'SELECT id FROM design_files WHERE project_id = $1 AND figma_key = $2 LIMIT 1',
    [projectId, key]
  );
  if (existing.rows[0]) {
    if (platform && scale) {
      await pool.query(
        `UPDATE design_files SET platform = $2, scale = $3, status = 'ready', error = NULL WHERE id = $1`,
        [existing.rows[0].id, platform, scale]
      );
    }
    return existing.rows[0].id;
  }
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO design_files (figma_key, name, version, status, source, project_id, platform, scale)
     VALUES ($1, 'Figma 插件导入', $2, 'ready', 'plugin', $3, $4, $5) RETURNING id`,
    [key, new Date().toISOString(), projectId, platform ?? null, scale ?? null]
  );
  return rows[0].id;
}

/** 按名称取编组，不存在则创建（同名复用，插件逐个画板上传时不会重复建组） */
async function ensureGroup(fileId: string, name: string): Promise<{ id: string; name: string }> {
  const found = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM pages WHERE file_id = $1 AND name = $2 LIMIT 1',
    [fileId, name]
  );
  if (found.rows[0]) return found.rows[0];
  const next = await pool.query<{ next: number }>(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM pages WHERE file_id = $1',
    [fileId]
  );
  const inserted = await pool.query<{ id: string; name: string }>(
    `INSERT INTO pages (file_id, name, sort_order) VALUES ($1, $2, $3)
     ON CONFLICT (file_id, name) DO NOTHING RETURNING id, name`,
    [fileId, name, next.rows[0].next]
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const again = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM pages WHERE file_id = $1 AND name = $2 LIMIT 1',
    [fileId, name]
  );
  return again.rows[0];
}

/** GET /api/plugin/me → 令牌所属团队与作用范围 */
pluginRouter.get('/me', (req, res) => {
  const ctx = ctxOf(req);
  res.json({ teamId: ctx.teamId, teamName: ctx.teamName, scope: ctx.scope });
});

const PROJECT_LIST_SQL = `
  SELECT p.id, p.name, p.team_id,
         (SELECT count(*)::int FROM frames fr
          JOIN design_files df ON df.id = fr.file_id
          WHERE df.project_id = p.id) AS frame_count
  FROM projects p`;

/** GET /api/plugin/teams → 令牌可访问的团队（id / name / 项目数） */
pluginRouter.get('/teams', async (req, res) => {
  try {
    const ctx = ctxOf(req);
    const { rows } = await pool.query<{ id: string; name: string; project_count: number }>(
      `SELECT t.id, t.name,
              (SELECT count(*)::int FROM projects p WHERE p.team_id = t.id) AS project_count
       FROM teams t
       ${ctx.scope === 'team' ? 'WHERE t.id = $1' : ''}
       ORDER BY t.created_at DESC LIMIT 200`,
      ctx.scope === 'team' ? [ctx.teamId] : []
    );
    // 「全部团队」令牌额外带上未归属团队的历史项目
    if (ctx.scope === 'all') {
      const un = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM projects WHERE team_id IS NULL'
      );
      if (un.rows[0].n > 0) {
        rows.push({ id: UNASSIGNED_TEAM, name: '未归属团队', project_count: un.rows[0].n });
      }
    }
    res.json(rows);
  } catch (err) {
    const errId = newErrorId();
    console.error(`[plugin-api] teams ${errId}:`, err);
    res.status(502).json({ error: userFacingFailure(errId) });
  }
});

/** GET /api/plugin/teams/:teamId/projects → 指定团队的项目（id / name / 画板数） */
pluginRouter.get('/teams/:teamId/projects', async (req, res) => {
  try {
    const ctx = ctxOf(req);
    const access = await teamAccess(req.params.teamId, ctx);
    if (!access.ok) {
      if (access.status === 403) return forbidden(res, '团队');
      return res.status(404).json({ error: '团队不存在' });
    }
    const { rows } = await pool.query(
      `${PROJECT_LIST_SQL}
       WHERE ${access.teamId === null ? 'p.team_id IS NULL' : 'p.team_id = $1'}
       ORDER BY p.created_at DESC LIMIT 200`,
      access.teamId === null ? [] : [access.teamId]
    );
    res.json(rows);
  } catch (err) {
    const errId = newErrorId();
    console.error(`[plugin-api] team projects ${errId}:`, err);
    res.status(502).json({ error: userFacingFailure(errId) });
  }
});

/** GET /api/plugin/projects → 兼容旧版：令牌可访问的全部项目 */
pluginRouter.get('/projects', async (req, res) => {
  try {
    const ctx = ctxOf(req);
    const { rows } = await pool.query(
      `${PROJECT_LIST_SQL}
       ${ctx.scope === 'team' ? 'WHERE p.team_id = $1' : ''}
       ORDER BY p.created_at DESC LIMIT 200`,
      ctx.scope === 'team' ? [ctx.teamId] : []
    );
    res.json(rows);
  } catch (err) {
    const errId = newErrorId();
    console.error(`[plugin-api] projects ${errId}:`, err);
    res.status(502).json({ error: userFacingFailure(errId) });
  }
});

/** GET /api/plugin/projects/:id/groups → 编组列表（含每组画板数）+ 未分组数量 */
pluginRouter.get('/projects/:id/groups', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: '非法的项目 ID' });
  try {
    const ctx = ctxOf(req);
    const access = await projectAccess(req.params.id, ctx);
    if (!access.ok) {
      if (access.status === 403) return forbidden(res, '项目');
      return res.status(404).json({ error: '项目不存在' });
    }
    const project = access.project;
    const file = await pool.query<{ id: string }>(
      'SELECT id FROM design_files WHERE project_id = $1 AND figma_key = $2 LIMIT 1',
      [project.id, pluginFileKey(project.id)]
    );
    if (!file.rows[0]) {
      return res.json({ fileId: null, groups: [], ungrouped: 0 });
    }
    const fileId = file.rows[0].id;
    const groups = (
      await pool.query(
        `SELECT pg.id, pg.name, pg.sort_order,
                (SELECT count(*)::int FROM frames fr WHERE fr.page_id = pg.id) AS frame_count
         FROM pages pg WHERE pg.file_id = $1
         ORDER BY pg.sort_order, pg.created_at`,
        [fileId]
      )
    ).rows;
    const ungrouped = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM frames WHERE file_id = $1 AND page_id IS NULL',
      [fileId]
    );
    res.json({ fileId, groups, ungrouped: ungrouped.rows[0].n });
  } catch (err) {
    const errId = newErrorId();
    console.error(`[plugin-api] groups ${errId}:`, err);
    res.status(502).json({ error: userFacingFailure(errId) });
  }
});

/** POST /api/plugin/projects/:id/groups → 新建编组（同名复用） */
pluginRouter.post('/projects/:id/groups', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: '非法的项目 ID' });
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: '请输入编组名称' });
  if (name.length > 50) return res.status(400).json({ error: '编组名称过长（最多 50 字）' });
  try {
    const ctx = ctxOf(req);
    const access = await projectAccess(req.params.id, ctx);
    if (!access.ok) {
      if (access.status === 403) return forbidden(res, '项目');
      return res.status(404).json({ error: '项目不存在' });
    }
    const project = access.project;
    const fileId = await ensurePluginFile(project.id);
    const group = await ensureGroup(fileId, name);
    res.status(201).json(group);
  } catch (err) {
    const errId = newErrorId();
    console.error(`[plugin-api] create group ${errId}:`, err);
    res.status(502).json({ error: userFacingFailure(errId) });
  }
});

/**
 * POST /api/plugin/import
 * body: {
 *   platform: 'ios' | 'android' | 'web',
 *   scale: 1 | 2 | 3,
 *   projectId, groupId? | newGroupName?,
 *   boards: [导出的画板节点...],
 *   images?: [{ nodeId, dataUrl }]
 * }
 * 同一个 Figma 节点 id 在项目的插件导入设计稿里重复出现时原位更新，不新增重复画板。
 */
pluginRouter.post('/import', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const platform = typeof body.platform === 'string' ? body.platform : '';
  if (!PLATFORMS.has(platform)) {
    return res.status(400).json({ error: 'platform 必须是 ios / android / web' });
  }
  const scale = Number(body.scale);
  if (!SCALES.has(scale)) {
    return res.status(400).json({ error: 'scale 必须是 1 / 2 / 3' });
  }
  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  if (!UUID_RE.test(projectId)) return res.status(400).json({ error: '非法的项目 ID' });

  // 先校验令牌对项目的访问权：越权必须在任何数据校验之前返回 403
  try {
    const access = await projectAccess(projectId, ctxOf(req));
    if (!access.ok) {
      if (access.status === 403) return forbidden(res, '项目');
      return res.status(404).json({ error: '项目不存在' });
    }
  } catch (err) {
    const errId = newErrorId();
    console.error(`[plugin-api] import access ${errId}:`, err);
    return res.status(502).json({ error: userFacingFailure(errId) });
  }

  const boards = Array.isArray(body.boards) ? body.boards : [];
  if (!boards.length) return res.status(400).json({ error: '缺少画板数据（boards 不能为空）' });
  if (boards.length > MAX_BOARDS_PER_REQUEST) {
    return res.status(400).json({
      error: `单次最多 ${MAX_BOARDS_PER_REQUEST} 个画板：位图较大，请让插件逐个画板上传`,
    });
  }

  const rawImages = Array.isArray(body.images) ? body.images : [];

  let frames;
  let skipped = 0;
  try {
    const parsed = parsePluginExport({
      schemaVersion: 1,
      generator: 'shejixiezuo-figma-plugin',
      pluginVersion: body.pluginVersion,
      exportedAt: body.exportedAt,
      file: body.file,
      artboards: boards,
    });
    frames = parsed.frames;
    skipped = parsed.skipped;
  } catch (err) {
    if (err instanceof PluginImportError) return res.status(400).json({ error: err.message });
    const errId = newErrorId();
    console.error(`[plugin-api] parse failed ${errId}:`, err);
    return res.status(502).json({ error: userFacingFailure(errId) });
  }

  let fileId: string;
  let groupId: string | null = null;
  let groupName: string | null = null;
  try {
    fileId = await ensurePluginFile(projectId, platform, scale);

    const rawGroupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
    const rawGroupName = typeof body.newGroupName === 'string' ? body.newGroupName.trim() : '';
    if (rawGroupId) {
      if (!UUID_RE.test(rawGroupId)) return res.status(400).json({ error: '非法的编组 ID' });
      const pg = await pool.query<{ id: string; name: string }>(
        'SELECT id, name FROM pages WHERE id = $1 AND file_id = $2',
        [rawGroupId, fileId]
      );
      if (!pg.rows[0]) return res.status(404).json({ error: '编组不存在或不属于该项目的插件导入设计稿' });
      groupId = pg.rows[0].id;
      groupName = pg.rows[0].name;
    } else if (rawGroupName) {
      const name = rawGroupName.slice(0, 50);
      const group = await ensureGroup(fileId, name);
      groupId = group.id;
      groupName = group.name;
    }
  } catch (err) {
    const errId = newErrorId();
    console.error(`[plugin-api] prepare import ${errId}:`, err);
    return res.status(502).json({ error: userFacingFailure(errId) });
  }

  const warnings: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const nextSort = await client.query<{ next: number }>(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM frames WHERE file_id = $1',
      [fileId]
    );
    const pageSorts = new Map<string, number>();
    const groupKey = groupId ?? '__none';
    /** 依次取目标编组内下一个排序号（未分组与具名编组分别计数） */
    const takePageSort = async () => {
      let next = pageSorts.get(groupKey);
      if (next === undefined) {
        const { rows } = await client.query<{ next: number }>(
          `SELECT COALESCE(MAX(page_sort), -1) + 1 AS next FROM frames
           WHERE file_id = $1 AND (($2::uuid IS NULL AND page_id IS NULL) OR page_id = $2::uuid)`,
          [fileId, groupId]
        );
        next = rows[0].next;
      }
      pageSorts.set(groupKey, next + 1);
      return next;
    };

    const nodeRows: unknown[][] = [];
    let nodeCount = 0;
    let frameCount = 0;

    for (const frame of frames) {
      const existing = await client.query<{ id: string; file_id: string }>(
        `SELECT fr.id, fr.file_id FROM frames fr
         JOIN design_files df ON df.id = fr.file_id
         WHERE df.project_id = $1 AND df.figma_key = $2 AND fr.node_id = $3 LIMIT 1`,
        [projectId, pluginFileKey(projectId), frame.nodeId]
      );

      let frameId: string;
      let frameFileId = fileId;
      if (existing.rows[0]) {
        frameFileId = existing.rows[0].file_id;
        const pageSort = await takePageSort();
        await client.query(
          `UPDATE frames SET name = $2, page_name = $3, page_id = $4, page_sort = $5,
                  width = $6, height = $7, platform = $8, scale = $9
           WHERE id = $1`,
          [
            existing.rows[0].id,
            frame.name,
            groupName,
            groupId,
            pageSort,
            frame.width,
            frame.height,
            platform,
            scale,
          ]
        );
        await client.query('DELETE FROM nodes WHERE frame_id = $1', [existing.rows[0].id]);
        frameId = existing.rows[0].id;
      } else {
        const sortOrder = nextSort.rows[0].next + frameCount;
        const pageSort = await takePageSort();
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO frames (file_id, node_id, name, page_name, page_id, page_sort, width, height, sort_order, platform, scale)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [
            fileId,
            frame.nodeId,
            frame.name,
            groupName,
            groupId,
            pageSort,
            frame.width,
            frame.height,
            sortOrder,
            platform,
            scale,
          ]
        );
        frameId = inserted.rows[0].id;
      }
      frameCount++;

      for (const layer of frame.layers) {
        nodeRows.push([
          frameFileId,
          frameId,
          layer.nodeId,
          layer.parentId,
          layer.name,
          layer.type,
          layer.x,
          layer.y,
          layer.width,
          layer.height,
          true,
          JSON.stringify(layer.props ?? {}),
          null,
        ]);
        nodeCount++;
      }
    }

    if (nodeRows.length > 0) {
      await batchInsert(
        client,
        `INSERT INTO nodes (file_id, frame_id, node_id, parent_id, name, type, x, y, width, height, visible, props, render_url)`,
        nodeRows
      );
    }

    await client.query('COMMIT');

    // 位图：逐张解码落 storage，超 5MB 只跳过图片、不影响画板与节点
    const storage = await getStorage();
    for (const raw of rawImages) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const nodeId = typeof item.nodeId === 'string' ? item.nodeId : '';
      const dataUrl = typeof item.dataUrl === 'string' ? item.dataUrl : '';
      if (!nodeId || !dataUrl) continue;
      const frame = frames.find((f) => f.nodeId === nodeId);
      if (!frame) {
        warnings.push(`位图对应的画板 ${nodeId} 不在本次上传中，已忽略`);
        continue;
      }
      const b64 = dataUrl.replace(/^data:image\/(?:png|jpeg);base64,/i, '');
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length) {
        warnings.push(`「${frame.name}」的位图为空，已跳过`);
        continue;
      }
      if (buf.length > MAX_IMAGE_BYTES) {
        const mb = (buf.length / 1024 / 1024).toFixed(1);
        warnings.push(`「${frame.name}」的位图 ${mb}MB 超过 5MB，已跳过（可降低倍率或关闭位图导出）`);
        continue;
      }
      const frameRow = await pool.query<{ id: string; file_id: string }>(
        `SELECT fr.id, fr.file_id FROM frames fr
         JOIN design_files df ON df.id = fr.file_id
         WHERE df.project_id = $1 AND df.figma_key = $2 AND fr.node_id = $3 LIMIT 1`,
        [projectId, pluginFileKey(projectId), nodeId]
      );
      if (!frameRow.rows[0]) continue;
      const targetFileId = frameRow.rows[0].file_id;
      const key = `files/${targetFileId}/frames/${nodeId}@${scale}x.png`;
      const url = await storage.put(key, buf, 'image/png');
      await pool.query('UPDATE frames SET thumb_url = $2 WHERE id = $1', [frameRow.rows[0].id, url]);
      await pool.query(
        `DELETE FROM assets WHERE file_id = $1 AND node_id = $2 AND format = 'PNG' AND scale = $3`,
        [targetFileId, nodeId, scale]
      );
      await pool.query(
        `INSERT INTO assets (file_id, frame_id, node_id, name, format, scale, width, height, url)
         VALUES ($1, $2, $3, $4, 'PNG', $5, $6, $7, $8)`,
        [
          targetFileId,
          frameRow.rows[0].id,
          nodeId,
          frame.name,
          scale,
          frame.width,
          frame.height,
          url,
        ]
      );
    }

    res.status(201).json({
      projectId,
      fileId,
      groupId,
      groupName,
      frameCount,
      nodeCount,
      skipped,
      warnings,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const errId = newErrorId();
    console.error(`[plugin-api] import failed ${errId}:`, err);
    res.status(502).json({ error: userFacingFailure(errId) });
  } finally {
    client.release();
  }
});

/** 兜底：未匹配的 /api/plugin 路径统一返回 JSON，避免落进 SPA 的 index.html */
pluginRouter.use((_req, res) => res.status(404).json({ error: 'not found' }));
