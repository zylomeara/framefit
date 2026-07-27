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
# LOAD-BEARING. The process default is loopback (config.ts BIND_HOST), which inside a container
# means the published port is dead: docker's port publication forwards to the container's routable
# interface, not to its loopback. Deleting this line is a silent outage, which is why the
# healthcheck below refuses to pass without it.
ENV BIND_HOST=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app mcp-server/package.json ./
# Operator CLI shim: dist/index.js lands mode 644 in the image (tsc preserves the #!/usr/bin/env node
# shebang but not the exec bit), so make it executable and expose it on PATH as `framefit`.
RUN ln -s /app/dist/index.js /usr/local/bin/framefit && chmod +x /app/dist/index.js
USER app
EXPOSE 3846
# The healthcheck runs INSIDE the container and structurally cannot observe host-side port
# publication, so it asks the SERVER what it bound and believes the answer.
#   1. It does NOT classify the bind address itself. Three review rounds of shell pattern-matching
#      over BIND_HOST produced three separate false greens - 127.0.0.2, then 0:0:0:0:0:0:0:1, then
#      the ::ffff: family in four more spellings - each one a container reporting HEALTHY with a
#      dead published port. Address classification now lives in application code
#      (isLoopbackBind, server.ts) over the KERNEL-canonical address from server.address(), where
#      the loopback space is finite, provable and unit-tested. A new spelling cannot reach a
#      pattern here because there is no pattern here.
#   2. GET /health answers {"status":"ok","bind":{"address":"<canonical>","loopback":<bool>}}.
#      The check requires "loopback":false to be PRESENT: fail-closed, so a server that stops
#      reporting the field (older image, future refactor) goes unhealthy instead of silently
#      passing - the failure mode that let every earlier hole through was a check that could not
#      tell "fine" from "did not look".
#   3. BIND_HOST is still read, but ONLY to build the URL to dial: a container bound to its own
#      routable address answers on that address alone, so a hard-coded 127.0.0.1 probe would mark a
#      serving container unhealthy (verified live). Every valid spelling dials correctly - brackets
#      make any IPv6 form a working URL authority - so a misread here can only cost a FALSE ALARM,
#      never a false green. That asymmetry is the point: the verdict comes from the server.
# Deliberately NOT a discovered address (`hostname -i` / `ip route get`) and not busybox netstat
# parsing: the server already holds the canonical address, and reading it needs no applet.
# KNOWN AND ACCEPTED, false ALARM: under `network_mode: host` a loopback bind is correct and
# reachable, yet loopback:true still fails the check. Nothing inside the container can distinguish
# that case, and neither compose profile here uses host networking - both publish ports.
# KNOWN AND ACCEPTED, false GREEN: a container attached to two or more networks and bound to an
# interface docker did NOT publish to reports healthy while its published port is dead - the
# publication DNAT lives on the HOST, so nothing running in the container's network namespace can
# observe which of its interfaces the host forwards to (no pattern, no payload and no socket read
# closes this). Every design weighed for this check produces that row; reaching it takes an operator
# who attaches 2+ networks AND points BIND_HOST at the non-published one, which neither compose
# profile here does.
# tests/unit/bind-host.test.ts EXECUTES the line below through /bin/sh (dial-target rows) and
# unit-tests the verdict function over every spelling, so both halves are machine-checked.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD case "$BIND_HOST" in ''|0.0.0.0|::) H=127.0.0.1 ;; *:*) H="[$BIND_HOST]" ;; *) H="$BIND_HOST" ;; esac; R=$(wget -q -O- "http://$H:${PORT}/health") || exit 1; case "$R" in *'"loopback":false'*) exit 0 ;; esac; exit 1
CMD ["node", "dist/index.js"]
