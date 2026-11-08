# Figma 导出向导（设计协作）

把 Figma 里选中的画板直接导出到你的「设计协作」网站：选画板 → 选平台与倍率 → 选项目/编组 → 一步上传。
不需要手工粘贴 JSON。

## 三步上手

### 第 1 步：在网站生成「导入令牌」

1. 打开网站，进入 **团队 → 团队设置**。
2. 点 **生成导入令牌**，得到一串 `imp_` 开头的令牌。
3. 点 **复制**。令牌明文只显示这一次（服务端只保存哈希），丢了就重新生成。
4. 不用了随时点 **撤销**，插件再用会立即返回 401。

### 第 2 步：安装插件

1. 打开 Figma 桌面端，菜单 **Plugins → Development → Import plugin from manifest…**。
2. 选择本仓库的 `figma-plugin/manifest.json`。
3. 之后在 **Plugins → Development → 设计协作 · 导出向导** 打开插件窗口。

### 第 3 步：选画板并导出

1. **选画板**：插件列出当前页面的顶层画板，勾选要导出的（默认勾选你在 Figma 中选中的画板）。
2. **导出设置**：
   - 平台：Android（单位 dp，默认 2x）/ iOS（单位 pt，默认 2x）/ Web（单位 px，默认 1x）；
   - 倍率：1x / 2x / 3x，决定 PNG 切图清晰度；
   - 是否同时导出位图切图（默认开，单张超过 5MB 会自动跳过图片并提示）。
3. **目标与上传**：
   - 服务器地址：本地开发默认 `http://localhost:4000`，部署后填你的网站地址；
   - 导入令牌：粘贴第 1 步复制的 `imp_` 令牌（会保存在 Figma 本机插件存储，下次自动带出）；
   - 目标项目：下拉选择；
   - 编组：选「未分组」、已有编组，或 **+ 新建编组** 并填名称。
4. 点 **导出并上传**。窗口会显示进度（读取节点 → 导出图片 → 上传），完成后显示
   「已导入 N 个画板 / M 个节点」，并提供 **在网站中打开** 链接。

> 逐画板上传：位图体积大，插件会一个画板一次请求，避免单次请求过大失败。
> 重复导入同一个 Figma 画板会**原位更新**，不会产生重复画板。

## 仅导出 JSON（离线备份）

第一步底部的 **仅导出 JSON（不上传）** 会导出所选画板的 JSON，可复制或下载。
网站项目页的导入面板也支持粘贴这份 JSON（`POST /api/import/figma-json`）。

## 常见问题

### 点了插件没反应

1. 确认 Figma 桌面端（浏览器版对开发插件支持有限）。
2. **Plugins → Development** 里应直接看到「设计协作 · 导出向导」条目；如果它变成了子菜单，
   说明 `manifest.json` 里误加了 `menu` 字段（本仓库没有）。
3. `manifest.json` 必须包含 `"documentAccess": "dynamic-page"`；缺了会在运行前加载整份文件，大文件看起来像没反应。
4. 修改插件文件后必须重新 **Import plugin from manifest…** 或重启 Figma，开发插件没有自动热更新。

### 上传失败 / 401

- **401**：令牌填错或已在网站撤销 → 回团队设置重新生成并粘贴。
- **无法连接服务器**：确认网站已启动、地址与端口正确（默认 `http://localhost:4000`）；
  若部署在别的域名，改插件里第 3 步的服务器地址，并同步修改 `manifest.json` 的 `networkAccess`。
- **位图超过 5MB**：降低倍率（3x → 2x）或关闭「同时导出位图切图」后重试。画板与节点仍会正常导入。

### 编组里看不到刚导出的画板

插件的编组属于项目里的「Figma 插件导入」设计稿；请在插件第 3 步点 **刷新项目**，
再到网站项目页查看。网页端手工建在其它设计稿下的编组不会出现在插件的编组下拉里。

## 数据与安全

- 令牌只在服务端存 sha256 哈希；明文仅在生成时返回一次，不写入日志、不写进前端构建产物。
- 插件把令牌存在 `figma.clientStorage`（本机 Figma 插件存储），不会发给第三方。
- 位图切图按 `scale` 存为 PNG 资源，画板缩略图同步更新。

## 开发者备注

- `code.js`：主线程，读画板、导出 JSON（schemaVersion 1）、`figma.exportAsync` 导出 PNG（base64）、`figma.clientStorage` 偏好。
- `ui.html`：三步向导与所有网络请求（`fetch` + `Authorization: Bearer imp_…`）。
- 网站接口：`GET /api/plugin/me`、`GET /api/plugin/projects`、`GET|POST /api/plugin/projects/:id/groups`、`POST /api/plugin/import`。
- 已用 Node `vm` 模拟 `figma` 对象验证主线程逻辑与请求体结构；**尚未在真实 Figma 客户端实测**（环境无 Figma 桌面端）。
- 文档依据：Figma Plugin API（`figma.showUI` / `figma.ui.postMessage` / `figma.exportAsync` / `figma.clientStorage` / `manifest.documentAccess`），核对日期 2026-11-08。
