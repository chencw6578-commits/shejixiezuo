# 设计协作 · Figma 导出插件

从 Figma 里直接读取当前选中的画板（没有选中时读取当前页顶层画板），导出网站可导入的 JSON。
**全程不调用 Figma REST，因此不受服务端账号限流影响，也能导出私有文件。**

## 安装（本地开发插件）

1. 打开 Figma **桌面端**（浏览器版不支持从 manifest 导入本地插件）。
2. 菜单：`Plugins → Development → Import plugin from manifest…`
3. 选择本目录下的 `manifest.json`。
4. 之后在 `Plugins → Development` 里可以看到「设计协作 · 导出画板 JSON」。

> `manifest.json` 里没有写 `id`：本地开发插件由 Figma 在首次导入时自动生成并写入，无需手动填占位 id。
> 若要发布到社区，需要在 Figma 后台创建插件并回填官方分配的 `id`。
>
> 本插件是**单命令插件**，manifest **不声明 `menu`**：声明 menu 会让 `Plugins → Development` 里的条目变成子菜单，
> 点击条目本身不会有任何反应（需要再展开点子项才运行）。去掉 menu 后，点击插件名即直接运行。

## 使用

1. 在 Figma 中选中一个画板（`FRAME` / `COMPONENT` / `INSTANCE`），或不选中任何节点。
2. 运行插件，插件会自动导出：
   - 有选中：导出选中节点；
   - 无选中：导出当前页所有顶层画板。
3. 面板显示「已导出 N 个画板、M 个节点」，可以：
   - **复制 JSON**，粘贴到网站的「通过 Figma 插件导入」；
   - **下载 JSON**，在网站导入面板选择 `.json` 文件上传；
   - 可选：填写网站后端地址（默认 `http://localhost:4000`），点「发送」直接 POST 到 `/api/import/figma-json`。发送失败时请退回复制/下载。

## 启动顺序与版本确认

- 插件启动后**第一件事就是 `figma.showUI(__html__, ...)`**：固定 UI（标题、按钮、文本框）立刻显示，
  不等待任何节点数据；节点数据随后异步填入。这样即使读取很慢或失败，窗口也一定会出现。
- 窗口顶部显示版本行：`v1.0.1 · 2026-11-08 · api 1.0.0`（插件版本 / 构建日期 / manifest 的 api 版本）。
  **版本行没出现或版本偏旧，说明跑的不是最新代码**（本地插件没有热更新，见文末排查 C）。
- 主线程异常一律通过 `figma.ui.postMessage` 把可读文案显示在窗口状态栏，并同时 `figma.notify` 提示；
  UI 若 12 秒收不到主线程返回，也会给出排查提示，不会一直停在「正在读取节点…」。


## JSON 结构（schemaVersion = 1）

```jsonc
{
  "schemaVersion": 1,
  "generator": "shejixiezuo-figma-plugin",
  "pluginVersion": "1.0.1",
  "exportedAt": "2026-11-08T03:20:00.000Z",
  "file": { "name": "文件名", "fileKey": "...", "pageName": "Page 1" },
  "artboards": [
    {
      "id": "10:1",
      "parentId": null,
      "name": "登录页",
      "type": "FRAME",
      "x": 0, "y": 0,              // 相对父级
      "boardX": 0, "boardY": 0,    // 相对画板左上角
      "absoluteBoundingBox": { "x": 0, "y": 0, "width": 375, "height": 812 },
      "rotation": 0,
      "opacity": 1,
      "visible": true,
      "cornerRadius": 12,          // 或 rectangleCornerRadii: [tl, tr, br, bl]
      "fills": [ ... ],            // SOLID / GRADIENT_* / IMAGE
      "strokes": [ ... ],
      "strokeWeight": 1,
      "strokeAlign": "INSIDE",
      "effects": [ ... ],          // DROP_SHADOW / INNER_SHADOW / LAYER_BLUR ...
      "hasImageFill": true,
      "imageFillNodeId": "10:6",   // 图片填充只记录 node id + imageHash，不内嵌 base64
      "characters": "欢迎回来",     // 仅 TEXT 节点
      "style": {
        "fontFamily": "PingFang SC",
        "fontPostScriptName": "Semibold",
        "fontWeight": 600,
        "fontSize": 28,
        "lineHeightPx": 36,
        "letterSpacing": 0,
        "textAlignHorizontal": "LEFT",
        "textAlignVertical": "TOP",
        "textCase": "ORIGINAL",
        "textDecoration": "NONE"
      },
      "children": [ /* 同结构递归 */ ]
    }
  ]
}
```

- 填充/描边的 `color` 为 `{ r, g, b, a }`（0..1）。
- 渐变带 `gradientStops` 与 `gradientHandlePositions`（`[{x, y}, ...]`）。
- 图片填充带 `scaleMode` 与 `imageHash`，不含图片二进制。
- `figma-plugin/sample-export.json` 是一份符合上述结构的样例，可用于网站侧联调。

## 实现约束（Figma 插件沙箱）

- 主线程（`code.js`）**没有 DOM、没有 fetch**，只操作 Figma 场景树；UI 与主线程通信一律走
  `figma.ui.postMessage` / `figma.ui.onmessage`。
- 网络请求只在 UI iframe（`ui.html`）里用 `fetch`，域名白名单写在 `manifest.json` 的
  `networkAccess.allowedDomains` / `devAllowedDomains`。
- `figma.mixed`（混排文本的 fontSize 等）不是数字，导出时会按缺省值处理。

## 兼容性 / 文档依据

- `"api": "1.0.0"`、`"main": "code.js"`、`"ui": "ui.html"`（文件名与仓库中实际文件大小写一致，均在本目录根下）。
- 新增 `"documentAccess": "dynamic-page"`：依据 Figma Developer Docs — **Plugin Manifest**（查阅日期 2026-11-08），
  新插件必须声明该字段；同时 **Migrating Plugins to Load Dynamically** 说明：未声明时运行插件会先加载整份文件
  （大文件要等几十秒），这正是「点了没反应」的一个常见原因。
- 因为 dynamic-page 下页面内容默认未加载，读取节点前必须显式加载：代码里 `await figma.currentPage.loadAsync()`，
  不可用时回退 `await figma.loadAllPagesAsync()`；否则会抛
  `Cannot access children on a page that has not been explicitly loaded`（同一文档的 API Errors 页）。
- `figma.showUI` 的 `width` / `height` / `title` 选项依据 Figma Developer Docs — **showUI**（查阅日期 2026-11-08）。
- **本插件未在真实 Figma 客户端中实际运行验证**（本机没有 Figma 环境）。已完成静态检查：
  `manifest.json` / `sample-export.json`  JSON 合法、`node --check code.js` 通过、UI 与主线程消息协议自洽、
  样例 JSON 可被网站后端解析并落库。请在 Figma 桌面端导入后按下面的排查章节验证一次。

## 排查：点了没反应 / 条目消失 / 改了代码没生效

### A. 点击插件没有任何反应（无窗口）

按可能性排序，本次修复对应的判断依据：

1. **manifest 声明了 `menu`（旧版本 manifest）**：单命令插件声明 `menu` 后，`Plugins → Development` 里的插件名
   是**子菜单**，点击条目本身不会运行，要再展开点子项。判断依据：Figma Manifest 文档对 `menu` 的说明是
   「声明插件的子菜单，用于包含多个命令」。**修复：移除 `menu`**，点击插件名即直接运行。
2. **旧版本缺少 `documentAccess: "dynamic-page"`**：Figma 会先把整份文件加载完再运行插件，大文件耗时几十秒，
   表现为「点了完全没反应」。判断依据：官方动态加载迁移文档明确写了这个前置加载行为。**修复：声明 dynamic-page
   并显式加载当前页**。
3. **没有打开设计文件**：插件只在 Figma Design 文件内可用；停在文件列表/首页时点击不会弹窗。
4. **启动异常被吞**：当前版本启动即弹窗，异常会显示在窗口状态栏 + `figma.notify`；若看到红色文案，按文案处理。
5. **`main` / `ui` 路径不符**：两个文件必须与 `manifest.json` 同目录、文件名大小写一致（`code.js`、`ui.html`）。

### B. 关掉面板后再进来，Development 里看不到条目

1. **筛选回到默认 `All`**：把插件菜单的筛选切回 `Development` 再看（这是最常见原因）。
2. **manifest 路径被移动 / 改名 / 删除**：本地开发插件按 manifest 路径注册，路径失效后条目会消失；
   重新 `Import plugin from manifest…` 即可恢复。
3. 浏览器版 Figma 不支持本地开发插件，必须在**桌面端**。

### C. 改了代码但运行结果没变（插件没有热更新）

- Figma 本地插件**没有热更新**：修改 `code.js` / `ui.html` / `manifest.json` 后，必须
  **重新 `Import plugin from manifest…`（同一路径覆盖导入）或重启 Figma 桌面端**，再运行插件。
- 是否跑的最新代码：看窗口顶部版本行 `v1.0.1 · 2026-11-08`；版本未变即仍是旧代码。
