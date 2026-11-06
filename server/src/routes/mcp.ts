/**
 * MCP HTTP 传输（Streamable HTTP 简化实现：JSON 响应模式）。
 *
 * AI 工具接入：
 *   url: <服务地址>/mcp
 *   header: Authorization: Bearer <MCP_TOKEN>（设置了 MCP_TOKEN 环境变量时必填）
 */
import { Router, type Request, type Response } from 'express';
import { handleRpcMessage, SERVER_INFO } from '../mcp/handler.js';

export const mcpRouter = Router();

function authorized(req: Request): boolean {
  const token = process.env.MCP_TOKEN;
  if (!token) return true; // 未配置令牌 = 内网/沙箱放开
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${token}` || req.query.token === token;
}

mcpRouter.get('/mcp', (_req, res) => {
  res.json({
    server: SERVER_INFO.name,
    version: SERVER_INFO.version,
    transport: 'streamable-http (JSON response mode)',
    usage: 'POST JSON-RPC 2.0 messages here; methods: initialize, tools/list, tools/call',
    auth: process.env.MCP_TOKEN ? 'Authorization: Bearer <MCP_TOKEN>' : 'none',
  });
});

mcpRouter.post('/mcp', async (req: Request, res: Response) => {
  if (!authorized(req)) {
    res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } });
    return;
  }
  const body = req.body as { jsonrpc?: string; method?: string } | Array<Record<string, unknown>> | undefined;
  if (!body) {
    res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const msg of messages) {
    const r = await handleRpcMessage(msg as Parameters<typeof handleRpcMessage>[0]);
    if (r) responses.push(r);
  }
  if (responses.length === 0) {
    res.status(202).json({ jsonrpc: '2.0', id: null, result: {} }); // 通知
    return;
  }
  res.json(Array.isArray(body) ? responses : responses[0]);
});
