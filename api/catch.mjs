/**
 * Vercel Serverless 单函数入口：把 /api/* 请求原样交给 Express app。
 *
 * vercel.json 用 rewrites 把所有 /api/(.*) 捕获到本函数（Vercel 的 [...path]
 * 动态路由只匹配单段，多段路径会被平台层挡成 404）。捕获的子路径放在 __vp
 * query 里；下面会把它还原成原始 req.url，Express 路由才能正确匹配。
 *
 * 静态前端由 Vercel CDN 从 web/dist 提供，不经过此函数。
 */
import { waitUntil } from '@vercel/functions';
import { app, ensureDb } from '../server/dist/app.js';

// server 侧 queue.ts 会在请求处理中读取这个钩子，把异步导入 / 发信任务
// 注册给 Vercel（响应发出后仍继续执行，不受实例冻结影响）。
globalThis.__waitUntil = waitUntil;

/**
 * Vercel 默认在 req/res 上注入 body/query/status/json 等「helpers」（own property
 * getter）。它们会遮蔽 Express 自己的 body-parser 结果和路由参数解析，导致
 * POST JSON 取不到 req.body、multer 上传流被提前消费。这里移除后由 Express 接管。
 */
function stripVercelHelpers(req, res) {
  for (const [obj, keys] of [
    [req, ['body', 'query', 'cookies']],
    [res, ['status', 'send', 'json', 'redirect']],
  ]) {
    for (const key of keys) {
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (desc && desc.configurable) delete obj[key];
    }
  }
}

/**
 * 还原 rewrite 前的真实 API 路径。
 *
 * Vercel 对 rewrite 到函数时 req.url 的处理有两种可能（原始 URL / destination
 * URL，或两者 query 合并），这里对三种情况都成立：
 *  - 有 __vp：用它重建 /api/<子路径>，并保留其它原始 query 参数
 *  - 无 __vp：说明 req.url 本来就是原始路径，直接返回
 */
function restoreOriginalUrl(req) {
  const q = req.url?.indexOf('?') ?? -1;
  if (q < 0) return;
  const params = new URLSearchParams(req.url.slice(q + 1));
  const vp = params.get('__vp');
  if (!vp) return;
  params.delete('__vp');
  const rest = params.toString();
  req.url = `/api/${vp}${rest ? `?${rest}` : ''}`;
}

export default async function handler(req, res) {
  restoreOriginalUrl(req);
  stripVercelHelpers(req, res);
  try {
    await ensureDb();
  } catch (err) {
    console.error('[vercel] database init failed:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify({ error: '数据库初始化失败' }));
    return;
  }

  // Express app 是 (req,res) 函数且立即返回；必须等 res 真正结束再 resolve，
  // 否则 Fluid compute 会在异步路由（数据库查询 / 导入）完成前冻结实例。
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    res.on('finish', done);
    res.on('close', done);
    try {
      app(req, res);
    } catch (err) {
      console.error('[vercel] express dispatch failed:', err);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: '服务器内部错误' }));
      }
      done();
    }
  });
}
