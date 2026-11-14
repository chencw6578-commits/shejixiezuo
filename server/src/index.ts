/** 本地 / Docker 常驻进程入口。Vercel Serverless 不走这里（见 api/[...path].mjs）。 */
import { app, ensureDb } from './app.js';
import { config } from './config.js';

// 兜底：Express 4 不捕获 async 路由的 rejection（如 PG 偶发 out of memory），
// 记录日志、保住进程；该次请求失败，客户端重试即可恢复
process.on('unhandledRejection', (err) => {
  console.error('[server] unhandled rejection (request failed, process kept alive):', err);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception (process kept alive):', err);
});

const port = config.port;
ensureDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`[server] listening on http://localhost:${port} (storage: ${config.storage.driver})`);
    });
  })
  .catch((err) => {
    console.error('[server] failed to init database:', err);
    process.exit(1);
  });
