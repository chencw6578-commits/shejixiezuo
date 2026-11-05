import { Pool } from 'pg';
import { config } from './config.js';

export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

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
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  props        JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_nodes_frame ON nodes(frame_id);
CREATE INDEX IF NOT EXISTS idx_nodes_file_node ON nodes(file_id, node_id);

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
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assets_file ON assets(file_id);
`;

let initialized: Promise<void> | null = null;

export function initDb(): Promise<void> {
  if (!initialized) {
    initialized = pool.query(SCHEMA).then(() => undefined);
  }
  return initialized;
}
