# syntax=docker/dockerfile:1
FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable
COPY mcp-server/package.json mcp-server/pnpm-lock.yaml mcp-server/.npmrc ./
RUN pnpm install --frozen-lockfile
COPY mcp-server/tsconfig.json ./
COPY mcp-server/src ./src
RUN pnpm build && pnpm prune --prod

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3846
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app mcp-server/package.json ./
# Operator CLI shim: dist/index.js lands mode 644 in the image (tsc preserves the #!/usr/bin/env node
# shebang but not the exec bit), so make it executable and expose it on PATH as `framefit`.
RUN ln -s /app/dist/index.js /usr/local/bin/framefit && chmod +x /app/dist/index.js
USER app
EXPOSE 3846
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:3846/health || exit 1
CMD ["node", "dist/index.js"]
