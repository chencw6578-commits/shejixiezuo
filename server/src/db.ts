import { Pool } from 'pg';
import { config } from './config.js';

export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

// 空闲连接上的异步错误（如 PG 偶发 53200）不带走整个进程：记录并丢弃该连接
pool.on('error', (err) => {
  console.error('[db] idle client error (connection dropped):', err.message);
});

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS design_files (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  figma_key   TEXT NOT NULL,
  name        TEXT NOT NULL,
  version     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | processing | ready | failed
  error       TEXT,
  raw         JSONB,
  source      TEXT NOT NULL DEFAULT 'figma',   -- figma | sketch | psd
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 旧库升级
ALTER TABLE design_files ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'figma';

-- P3.5：项目两级结构（项目 → 设计稿）
CREATE TABLE IF NOT EXISTS projects (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE design_files ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_design_files_project ON design_files(project_id);

-- P4：团队结构（团队 → 项目 → 设计稿）
CREATE TABLE IF NOT EXISTS teams (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_projects_team ON projects(team_id);

-- 团队成员（MVP：仅姓名）
CREATE TABLE IF NOT EXISTS team_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);

-- 登录账号（邮箱注册）
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 成员邀请（邮箱）与角色：admin=可编辑可删除，collaborator=只读
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';

CREATE TABLE IF NOT EXISTS frames (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id     UUID NOT NULL REFERENCES design_files(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  page_name   TEXT,
  x           REAL NOT NULL DEFAULT 0,  -- 相对画板自身，恒为 0（画板原点）
  y           REAL NOT NULL DEFAULT 0,
  width       REAL NOT NULL,
  height      REAL NOT NULL,
  thumb_url   TEXT,
  sort_order  INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_frames_file ON frames(file_id);

-- 页面（画板编组）：一个设计稿可有多个页面，画板归属其中一页
CREATE TABLE IF NOT EXISTS pages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id    UUID NOT NULL REFERENCES design_files(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pages_file_name_uniq ON pages(file_id, name);
ALTER TABLE frames ADD COLUMN IF NOT EXISTS page_id UUID REFERENCES pages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_frames_page ON frames(page_id);
-- 编组内排序（不影响画布的全局 sort_order）
ALTER TABLE frames ADD COLUMN IF NOT EXISTS page_sort INT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_frames_page_sort ON frames(page_id, page_sort);
-- 画布自由坐标（null = 尚未排布，首次进入时自动铺一次）
ALTER TABLE frames ADD COLUMN IF NOT EXISTS canvas_x REAL;
ALTER TABLE frames ADD COLUMN IF NOT EXISTS canvas_y REAL;

CREATE TABLE IF NOT EXISTS nodes (
  id           BIGSERIAL PRIMARY KEY,  -- 自增，ORDER BY id 即插入顺序，保证 z-order
  file_id      UUID NOT NULL REFERENCES design_files(id) ON DELETE CASCADE,
  frame_id     UUID NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
  node_id      TEXT NOT NULL,
  parent_id    TEXT,
  name         TEXT,
  type         TEXT,
  x            REAL NOT NULL, -- 相对画板左上角
  y            REAL NOT NULL,
  width        REAL NOT NULL,
  height       REAL NOT NULL,
  visible      BOOLEAN NOT NULL DEFAULT TRUE,
  props        JSONB NOT NULL DEFAULT '{}'::jsonb,
  render_url   TEXT                   -- 渲染资产（矢量 SVG / 位图），为空则用 CSS 近似绘制
);
CREATE INDEX IF NOT EXISTS idx_nodes_frame ON nodes(frame_id);
CREATE INDEX IF NOT EXISTS idx_nodes_file_node ON nodes(file_id, node_id);
-- 节点渲染资产（矢量 SVG / 位图），旧库补列
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS render_url TEXT;

CREATE TABLE IF NOT EXISTS comments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  frame_id    UUID NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
  parent_id   UUID REFERENCES comments(id) ON DELETE CASCADE, -- 回复
  node_id     TEXT,        -- 可选：锚定图层
  x           REAL,        -- 画板内坐标（未锚定图层时为自由钉点）
  y           REAL,
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  resolved    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comments_frame ON comments(frame_id);

-- 平台与倍率：platform 决定逻辑单位（ios→pt / android→dp / web→px），scale 为位图倍率
ALTER TABLE design_files ADD COLUMN IF NOT EXISTS platform TEXT;
ALTER TABLE design_files ADD COLUMN IF NOT EXISTS scale REAL;
ALTER TABLE frames ADD COLUMN IF NOT EXISTS platform TEXT;
ALTER TABLE frames ADD COLUMN IF NOT EXISTS scale REAL;

-- 团队级「导入令牌」：Figma 插件在无浏览器会话时用 Bearer 调用 /api/plugin/*
-- 服务端只存 sha256 哈希，明文只在创建响应里返回一次
CREATE TABLE IF NOT EXISTS import_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  hash         TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_import_tokens_team ON import_tokens(team_id);
-- 令牌作用范围：team=仅创建时的团队；all=可访问全部团队（默认）
ALTER TABLE import_tokens ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'team';
-- 撤销已改为硬删除：启动时清理历史遗留的已撤销记录（幂等）
DELETE FROM import_tokens WHERE revoked_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS assets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id     UUID NOT NULL REFERENCES design_files(id) ON DELETE CASCADE,
  frame_id    UUID,
  node_id     TEXT NOT NULL,
  name        TEXT,
  format      TEXT NOT NULL,
  scale       REAL NOT NULL DEFAULT 2,
  width       REAL,
  height      REAL,
  url         TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'render',  -- figma(插件真实导出) | crop(整板裁剪) | render(服务端近似)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assets_file ON assets(file_id);
-- 旧库升级：历史切图均为服务端近似渲染
ALTER TABLE assets ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'render';
CREATE INDEX IF NOT EXISTS idx_assets_slice ON assets(file_id, node_id, format, scale, source);
`;

let initialized: Promise<void> | null = null;

export function initDb(): Promise<void> {
  if (!initialized) {
    initialized = pool.query(SCHEMA).then(() => undefined);
  }
  return initialized;
}
