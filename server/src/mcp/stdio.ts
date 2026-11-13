/**
 * MCP stdio 传输：供 Claude Desktop / Cursor 等本地 AI 工具以子进程方式连接。
 *
 * 启动（仓库根目录下）：
 *   npm --prefix server run mcp:stdio
 * 或在 server/ 目录直接：npm run mcp:stdio
 *
 * 配置示例（claude_desktop_config.json / .cursor/mcp.json）：
 * {
 *   "mcpServers": {
 *     "designhub": { "command": "npx", "args": ["tsx", "server/src/mcp/stdio.ts"] }
 *   }
 * }
 * 注：stdio 模式为本地全开（不鉴权），与 HTTP 模式共用同一套工具实现。
 */
import { createInterface } from 'node:readline';
import { handleRpcMessage } from './handler.js';

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: unknown;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // 忽略非 JSON 行
  }
  void (async () => {
    const res = await handleRpcMessage(msg as Parameters<typeof handleRpcMessage>[0]);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  })();
});

process.on('SIGINT', () => process.exit(0));
