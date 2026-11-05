# 设计协作 · Design Handoff

内部设计交付工具（对标蓝湖 / Zeplin）：导入 Figma 设计稿，在浏览器中查看设计稿的**尺寸、坐标、颜色、字体规范**，并**下载切图**。

## 功能

- **Figma 导入**：粘贴 Figma 文件链接，后台拉取节点树并解析（画板 / 图层 / 填充 / 描边 / 字体 / 导出预设）
- **画布查看器**：画板渲染图 + 透明热区层，点选图层、悬停查看尺寸、与选中图层自动测量间距
- **设计规范**：位置尺寸 / 圆角 / 透明度 / 填充色（点击复制 HEX）/ 描边 / 阴影 / 字体字号行高
- **切图下载**：读取设计稿中标记的导出预设（如 @2x PNG），也可自定义 PNG / SVG / JPG / PDF 与倍率导出
- **批量切图**：画板内全部图层（或按设计标记的预设）打包 zip 下载
- **规范汇总页**：全文件色板 / 渐变 / 字体统计，按使用次数排序
- **版本同步**：文件页「重新同步」按钮；或配置 Figma Webhook（FILE_UPDATE）自动重导

## 快速开始（开发）

```bash
# 1. 数据库（任选其一）
docker run -d --name pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=designhub -p 5432:5432 postgres:16

# 2. 配置
cp .env.example server/.env   # 填入 FIGMA_TOKEN

# 3. 服务端
cd server && npm i && npm run dev    # http://localhost:4000

# 4. 前端
cd web && npm i && npm run dev       # http://localhost:5173
```

## 生产部署（Docker Compose）

```bash
FIGMA_TOKEN=figd_xxx docker compose up -d --build
# 访问 http://localhost:8080（web → nginx → server，存储走 MinIO）
```

## 架构

```
web/     React + Vite        导入页 / 画板列表 / 画布查看器（热区层 + 图层层树 + 属性面板）
server/  Express + TS + pg
  ├─ figma/client.ts    Figma REST（限流重试 / 导出图片下载）
  ├─ figma/parse.ts     节点树解析：坐标归一化、颜色渐变转 CSS、文本样式、导出预设
  ├─ jobs/importFile.ts 导入任务（进程内队列）：入库 + 画板缩略图
  ├─ storage/           本地磁盘 / S3(MinIO) 双适配器
  └─ routes/            files（导入/列表/画板/图层）+ assets（切图导出）
```

数据流：Figma 文件 JSON 全量入库（`design_files.raw`）→ 解析为画板 `frames` + 图层 `nodes`（坐标归一到画板左上角）→ 画板渲染 PNG 做底图，图层 bounding box 做热区 → 切图走 Figma images API 转存对象存储。

## 分期

- **P1**：导入 + 查看 + 标注 + 单图层切图
- **P2（当前）**：批量切图 zip、设计规范汇总页、手动同步 + Figma Webhook 版本同步
- **P3**：团队协作、代码片段生成、Sketch/PSD 支持
