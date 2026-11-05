import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { initDb } from './db.js';
import { filesRouter } from './routes/files.js';
import { assetsRouter } from './routes/assets.js';
import { webhooksRouter } from './routes/webhooks.js';
import { getStorage } from './storage/index.js';
import { queueDepth, setConcurrency } from './queue.js';

setConcurrency(Number(process.env.IMPORT_CONCURRENCY ?? 2));

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, queue: queueDepth() });
});

app.use('/api/files', filesRouter);
app.use('/api/assets', assetsRouter);
app.use('/api/webhooks', webhooksRouter);

// 本地存储静态服务（S3/MinIO 模式下不需要）
if (config.storage.driver === 'local') {
  const dir = path.resolve(config.storage.localDir);
  app.use('/storage', express.static(dir, { maxAge: '7d', fallthrough: false }));
  void getStorage(); // 预热并确保目录存在
}

// 托管前端产物（web/dist 存在时单端口运行；compose 部署走 nginx 亦可并存）
const webDist = path.resolve(process.cwd(), '../web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist, { index: 'index.html' }));
  app.get(/^\/(?!api|storage).*/, (_req, res) => {
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
