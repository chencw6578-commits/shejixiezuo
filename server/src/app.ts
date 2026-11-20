/**
 * Express 应用本体（与进程启动方式解耦）。
 *
 * - 本地 / Docker 常驻：index.ts 引入本模块后调用 app.listen()
 * - Vercel Serverless：api/[...path].mjs 引入本模块，把 (req,res) 交给 app 处理
 *
 * 这里绝不调用 app.listen()，也不因数据库初始化失败而 process.exit()，
 * 保证同一份业务路由在两种运行模型下完全一致。
 */
import express from 'express';
import compression from 'compression';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config, isFigmaConfigured, privateTeamStorage } from './config.js';
import { initDb } from './db.js';
import { filesRouter } from './routes/files.js';
import { assetsRouter } from './routes/assets.js';
import { webhooksRouter } from './routes/webhooks.js';
import { commentsRouter } from './routes/comments.js';
import { uploadsRouter } from './routes/uploads.js';
import { projectsRouter } from './routes/projects.js';
import { teamsRouter } from './routes/teams.js';
import { importJsonRouter } from './routes/importJson.js';
import { pluginRouter } from './routes/plugin.js';
import { mcpRouter } from './routes/mcp.js';
import { oauthRouter } from './routes/oauth.js';
import { authRouter } from './routes/auth.js';
import { invitesRouter } from './routes/invites.js';
import { shareRouter } from './routes/share.js';
import { privateStorageRouter } from './routes/privateStorage.js';
import { getStorage } from './storage/index.js';
import { queueDepth, setConcurrency } from './queue.js';

setConcurrency(Number(process.env.IMPORT_CONCURRENCY ?? 2));

export const app = express();
app.use(compression({ threshold: 512 }));
// 插件 JSON 单条可能较大：该路由自带 20mb 解析器，必须挂在全局 1mb 之前
app.use('/api/import', importJsonRouter);
// 插件导入含位图：自带 40mb 解析器，同样必须在全局解析器之前
app.use('/api/plugin', pluginRouter);
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, queue: queueDepth() });
});

// sharp 可用性自检：探测原生二进制是否加载成功 + 真实编码一次。
// 用于确认缩略图无损 WebP 转码在线上生效（失败时 imageEncode 会静默回退 PNG，这里给出显式信号）。
app.get('/api/health/sharp', async (_req, res) => {
  try {
    const { encodeThumbnail, getWebpFallbackStats } = await import('./util/imageEncode.js');
    // 1x1 红色 PNG，编码成功且体积可比对即认为可用
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const encoded = await encodeThumbnail(png);
    const { webpFallbackCount, lastFallbackError } = getWebpFallbackStats();
    res.json({
      ok: true,
      ext: encoded.ext,
      bytes: encoded.data.length,
      webpEnabled: config.thumbWebp,
      // 进程启动以来异常回退 PNG 的次数（>0 说明出现过转码故障，具体错误见 lastFallbackError）
      webpFallbackCount,
      lastFallbackError,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      webpEnabled: config.thumbWebp,
    });
  }
});

// Figma 导入能力探测：只告诉前端服务端有没有统一令牌，绝不返回令牌内容
app.get('/api/import/figma/status', (_req, res) => {
  res.json({ configured: isFigmaConfigured() });
});

app.use('/api/files', filesRouter);
app.use('/api/auth', authRouter);
app.use('/api/invites', invitesRouter);
app.use('/api/share', shareRouter);
if (privateTeamStorage) app.use('/api/storage', privateStorageRouter);
app.use('/api/assets', assetsRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/comments', commentsRouter);
app.use('/api/upload', uploadsRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/teams', teamsRouter);

// MCP 服务（AI 编码工具接入设计稿）。
// 常驻部署用 /mcp；Vercel 上静态站没有后端路径，由 vercel.json 把 /mcp 重写到
// /api/mcp，因此这里同时注册一个 /api 前缀的入口，两个端点指向同一个 router。
app.use(mcpRouter);
app.use('/api', mcpRouter);

// MCP OAuth 2.1 授权服务。本地常驻直接暴露标准外部路径；Vercel 上由 vercel.json
// 把 /.well-known/*、/authorize、/token、/register、/revoke rewrite 到 /api/oauth/*，
// 两条挂载指向同一个 router，保证两种运行模型下端点完全一致。
// 必须挂在下方 SPA fallback 之前，否则 /.well-known/* 会拿到 index.html。
app.use(oauthRouter);
app.use('/api/oauth', oauthRouter);

// 本地存储静态服务（S3/R2 模式下不需要）。Serverless 文件系统只读，跳过。
if (config.storage.driver === 'local' && !process.env.VERCEL) {
  const dir = path.resolve(config.storage.localDir);
  // 历史 DB 的 URL 含 Figma node id 冒号（frames/301:680@2x.png），这些文件
  // 已按「冒号→下划线」落盘。请求路径在此做等价映射，避免 Windows 把它当成
  // NTFS 备用数据流而 404。只改 pathname，不影响查询串。
  app.use('/storage', (req, _res, next) => {
    const q = req.url.indexOf('?');
    const raw = q >= 0 ? req.url.slice(0, q) : req.url;
    const tail = q >= 0 ? req.url.slice(q) : '';
    req.url = raw.replace(/%3a/gi, '_').replace(/:/g, '_') + tail;
    next();
  });
  app.use('/storage', express.static(dir, { maxAge: '7d', fallthrough: false }));
  void getStorage(); // 预热并确保目录存在
}

// 托管前端产物（仅常驻单端口部署；Vercel 上前端由 Vercel CDN 静态托管）
const webDist = path.resolve(process.cwd(), '../web/dist');
if (!process.env.VERCEL && existsSync(webDist)) {
  app.use(
    express.static(webDist, {
      index: 'index.html',
      setHeaders: (res, filePath) => {
        // index.html 必须每次回源校验，避免用户普通刷新仍拿到旧 bundle；
        // 静态资源文件名带内容 hash，可长期缓存
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        else res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    })
  );
  app.get(/^\/(?!api|storage).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(webDist, 'index.html'));
  });
  console.log(`[server] serving web from ${webDist}`);
}

app.use((_req, res) => res.status(404).json({ error: 'not found' }));

/**
 * 幂等建表（db.ts 内部已缓存 promise，每个 serverless 实例只跑一次 DDL）。
 * 常驻部署在 listen 前调用；Serverless 在每次请求入口 await 一次。
 */
export function ensureDb(): Promise<void> {
  return initDb();
}
