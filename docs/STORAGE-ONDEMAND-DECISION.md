# 缩略图按需渲染可行性决策记录

日期：2026-11-17

## 结论

「导入时不生成缩略图、访问时按需重建并删除冷数据」在本项目**无法安全实施**，原因是 Figma 令牌不持久化。强行实施会导致私有设计稿的主图永久丢失。因此本轮未实施删除型冷热分层。

## 关键约束（代码核实）

1. **缩略图是画布主图**：`web/src/viewer/Canvas.tsx` 的 `showImage = hasThumb`，前端 5 处（FilePage / HomePage / ProjectCanvasPage / SharePage / Canvas）强依赖 `thumb_url`。删除缩略图 = 画布退化为 CSS 近似渲染（即用户明确否决的「糊主图」）。

2. **缩略图来自 Figma Images API**：`server/src/jobs/importFile.ts` 的 `generateThumbnails()` 调用 `getImages(figma_key, ...)`，需要有效 Figma 令牌。

3. **用户个人令牌从不持久化**：`server/src/routes/files.ts` 的 `/api/files` 把 `token` 仅在导入当时传给 `enqueueImport`，全库无任何令牌存储（`grep INSERT/UPDATE design_files ... token` 为空）。团队 `import_tokens` 表是 MCP/插件鉴权用的，不是 Figma 令牌。

4. **私有稿无法用服务端令牌重建**：用个人令牌导入的私有 Figma 文件，服务端 `FIGMA_TOKEN` 无访问权限，重建会 403。

由 3+4 推出：删除冷稿缩略图后，这部分稿再也无法恢复主图 —— 不可接受。

## 已经落地的安全优化（本轮 + 上一轮）

| 优化 | 状态 | 单份收益 |
|---|---|---|
| 跳过从不显示的节点渲染图（render_url） | 已落地 | 省约 50 张图/份 |
| raw 存档字段停用写入 | 已落地 | 省约 12KB/份 DB |
| 无损 WebP 转码 | 本轮落地 | 省约 60% 图片体积（实测，像素零差异） |

以上均为「不删除可重建资产、不改前端」的安全优化，压缩后单份图体积约为原来的 1/3 以下。

## 若要实现真正的按需渲染，需要先解决令牌问题（三选一）

| 方案 | 做法 | 代价 / 风险 |
|---|---|---|
| A. 持久化加密 Figma 令牌 | 用户令牌用服务端密钥 AES 加密入库，按需时解密重建 | 需密钥管理；令牌泄露风险上升；用户需重新授权历史稿 |
| B. 仅对公共/服务端令牌稿做冷热分层 | 给每稿标记导入令牌来源，只删可重建的稿 | 私有稿不省空间，收益打折；需加字段+迁移 |
| C. 前端访问时透传令牌 | 打开画板时前端带上用户令牌触发重建 | 分享页/无令牌访客无法重建；改动前端 5 处 |

未获批准前不实施以上任一方案。

## 附带产物

- `server/src/util/imageEncode.ts`：无损 WebP 编码 + PNG 回退
- `server/src/config.ts`：`THUMB_WEBP` 开关
- `server/package.json`：新增 sharp 依赖
- `server/scripts/optimize-existing-storage.mts`：存量旧稿优化脚本（清 raw / 删节点渲染 / PNG→无损 WebP）

## 存量数据优化（2026-11-17 追加）

新优化只对新导入生效，存量旧稿需跑一次：

```
npx tsx scripts/optimize-existing-storage.mts --dry-run   # 先只统计
npx tsx scripts/optimize-existing-storage.mts             # 实际执行
```

三步：① 清空 design_files.raw；② 删除 Blob `files/{id}/nodes/` 节点渲染图并置空 render_url（`--keep-renders` 可跳过）；③ 缩略图 PNG → 无损 WebP（仅当更小才落盘，回写 thumb_url 后删旧 PNG）。不触碰 `assets/` 切图资产；先写新对象→改库→删旧对象，失败不会产生悬空引用；幂等可重跑。

## 数据库列压缩建议（零代码，需在 Neon 手工执行）

nodes.props 为大 JSONB，Postgres TOAST 已默认 pglz 压缩；PG14+ 可换更快的 lz4（压缩率相近、CPU 开销低）：

```sql
ALTER TABLE nodes  ALTER COLUMN props SET COMPRESSION lz4;
ALTER TABLE frames ALTER COLUMN props SET COMPRESSION lz4;
-- 仅影响之后新写入的行；如需回写存量行触发重压缩：
-- VACUUM FULL nodes;  -- 锁表，选低峰期执行，可选
```
