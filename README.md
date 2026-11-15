# 设计协作 · Design Handoff

内部设计交付工具（对标蓝湖 / Zeplin）：导入 Figma 设计稿，在浏览器中查看设计稿的**尺寸、坐标、颜色、字体规范**，并**下载切图**。

## 功能

- **三种导入方式**：Figma 链接导入；上传 .sketch（服务端解析，SVG 近似渲染预览）；上传 .psd（合成图预览 + 图层树）
- **画布查看器**：画板渲染图 + 透明热区层，点选图层、悬停查看尺寸、与选中图层自动测量间距
- **设计规范**：位置尺寸 / 圆角 / 透明度 / 填充色（点击复制 HEX）/ 描边 / 阴影 / 字体字号行高；文件级颜色 / 字体汇总页
- **代码片段**：选中图层一键生成 CSS / React / Swift / Android 代码
- **评论协作**：画布钉点评论（可锚定图层）、回复、标记解决，6 秒轮询同步
- **切图下载**：读取设计稿标记的导出预设，或自定义 PNG / SVG / JPG / PDF 与倍率；支持按画板批量打包 zip
- **批量切图**：画板内全部图层（或按设计标记的预设）打包 zip 下载
- **规范汇总页**：全文件色板 / 渐变 / 字体统计，按使用次数排序
- **版本同步**：文件页「重新同步」按钮；或配置 Figma Webhook（FILE_UPDATE）自动重导
- **账号与协作**：邮箱注册登录、团队三级角色（owner / admin / collaborator）、邀请链接、导入令牌、公开只读分享

## 使用流程

创建团队（可选）→ 创建项目（可归属团队）→ 在项目内导入 Figma 链接 / 上传 Sketch / PSD → 打开画板查看规范、评论、导出切图。

## 快速开始（开发）

```bash
# 1. 数据库（任选其一）
docker run -d --name pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=designhub -p 5432:5432 postgres:16

# 2. 配置
cp .env.example server/.env   # 填入 FIGMA_TOKEN；生产还必须设置 AUTH_SECRET

# 3. 服务端
cd server && npm i && npm run dev    # http://localhost:4000

# 4. 前端
cd web && npm i && npm run dev       # http://localhost:5173
```

## 环境变量（生产必查）

`AUTH_SECRET` 是**生产 / Vercel 必填项**：会话 cookie 签名与公开分享链接 HMAC 共用它。缺失时服务端在启动阶段直接报错，不会回退到可猜测的默认密钥；用 `openssl rand -hex 32` 生成后写入部署环境变量。本地开发可留空（会打印警告并使用仅本地的默认值）。

代码实际读取的变量以两份 `.env.example` 为准：根目录示例面向 Vercel / 根目录部署，`server/.env.example` 面向常驻服务。除 `AUTH_SECRET` 外，重点还有 `DATABASE_URL`、`STORAGE_DRIVER`（local / s3 / blob，Vercel 用 blob）、`FIGMA_TOKEN`、`MCP_TOKEN`、`WEB_BASE_URL` 与 `EMAIL_*` / `SMTP_*`。Vercel Blob 的 `BLOB_READ_WRITE_TOKEN` 由平台连接 Store 后自动注入，无需手工填写。

## 生产部署

**Docker Compose（常驻）**

```bash
FIGMA_TOKEN=figd_xxx AUTH_SECRET=<随机串> docker compose up -d --build
# 访问 http://localhost:8080（web → nginx → server，存储走 MinIO）
```

**Vercel（Serverless）**：`vercel.json` 把 `web/dist` 作为静态产物，`api/catch.mjs` 是唯一的 Express 函数；`/api/(.*)` 与 `/mcp` 都 rewrite 到它。需在 Vercel 项目里配置 `AUTH_SECRET`、`DATABASE_URL`，并连接 Blob Store。Serverless 文件系统只读，因此不要设 `STORAGE_DRIVER=local`。

## 架构

```
web/     React + Vite        导入页 / 项目画布 / 画板列表 / 画布查看器（热区层 + 图层层树 + 属性面板）
server/  Express + TS + pg
  ├─ figma/client.ts    Figma REST（限流重试 / 导出图片下载）
  ├─ figma/parse.ts     节点树解析：坐标归一化、颜色渐变转 CSS、文本样式、导出预设
  ├─ jobs/importFile.ts 导入任务（进程内队列）：入库 + 画板缩略图
  ├─ mcp/               MCP 服务（tools.ts 工具集 + handler.ts JSON-RPC + stdio 传输）
  ├─ export/local.ts    本地切图渲染（SVG 矢量 / PNG 纯 Node 光栅化）
  ├─ storage/           本地磁盘 / S3(MinIO) / Vercel Blob 三适配器
  └─ routes/            files / assets / auth / authz / teams / invites / share / comments / mcp 等
api/     catch.mjs       Vercel Serverless 单函数入口（还原 rewrite 路径 + 剥离平台 helpers）
figma-plugin/           Figma 插件：导出节点 JSON 与切图，用团队导入令牌直传
```

数据流：Figma 文件 JSON 全量入库（`design_files.raw`）→ 解析为画板 `frames` + 图层 `nodes`（坐标归一到画板左上角）→ 画板渲染 PNG 做底图，图层 bounding box 做热区 → 切图走 Figma images API 转存对象存储。Sketch 走 JSZip 解包 + SVG 近似渲染；PSD 走 psd.js（合成图 + 图层树，尽力而为）。

## MCP：AI 编码工具接入设计稿

通过 MCP（Model Context Protocol）让 Claude Code / Cursor / Trae 等 AI 编码工具直接读取设计稿，按真实数据还原 UI 而不是猜测间距颜色。

**7 个工具**：`list_projects` → `list_files` → `list_frames` 定位画板；`get_frame_tree` 理解布局；`get_node` 获取图层完整规格（几何/填充/描边/阴影/文字 + 生成好的 CSS），支持名称模糊匹配；`get_design_tokens` 聚合高频颜色/字体/圆角；`get_image` 返回画板缩略图或单图层切图 PNG（base64，多模态模型可直接「看图」）。

**接入配置：OAuth 2.1（推荐）**

```json
{
  "mcpServers": {
    "designhub": {
      "type": "http",
      "url": "https://<你的域名>/mcp"
    }
  }
}
```

配置里不写 headers。首次连接时客户端按 MCP 2025-06-18 规范自动发现授权服务：
401 响应的 `WWW-Authenticate` → `/.well-known/oauth-protected-resource`（RFC 9728）
→ `/.well-known/oauth-authorization-server`（RFC 8414）→ `/register`（RFC 7591 动态注册）
→ `/authorize`（复用网站 `dh_session` 登录态与同意页，PKCE S256、RFC 8707 resource）
→ `/token` 换取令牌。后续每个请求仍带 `Authorization: Bearer <access-token>`，只是由客户端自动获取，不用手填。

- 签发的 `dhat_` 令牌存 `oauth_access_tokens`，**只读、绑定授权时选定的单个团队**，不写入 `import_tokens`，因此不能调用 `/api/plugin/*` 的上传接口。支持 refresh 轮换与 `/revoke`（RFC 7009）。
- 未登录时 `/authorize` 302 到 `/login?next=...`，沿用网站原有的邮箱登录 / 限流 / 注册流程。
- Vercel 上由 `vercel.json` 把 `/.well-known/*`、`/authorize`、`/token`、`/register`、`/revoke` rewrite 到 `/api/oauth/*`（复用 `api/catch.mjs` 的 `__vp` 机制）；本地常驻由 `app.use(oauthRouter)` 直接暴露同样的路径。

**静态令牌（兼容旧配置）**

```json
{
  "mcpServers": {
    "designhub": {
      "type": "http",
      "url": "https://<你的域名>/mcp",
      "headers": { "Authorization": "Bearer <团队导入令牌>" }
    }
  }
}
```

- 需要令牌就在网站头像菜单「导入令牌」生成；已发出的旧配置继续可用。
- 线上（`VERCEL` 或 `NODE_ENV=production`）**强制鉴权**：无有效 Bearer 返回 401，并带 `WWW-Authenticate` 指引 OAuth 发现。
- 导入令牌与 Figma 插件共用 `import_tokens`：撤销后两边同时失效，且该令牌也能调用 `/api/plugin/*` 上传，不要当只读密钥外泄。`MCP_TOKEN` 是部署级管理员凭据（`scope=all`），UI 不引导使用。
- 本地开发允许匿名访问；线上如确需放开，必须显式设 `MCP_ALLOW_ANONYMOUS=1`（不建议）。`/mcp` 与 `/api/mcp` 指向同一个 router，Vercel 上由 rewrite 保证两条路径都可达。

**stdio 传输（本地子进程）**

```
{
  "mcpServers": {
    "designhub": {
      "command": "npx",
      "args": ["tsx", "server/src/mcp/stdio.ts"],
      "cwd": "<仓库根目录>"
    }
  }
}
```

**典型 AI 对话**：「用 designhub 的 list_projects 拿到项目 → list_frames 找到『首页（浅色）』画板 → get_frame_tree 看布局 → get_node 取『登录按钮』的 CSS → get_image 看一眼设计图」→ 直接生成还原代码。

## 分期（按代码实际状态，2026-11-15 核对）

- **P1**：导入 + 查看 + 标注 + 单图层切图 ✅
- **P2**：批量切图 zip、设计规范汇总页、手动同步 + Figma Webhook 版本同步 ✅
- **P3**：评论协作、代码片段生成（CSS/React/Swift/Android）、Sketch 导入、PSD 导入（尽力而为）✅
- **P3.5**：团队 / 项目两级结构、编组、画布连线、原型导出、账号登录与邮箱验证 ✅
- **P4 已完成**：团队权限（owner/admin/collaborator + 邀请 + 只读分享）、MCP 接入、Figma 插件、Vercel Serverless 全栈部署、MCP 线上强制鉴权 ✅
- **待做**：Design Tokens 导出（目前只有 `get_design_tokens` 聚合，无导出文件）；代码片段扩展（Flutter / 小程序）；实时评论（现为 6 秒轮询；Vercel Serverless 单函数不持长连接，直接上 WebSocket 需另起常驻服务，建议评估 SSE 或第三方实时服务）
