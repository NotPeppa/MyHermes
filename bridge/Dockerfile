# 单进程推送桥：镜像里只跑桥本身，不需要 Node 环境
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV HOST=0.0.0.0 PORT=8787 DB_PATH=/data/bridge.db STATE_PATH=/data/poller-state.json
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "src/server.mjs"]
