# Deploy image for pi-runtime.
#
# Everything the agent needs is inside the image except two things, both mounted:
#   /data            state (SQLite, memory.md, archives, backups, pi credentials)
#   the workspace    the directory the agent is allowed to work in
#
# The runtime spawns `pi` from node_modules, so no global install is required.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: nothing here needs a native build step, and skipping postinstall keeps the
# image reproducible (verified locally: pi's CLI and the Lark SDK both land with this flag).
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --registry=$NPM_REGISTRY

# No apt layer on purpose: `node:*-slim` already ships ca-certificates, and `safe` mode has no
# shell tool, so git/curl would only add a slow download (minutes per package behind a slow
# Debian mirror) and 113 MB for nothing. Mount extra tooling if you ever need `full` mode.
FROM node:24-bookworm-slim
RUN useradd -m -u 10001 agent

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY eval ./eval
# mcp/ ships with the image because src/memory.ts imports the shared embedder from
# mcp/lib/embed.mjs. Without this line the runtime crashes on startup with ERR_MODULE_NOT_FOUND
# — the MCP servers themselves still run from the mounted workspace, so only the lib is needed.
COPY mcp ./mcp

RUN mkdir -p /data /workspace && chown -R agent:agent /data /workspace /app
USER agent

ENV NODE_ENV=production \
    PI_RT_DATA_DIR=/data \
    PI_RT_WORKSPACE=/workspace \
    PI_RT_SANDBOX=safe

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=60s --timeout=15s --start-period=30s --retries=3 \
  CMD node src/cli.ts doctor || exit 1

# Long connection: outbound only, so no public IP, certificate or inbound rule is needed.
CMD ["node", "src/cli.ts", "serve", "--channel", "feishu"]
