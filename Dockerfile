# 最小运行环境：Bun 的 Alpine 镜像（压缩后约 40MB，含 busybox sh）
#
#   docker build -t mini-harness .
#   docker run --rm -p 5175:5175 -v "${PWD}:/workspace" mini-harness
#
# 为什么这么小：
#   - 本项目零依赖，不需要 npm install（Node 官方镜像里那 51MB 的发行版含 npm/corepack/C++ 头文件，这里用不上）
#   - Bun 是单文件运行时，能直接跑 Node 代码；本项目全部测试在 Bun 下通过
#   - Alpine 基础层只有 3.5MB，且自带 /bin/sh，agent 的 run_shell 能正常工作
#
# 想要官方 Node 运行时（约 56MB）：docker build -f Dockerfile.node -t mini-harness:node .
FROM oven/bun:1-alpine

# 官方镜像自带非 root 用户 bun；万一没有就建一个（保持 uid 1000）
RUN id -u bun >/dev/null 2>&1 || (addgroup -g 1000 bun && adduser -D -u 1000 -G bun bun)

WORKDIR /app
COPY . /app

# /data 放会话/记忆/产物（运行时挂卷），/workspace 是 agent 干活的项目目录
RUN chmod +x /app/docker/entrypoint.sh \
 && mkdir -p /data /workspace \
 && chown -R bun:bun /data /workspace /app

# 容器本身就是隔离边界：文件工具被沙箱限制在 /workspace 内，
# 所以沙箱后端用 local（策略沙箱）即可，不必再套一层 docker。
ENV HOST=0.0.0.0 \
    PORT=5175 \
    WORKSPACE=/workspace \
    SESSIONS_DIR=/data/.sessions \
    TRASH_DIR=/data/.sessions-trash \
    ARTIFACTS_DIR=/data/.artifacts \
    MEMORY_DIR=/data/.memory \
    WORKFLOWS_DIR=/app/workflows \
    SANDBOX_SCOPE=workspace \
    SANDBOX_BACKEND=local \
    APPROVAL_MODE=ask

USER bun
EXPOSE 5175

# busybox 自带 wget，不依赖运行时是 node 还是 bun
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/config" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["bun", "server.js"]
