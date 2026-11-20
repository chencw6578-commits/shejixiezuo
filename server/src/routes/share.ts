import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pool } from '../db.js';
import { getSessionUser, sessionSecret } from '../auth.js';
import { privateTeamStorage } from '../config.js';
import { editGuard } from './authz.js';
import { requirePrivateAccess } from './privateAccess.js';
import { privateAssetKey } from '../storage/index.js';
import { sendPrivateAsset } from './privateStorage.js';

/**
 * 项目公开只读分享。
 *
 * 链接形态：/share/<body>.<sig>，其中 body = base64url({v,sid,pid})，
 * sig = HMAC-SHA256(AUTH_SECRET, 'share:' + body)。
 * 密钥统一取自 auth.ts 的 sessionSecret()：生产缺 AUTH_SECRET 直接拒绝启动，
 * 不再回退到可猜测的硬编码值。
 * - 库里只存分享记录 id（sid），不存明文 token；DB 泄露也无法伪造链接。
 * - 同一个项目始终签发同一个链接（幂等），复制一次即可长期用。
 * - 关闭分享 = 删除该记录，所有据此签发的链接立即失效，无需轮换密钥。
 * - 公开读取接口不要求登录，且只返回展示所需的白名单字段。
 */
export const shareRouter = Router();

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function signature(body: string): string {
  return createHmac('sha256', sessionSecret()).update(`share:${body}`).digest('base64url');
}

function issueToken(sid: string, pid: string): string {
  const body = Buffer.from(JSON.stringify({ v: 1, sid, pid })).toString('base64url');
  return `${body}.${signature(body)}`;
}

function readToken(token: string): { sid: string; pid: string } | null {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, sig] = parts;
  const expected = Buffer.from(signature(body));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload?.v !== 1 || typeof payload.sid !== 'string' || typeof payload.pid !== 'string') return null;
    return { sid: payload.sid, pid: payload.pid };
  } catch {
    return null;
  }
}

/** Express 4 不自动捕获 async 异常：统一兜底，避免请求悬挂 */
const wrap = (fn: (req: import('express').Request, res: import('express').Response) => Promise<void>) =>
  (req: import('express').Request, res: import('express').Response) => {
    void fn(req, res).catch((err) => {
      console.error('[share] request failed:', err);
      if (!res.headersSent) res.status(500).json({ error: '服务暂时不可用，请稍后重试' });
    });
  };

shareRouter.use('/projects/:id', requirePrivateAccess('project', (req) => req.params.id));

async function mayManageShare(pid: string, req: import('express').Request, res: import('express').Response) {
  if (!privateTeamStorage) return true;
  const { rows } = await pool.query<{ team_id: string }>('SELECT team_id FROM projects WHERE id = $1', [pid]);
  const denied = await editGuard(rows[0]?.team_id, req);
  if (!denied) return true;
  res.status(403).json({ error: denied });
  return false;
}

/** 登录态：查询当前项目是否已开启分享（已开启则回显链接，链接是确定性签发的） */
shareRouter.get('/projects/:id', wrap(async (req, res) => {
  const user = getSessionUser(req);
  if (!user) { res.status(401).json({ error: '请先登录' }); return; }
  const pid = req.params.id;
  if (!isUuid(pid)) { res.status(400).json({ error: '项目 ID 无效' }); return; }
  if (!await mayManageShare(pid, req, res)) return;
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM project_shares WHERE project_id = $1', [pid]
  );
  const sid = rows[0]?.id;
  res.json({ active: !!sid, url: sid ? `/share/${issueToken(sid, pid)}` : null });
}));

/** 登录态：开启分享（幂等，已有记录则复用） */
shareRouter.post('/projects/:id', wrap(async (req, res) => {
  const user = getSessionUser(req);
  if (!user) { res.status(401).json({ error: '请先登录' }); return; }
  const pid = req.params.id;
  if (!isUuid(pid)) { res.status(400).json({ error: '项目 ID 无效' }); return; }
  if (!await mayManageShare(pid, req, res)) return;
  const project = await pool.query('SELECT 1 FROM projects WHERE id = $1', [pid]);
  if (!project.rows[0]) { res.status(404).json({ error: '项目不存在' }); return; }
  let { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM project_shares WHERE project_id = $1', [pid]
  );
  if (!rows[0]) {
    const inserted = await pool.query<{ id: string }>(
      'INSERT INTO project_shares (project_id, created_by) VALUES ($1, $2) '
      + 'ON CONFLICT (project_id) DO UPDATE SET project_id = EXCLUDED.project_id RETURNING id',
      [pid, user.email]
    );
    rows = inserted.rows;
  }
  const sid = rows[0].id;
  res.json({ active: true, url: `/share/${issueToken(sid, pid)}` });
}));

/** 登录态：关闭分享（删除记录后旧链接立即失效） */
shareRouter.delete('/projects/:id', wrap(async (req, res) => {
  if (!getSessionUser(req)) { res.status(401).json({ error: '请先登录' }); return; }
  const pid = req.params.id;
  if (!isUuid(pid)) { res.status(400).json({ error: '项目 ID 无效' }); return; }
  if (!await mayManageShare(pid, req, res)) return;
  await pool.query('DELETE FROM project_shares WHERE project_id = $1', [pid]);
  res.json({ active: false, url: null });
}));

/**
 * 公开只读：无需登录。
 * 只返回项目名与画板展示字段，不返回团队、成员、图层原始数据、评论等。
 */
async function sharedProjectId(token: string): Promise<string | null> {
  const parsed = readToken(token);
  if (!parsed || !isUuid(parsed.sid) || !isUuid(parsed.pid)) return null;
  const share = await pool.query(
    `SELECT 1 FROM project_shares s JOIN projects p ON p.id = s.project_id
     WHERE s.id = $1 AND s.project_id = $2 AND (NOT $3::boolean OR p.team_id IS NOT NULL)`,
    [parsed.sid, parsed.pid, privateTeamStorage]
  );
  return share.rows[0] ? parsed.pid : null;
}

shareRouter.get('/:token', wrap(async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const pid = await sharedProjectId(req.params.token);
  if (!pid) { res.status(404).json({ error: '分享已关闭或链接已失效' }); return; }
  const project = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM projects WHERE id = $1', [pid]
  );
  if (!project.rows[0]) { res.status(404).json({ error: '项目不存在或已被删除' }); return; }
  const frames = await pool.query(
    `SELECT fr.id, fr.file_id, fr.name, fr.page_name, fr.width, fr.height, fr.thumb_url,
            df.name AS file_name
     FROM frames fr
     JOIN design_files df ON df.id = fr.file_id
     WHERE df.project_id = $1 AND df.status = 'ready'
     ORDER BY df.created_at, df.id, COALESCE(fr.page_sort, -1), fr.sort_order, fr.id`,
    [pid]
  );
  if (privateTeamStorage) {
    for (const frame of frames.rows) {
      frame.thumb_url = frame.thumb_url && privateAssetKey(frame.thumb_url)
        ? `/api/share/${encodeURIComponent(req.params.token)}/frames/${frame.id}/image`
        : null;
    }
  }
  res.json({ project: project.rows[0], frames: frames.rows });
}));

shareRouter.get('/:token/frames/:frameId/image', wrap(async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const pid = privateTeamStorage && isUuid(req.params.frameId) ? await sharedProjectId(req.params.token) : null;
  if (!pid) { res.status(404).json({ error: '图片不存在' }); return; }
  const { rows } = await pool.query<{ file_id: string; thumb_url: string | null }>(
    `SELECT fr.file_id, fr.thumb_url FROM frames fr
     JOIN design_files df ON df.id = fr.file_id
     WHERE fr.id = $1 AND df.project_id = $2 AND df.status = 'ready'`,
    [req.params.frameId, pid]
  );
  const frame = rows[0];
  const key = frame?.thumb_url ? privateAssetKey(frame.thumb_url) : null;
  if (!key?.startsWith(`files/${frame?.file_id}/frames/`)) {
    res.status(404).json({ error: '图片不存在' });
    return;
  }
  await sendPrivateAsset(key, res);
}));
