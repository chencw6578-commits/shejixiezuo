import express from 'express';
import compression from 'compression';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config, isFigmaConfigured } from './config.js';
import { initDb } from './db.js';
import { filesRouter } from './routes/files.js';
import { assetsRouter } from './routes/assets.js';
import { webhooksRouter } from './routes/webhooks.js';
import { commentsRouter } from './routes/comments.js';
import { uploadsRouter } from './routes/uploads.js';
import { projectsRouter } from './routes/projects.js';
import { teamsRouter } from './routes/teams.js';
import { mcpRouter } from './routes/mcp.js';
import { getStorage } from './storage/index.js';
import { queueDepth, setConcurrency } from './queue.js';

setConcurrency(Number(process.env.IMPORT_CONCURRENCY ?? 2));

const app = express();
app.use(compression({ threshold: 512 }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, queue: queueDepth() });
});

// Figma 导入能力探测：只告诉前端服务端有没有统一令牌，绝不返回令牌内容
app.get('/api/import/figma/status', (_req, res) => {
  res.json({ configured: isFigmaConfigured() });
});

app.use('/api/files', filesRouter);
app.use('/api/assets', assetsRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/comments', commentsRouter);
app.use('/api/upload', uploadsRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/teams', teamsRouter);
// MCP 服务（AI 编码工具接入设计稿）
app.use(mcpRouter);

// 本地存储静态服务（S3/MinIO 模式下不需要）
if (config.storage.driver === 'local') {
  const dir = path.resolve(config.storage.localDir);
  app.use('/storage', express.static(dir, { maxAge: '7d', fallthrough: false }));
  void getStorage(); // 预热并确保目录存在
}

// 托管前端产物（web/dist 存在时单端口运行；compose 部署走 nginx 亦可并存）
const webDist = path.resolve(process.cwd(), '../web/dist');
if (existsSync(webDist)) {
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

const port = config.port;
initDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`[server] listening on http://localhost:${port} (storage: ${config.storage.driver})`);
    });
  })
  .catch((err) => {
    console.error('[server] failed to init database:', err);
    process.exit(1);
  });
