FROM node:22-alpine

WORKDIR /app

# Copy manifests first for better layer caching
COPY package.json ./
COPY server/package.json ./server/
COPY agent/package.json ./agent/

# Install workspace dependencies (agent provides the `ws` dep used by server too)
RUN npm install --workspaces --include-workspace-root --no-audit --no-fund --omit=dev

COPY server ./server
COPY public ./public
COPY shared ./shared

ENV NODE_ENV=production
EXPOSE 7800

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:$${PORT:-7800}/api/rules" >/dev/null 2>&1 || exit 1

WORKDIR /app/server
CMD ["node", "index.js", "--port", "7800", "--data", "/data"]
