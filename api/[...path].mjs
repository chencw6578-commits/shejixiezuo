/**
 * Vercel Serverless 单函数入口：把 /api/* 请求原样交给 Express app。
 *
 * 文件名 [...path] 是 Vercel 的 catch-all 动态路由，所有 /api/... 路径都会命中
 * 这一个函数（Vercel 不会为 api/ 下每个文件单独建函数）。业务路由全部复用
 * server/dist/app.js，与本地 / Docker 常驻部署是同一份代码。
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

export default async function handler(req, res) {
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
