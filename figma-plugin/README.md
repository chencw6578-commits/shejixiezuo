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

## 使用

1. 在 Figma 中选中一个画板（`FRAME` / `COMPONENT` / `INSTANCE`），或不选中任何节点。
2. 运行插件，插件会自动导出：
   - 有选中：导出选中节点；
   - 无选中：导出当前页所有顶层画板。
3. 面板显示「已导出 N 个画板、M 个节点」，可以：
   - **复制 JSON**，粘贴到网站的「通过 Figma 插件导入」；
   - **下载 JSON**，在网站导入面板选择 `.json` 文件上传；
   - 可选：填写网站后端地址（默认 `http://localhost:4000`），点「发送」直接 POST 到 `/api/import/figma-json`。发送失败时请退回复制/下载。

## JSON 结构（schemaVersion = 1）

```jsonc
{
  "schemaVersion": 1,
  "generator": "shejixiezuo-figma-plugin",
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

## 兼容性 / 验证状态

- `manifest.json` 使用 `"api": "1.0.0"`，字段依据 Figma 官方 Plugin API / manifest 文档
  （Plugin API 1.0.0，`editorType`、`menu`、`networkAccess` 为当前文档字段）。
- **本插件未在真实 Figma 客户端中实际运行验证**（本机没有 Figma 环境）。已完成静态检查：
  manifest JSON 合法、`code.js` 语法检查通过、UI 与主线程消息协议自洽、样例 JSON 可被网站导入。
  请在 Figma 桌面端导入一次，确认面板能显示画板/节点数后再正式使用。
