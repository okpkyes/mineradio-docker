# ====================================================================
#  Mineradio-LX (基于 lmh200609/Mineradio-LX-qs) Dockerfile — NAS 调校版
#   - 纯 Node 运行时：通过 --omit=dev 排除 electron/electron-builder/rcedit
#   - 运行时依赖：gsap / mpg123-decoder / NeteaseCloudMusicApi
#   - 构建期如需更换镜像源规避 502，传入：
#       docker compose build --build-arg NODE_IMAGE=docker.1ms.run/library/node:20-slim
# ====================================================================
ARG NODE_IMAGE=node:20-slim
FROM ${NODE_IMAGE}

WORKDIR /app

# 沿用宿主机已有的 .npmrc（含 NAS 镜像源），不要覆盖
COPY .npmrc /app/.npmrc

# 先装依赖（利用 Docker 层缓存）
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts || npm install --omit=dev --ignore-scripts

# 拷贝应用源码（纯 Node，无 Electron 运行时耦合）
COPY server.js dj-analyzer.js ./
COPY src ./src
COPY desktop ./desktop
COPY public ./public

# 健康检查依赖 curl
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

EXPOSE 8765

ENV PORT=8765
ENV HOST=0.0.0.0
ENV MUSIC_ROOT=/music
ENV MINERADIO_USER_DATA_DIR=/data
ENV MINERADIO_LIBRARY_FILE=/data/mineradio-library.json
ENV MINERADIO_LX_SOURCE_DIR=/data/lx-sources
ENV COOKIE_FILE=/data/netease-cookie
ENV QQ_COOKIE_FILE=/data/qq-cookie

# 声明卷挂载点（实际挂载由 docker-compose 的 volumes 决定）
VOLUME ["/music", "/data"]

# Docker 健康检查（lmh 无 /api/health，探测首页）
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=10s \
  CMD curl -f http://localhost:8765/ || exit 1

CMD ["node", "server.js"]
