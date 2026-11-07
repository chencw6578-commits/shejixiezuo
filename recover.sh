#!/usr/bin/env bash
# 一键恢复预览环境（沙箱重置后使用）：postgres → 依赖 → 构建 → seed → server
set -e
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH
export DEBIAN_FRONTEND=noninteractive
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/designhub

# 1. PostgreSQL
if [ ! -x /usr/lib/postgresql/16/bin/pg_ctl ]; then
  echo '[recover] installing postgresql-16...'
  apt-get update -qq && apt-get install -y -qq postgresql-16
fi
if ! pg_lsclusters 2>/dev/null | grep -q '16.*main.*online'; then
  pg_ctlcluster 16 main start
fi
su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='postgres'\"" | grep -q 1 || true
su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres'\"" >/dev/null
su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='designhub'\"" | grep -q 1 || su postgres -c "createdb designhub"

# 2. 依赖 + 前端构建
cd /workspace/server
[ -d node_modules ] || npm install --no-audit --no-fund
cd /workspace/web
[ -d node_modules ] || npm install --no-audit --no-fund
[ -f dist/index.html ] || npm run build

# 3. server（启动时 db.ts 自动建表，必须先于 seed）
PSQL=/usr/lib/postgresql/16/bin/psql
if ! curl -s -m 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
  echo '[recover] starting server...'
  cd /workspace/server
  nohup env DATABASE_URL=$DATABASE_URL PORT=3000 npx tsx src/index.ts >/tmp/server.log 2>&1 &
  for i in $(seq 1 15); do curl -s -m 1 http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break; sleep 1; done
fi

# 4. seed（仅在库为空时；表已由 server 启动建好）
ROWS=$([ -x "$PSQL" ] && $PSQL "$DATABASE_URL" -tAc 'SELECT count(*) FROM design_files' 2>/dev/null || echo 0)
if [ "$ROWS" = "0" ]; then
  echo '[recover] seeding demo data...'
  cd /workspace/server && npx tsx scripts/seed.ts
fi
curl -s http://127.0.0.1:3000/api/health && echo ' <- server OK'
