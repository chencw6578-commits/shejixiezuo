import express, { Router } from 'express';
import { pool } from '../db.js';
import { editGuard } from './authz.js';
import { PluginImportError, parsePluginExport } from '../figma/pluginImport.js';
import { importPluginJson, newErrorId, userFacingFailure } from '../jobs/importFile.js';

export const importJsonRouter = Router();

// 插件导出的大文件可能超过全局 1mb 限制，这里单独放宽到 20mb
importJsonRouter.use(express.json({ limit: '20mb' }));

/**
 * 接收 Figma 插件导出的 JSON 并落库（不调用 Figma REST，不受限流影响）。
 * body: { json: object | string, projectId?, fileName? }
 */
importJsonRouter.post('/figma-json', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const raw = body.json ?? body.payload ?? req.body;

  let payload: unknown = raw;
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw);
    } catch {
      return res.status(400).json({
        error: 'JSON 解析失败：请粘贴 Figma 插件导出的完整 JSON 文本（不是链接、截图或文件名）',
      });
    }
  }

  // 项目归属与只读校验（与 Figma 链接导入保持一致）
  let projectId: string | null = null;
  const rawProjectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  if (rawProjectId) {
    const project = await pool.query<{ team_id: string | null }>(
      'SELECT team_id FROM projects WHERE id = $1',
      [rawProjectId]
    );
    if (!project.rows[0]) return res.status(404).json({ error: '项目不存在' });
    const denied = await editGuard(project.rows[0].team_id, req);
    if (denied) return res.status(403).json({ error: denied });
    projectId = rawProjectId;
  } else {
    const denied = await editGuard(null, req);
    if (denied) return res.status(403).json({ error: denied });
  }

  let parsed;
  try {
    parsed = parsePluginExport(payload);
  } catch (err) {
    if (err instanceof PluginImportError) return res.status(400).json({ error: err.message });
    const errId = newErrorId();
    console.error(`[plugin-import] unexpected validation error ${errId}:`, err);
    return res.status(502).json({ error: userFacingFailure(errId) });
  }

  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO design_files (figma_key, name, version, status, source, project_id)
       VALUES ($1, $2, $3, 'pending', 'plugin', $4) RETURNING id`,
      [`plugin:${Date.now().toString(36)}`, parsed.name, parsed.version, projectId]
    );
    const fileId = rows[0].id;
    const counts = await importPluginJson(fileId, parsed);
    return res.status(201).json({
      id: fileId,
      name: parsed.name,
      frameCount: counts.frameCount,
      nodeCount: counts.nodeCount,
      skipped: parsed.skipped,
    });
  } catch (err) {
    const errId = newErrorId();
    console.error(`[plugin-import] unexpected error ${errId}:`, err);
    return res.status(502).json({ error: userFacingFailure(errId) });
  }
});
