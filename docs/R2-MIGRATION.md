# Vercel Blob → Cloudflare R2 迁移方案

## 背景与目标

当前图片存 Vercel Blob（Hobby 免费 1GB + 2000 次高级操作/月），5000 份设计稿约需 100–200GB，免费额度远远不够，且超额后 Blob 会停服 30 天。

迁移到 Cloudflare R2：免费 10GB + 100 万次写/月 + 出站流量永久免费。按 100–200GB 估算，超出部分约 $1.4–2.9/月，且不会停服。

## 代码层面：无需改动业务逻辑

服务端已内置 S3 适配器（`server/src/storage/index.ts`），且已针对 R2 做过兼容：
- `S3_PUBLIC_INCLUDE_BUCKET=false` 时，公开 URL 拼成 `base/key`（R2 公开域已指向桶）。
- `presign.ts` 直传、`deleteFileBlobs` 清理均走同一适配器。

因此切换存储**只是改环境变量**，不改代码。

## 步骤

### 1. 准备 R2（需你在 Cloudflare 控制台操作）
1. R2 → 创建桶，例如 `designhub`。
2. 开启公开访问：用 `r2.dev` 临时域名，或绑定自定义域（推荐，如 `cdn.example.com`）。
3. R2 → Manage R2 API Tokens → Create API token，权限 `Object Read & Write`，拿到 Access Key ID / Secret Access Key。
4. 记下 Account ID（URL 里那串十六进制）。

### 2. 配置 Vercel 环境变量（Production + Preview）
把 `.env.example` 里「Cloudflare R2 迁移示例」那一段的值填入：

| 变量 | 值示例 |
|---|---|
| `STORAGE_DRIVER` | `s3` |
| `S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `S3_BUCKET` | `designhub` |
| `S3_REGION` | `auto` |
| `S3_ACCESS_KEY` | `<R2 Access Key ID>` |
| `S3_SECRET_KEY` | `<R2 Secret Access Key>` |
| `S3_PUBLIC_BASE_URL` | `https://<你的 R2 公开域>` |
| `S3_PUBLIC_INCLUDE_BUCKET` | `false`（R2 必须为 false） |

> 不要把 `STORAGE_DRIVER=s3` 直接推到生产就完事——切换后新稿写 R2，但历史稿的图片 URL 仍指向旧 Blob。旧 Blob 在没清理前还能读，所以不会立刻坏；但要让全部稿件统一走 R2，需执行第 3 步。

### 3. 搬运历史图片 + 回写数据库 URL
数据库里 `frames.thumb_url` / `nodes.render_url` / `assets.url` 存的是**完整 URL**，所以必须搬文件 + 改库里的 URL，前端才会读新地址。

在 `server` 目录、能连到生产库的环境执行：

```bash
# 先空跑，核对数量和 URL 映射是否正确（不写任何东西）
npx tsx scripts/migrate-blob-to-r2.mts --dry-run

# 确认无误后实际搬运
npx tsx scripts/migrate-blob-to-r2.mts
```

脚本特性：断点续跑（R2 已有且大小一致则跳过）、分批事务回写、先搬文件后改库（任一步失败都不会让前端指向不存在的文件）、只复制不删除。

### 4. 验证
- 抽查首页项目卡片、画布主图、切图历史，确认图片正常显示。
- 在浏览器开发者工具确认图片请求的域名已是 R2 公开域。
- 观察 1–2 周，确认无遗漏后，再到 Vercel 控制台断开 Blob Store 或清空旧桶。

## 回退方案

- 代码与存储适配器未改动，回退只需把 `STORAGE_DRIVER` 改回 `blob`（并保留 BLOB_READ_WRITE_TOKEN），重新部署即可——新稿恢复写入 Blob。
- 数据库 URL 已被脚本改写为 R2 地址；若要完全回退到旧 Blob，需保留迁移前的数据库备份，用备份恢复三张表的 URL 字段。
- 建议：执行迁移前先对 `frames` / `nodes` / `assets` 三张表做一次逻辑备份（导出 url 列 + id）。

## 风险提示

- 迁移前务必确认 R2 公开域可匿名访问（浏览器无痕模式打开任一图片 URL 测试），否则回写后图片会全部 403。
- 大桶搬运耗时较长，脚本可中断续跑；中断后重跑会跳过已完成对象。
