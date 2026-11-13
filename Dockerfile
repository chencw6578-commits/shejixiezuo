# Render 单服务部署：一个容器同时提供前端静态站 + Express API + /storage
# （server/src/index.ts 以 cwd 解析 ../web/dist 托管前端，单端口整站运行）

# ---------- 阶段 1：构建前端 ----------
FROM node:22-alpine AS web-build
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
# npm run build（含 prebuild 生成 figma-plugin.zip），产物在 /web/dist
RUN npm run build

# ---------- 阶段 2：构建后端 ----------
FROM node:22-alpine AS server-build
WORKDIR /server
COPY server/package*.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# ---------- 阶段 3：运行 ----------
# 前端产物放 /web/dist：server 以 cwd=/app 运行，path.resolve(cwd, '../web/dist') 正好命中
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY --from=server-build /server/dist ./dist
COPY --from=web-build /web/dist /web/dist
RUN mkdir -p /app/storage
EXPOSE 4000
CMD ["node", "dist/index.js"]
