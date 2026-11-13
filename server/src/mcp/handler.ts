/**
 * MCP JSON-RPC 核心：HTTP（/mcp）与 stdio 两种传输共用。
 * 实现 initialize / tools/list / tools/call / ping，协议版本 2024-11-05。
 */
import { callTool, toolList, type McpCtx, EMPTY_CTX } from './tools.js';

const PROTOCOL_VERSION = '2024-11-05';

export const SERVER_INFO = {
  name: 'designhub-mcp',
  version: '1.0.0',
};

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function ok(id: RpcRequest['id'], result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function err(id: RpcRequest['id'], code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * 处理一条 JSON-RPC 消息。
 * 返回 null 表示是通知（无需响应）；否则返回响应对象。
 */
export async function handleRpcMessage(
  msg: RpcRequest,
  ctx: McpCtx = EMPTY_CTX
): Promise<RpcResponse | null> {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion:
          typeof (params as { protocolVersion?: string } | undefined)?.protocolVersion === 'string'
            ? (params as { protocolVersion: string }).protocolVersion
            : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          '设计协作平台的 MCP 服务：先用 list_projects → list_files → list_frames 定位画板，' +
          '再通过 get_frame_tree 理解布局、get_node 获取图层规格与 CSS、get_design_tokens 提取设计规范、' +
          'get_image 直接查看设计图。',
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: toolList() });
    case 'tools/call': {
      const name = String((params as { name?: string } | undefined)?.name ?? '');
      const args = ((params as { arguments?: Record<string, unknown> } | undefined)?.arguments) ?? {};
      const result = await callTool(name, args, ctx);
      return ok(id, result);
    }
    case 'resources/list':
      return ok(id, { resources: [] });
    case 'prompts/list':
      return ok(id, { prompts: [] });
    default:
      return err(id, -32601, `method not found: ${method}`);
  }
}
