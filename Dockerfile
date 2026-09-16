# Reproducible production image based on the official Bun Alpine runtime.
# Override at build time with: --build-arg BUN_VERSION=x.y.z
ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION}-alpine

USER root
WORKDIR /app

# Copy only files needed at runtime. Runtime state, local credentials and the
# bundled Windows Bun binary never enter the image build context.
COPY --chown=root:root package.json server.js ./
COPY --chown=root:root src ./src
COPY --chown=root:root public ./public
COPY --chown=root:root workflows ./workflows
COPY --chown=root:root scripts/runtime-check.js ./scripts/runtime-check.js
COPY --chown=root:root docker/entrypoint.sh ./docker/entrypoint.sh

# Application code is intentionally not writable by the runtime user.
# Only the explicit /workspace and /data mounts are writable at runtime.
RUN mkdir -p /workspace /data /tmp/home \
    && chown -R bun:bun /workspace /data /tmp/home \
    && chmod 0555 /app/docker/entrypoint.sh \
    && chmod -R a-w /app

ENV NODE_ENV=production \
    MINI_HARNESS_CONTAINER=1 \
    HOST=0.0.0.0 \
    PORT=5175 \
    WORKSPACE=/workspace \
    SESSIONS_DIR=/data/.sessions \
    TRASH_DIR=/data/.sessions-trash \
    ARTIFACTS_DIR=/data/.artifacts \
    MEMORY_DIR=/data/.memory \
    RUNTIME_MODEL_FILE=/data/.runtime-model.json \
    WORKFLOWS_DIR=/app/workflows \
    SANDBOX_SCOPE=workspace \
    SANDBOX_BACKEND=local \
    SANDBOX_STRICT=1 \
    APPROVAL_MODE=ask \
    HOME=/tmp/home \
    XDG_CACHE_HOME=/tmp/cache \
    BUN_INSTALL_CACHE_DIR=/tmp/bun-cache

USER bun
EXPOSE 5175
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||5175)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["bun", "server.js"]
