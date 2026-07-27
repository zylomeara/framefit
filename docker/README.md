# Running framefit with Docker Compose

`docker-compose.yml` defines two deployment shapes, each selected by a **compose
profile**. Nothing starts without a profile — there are no profile-less services —
so `docker compose up` with no `--profile` is a no-op. Pick one:

| Profile | Command                                              | What you get                                                                 |
|---------|------------------------------------------------------|------------------------------------------------------------------------------|
| `local` | `docker compose --profile local up -d --build`       | Single-tenant server only. No DB, no auth, no secrets. Binds `127.0.0.1:3846`.|
| `full`  | `COMPOSE_PROFILES=full docker compose up -d --build`  | The **production** service set: multi-tenant MCP + Postgres, authenticating against an **external** Keycloak (or any OIDC IdP). |

---

## 1. `local` — the 10-minute "does it run" path

Everything a contributor needs to see the server serve, with only Docker installed:

```bash
cd docker
docker compose --profile local up -d --build
curl -s http://127.0.0.1:3846/health          # -> {"status":"ok"}
# … MCP over HTTP at http://127.0.0.1:3846/mcp
docker compose --profile local down
```

Or just run the smoke test, which does all of the above and tears down again:

```bash
cd docker
./smoke-local.sh          # build → health → MCP initialize → down
KEEP_UP=1 ./smoke-local.sh   # …but leave it running
MCP_PORT=4000 ./smoke-local.sh   # …on a different host port
```

- **No token needed** for `/health` and MCP `initialize`. To make real Figma calls,
  supply a token: `FIGMA_TOKEN=figd_… docker compose --profile local up -d`, or put
  `FIGMA_TOKEN=…` in `docker/.env`.
- `PUBLIC_BASE_URL` is pinned to `http://127.0.0.1:${MCP_PORT:-3846}` so the extractor
  loader / dom-snapshot `upload_url` point at the host-published port.

---

## 2. `full` — production (multi-tenant)

The production service set: the multi-tenant MCP server plus its Postgres, authenticating
against an **external** Keycloak (or any OIDC identity provider). Production runs the exact
same file; the only repo-side change vs. the historical deploy is that the compose literals
are now `${VAR:-<localhost default>}`, so every prod-specific value comes from `docker/.env`
(git-ignored) instead of being hard-coded. Set `COMPOSE_PROFILES=full` in `docker/.env` and
the historical command is **byte-for-byte unchanged**:

```bash
cd docker
docker compose up -d --build framefit        # multi-tenant MCP + Postgres (its dependency)
```

`COMPOSE_PROFILES=full` makes compose resolve the profile itself, so no `--profile` flag is
needed:

```bash
COMPOSE_PROFILES=full docker compose config --services
# framefit
# figma-postgres        ← the multi-tenant server and its database, nothing else
```

> **The admin portal is not in this repository.** The multi-tenant server exposes an
> `/accounts` HTTP API (team registration, PAT management). The author's deployment drives
> that API from an admin web portal — a separate app that is **not** part of this repo. The
> server itself — its `MULTI_TENANT` mode and the `/accounts` API — is fully here; the portal
> UI is not. For day-to-day operation you don't need the portal — the image ships a `framefit`
> operator CLI (next).

### Operator CLI — teams and syncs without the portal

The image puts a `framefit` operator CLI on `PATH`; run it inside the running `framefit`
container. `teams`/`sync`/`users` use the service's `DATABASE_URL` (and `ENCRYPTION_KEY` from
`mcp-server/.env`, needed to decrypt a stored PAT for `sync`) — no extra config. PAT registration
itself stays on the `/accounts` API; `users` lists whoever already has one on file.

Start with `status`: it needs no prerequisites — it just reports whatever is and isn't configured
— and exits `0` when nothing failed, `1` when a check failed, `2` when it could not run at all
(usage error, internal throw, or its own hard deadline). See [docs/status.md](../docs/status.md)
for what each of the six checks means.

```bash
# Diagnose this instance - which subsystem, if any, is broken:
docker compose exec framefit framefit status

# Who already has a Figma PAT registered (via the /accounts API):
docker compose exec framefit framefit users

# Register a design-system team for a user (bare id or a figma.com/team/<id> URL):
docker compose exec framefit framefit teams add 1234567890 --user <keycloak-user-id>
docker compose exec framefit framefit teams list --user <keycloak-user-id>

# Build that user's cross-library variable graph from the registered teams:
docker compose exec framefit framefit sync --user <keycloak-user-id>
# → synced user <id>: N libraries, M variables, K skipped

# Mint an upload token for the variable-snapshot ingest (capture it, don't redirect it into the repo):
TOKEN=$(docker compose exec -T framefit framefit bridge-token --user <keycloak-user-id>)
```

The last command belongs to the snapshot rescue path for a library whose variables REST keeps
refusing to serve (`400 Request too large` — intermittent, so retry and consider splitting the file
first): mint a short-lived token, then upload the values with any client you like — the endpoint,
auth and body shape are documented in [`docs/snapshot-ingest.md`](../docs/snapshot-ingest.md).
Bridge-tokens cannot be revoked, so keep the 30-minute default and mint on demand.

> **A running server keeps its graph in memory.** `sync` writes the fresh graph to Postgres, but a
> live server holds the graph it built for the life of the process. Restart the `framefit` service
> for a fresh sync to take effect.

### One-time: the encryption key

The multi-tenant server encrypts stored Figma PATs (AES-256-GCM) with `ENCRYPTION_KEY`. It
lives in `mcp-server/.env` (git-ignored) and compose delivers it via `env_file`. Do **not**
put it in `docker/.env`: compose `environment` entries take precedence over `env_file`, so an
env_file-supplied secret must never also be listed under `environment`.

```bash
cd docker
[ -f ../mcp-server/.env ] || cp ../mcp-server/.env.example ../mcp-server/.env
grep -q '^ENCRYPTION_KEY=' ../mcp-server/.env || \
  echo "ENCRYPTION_KEY=$(openssl rand -hex 32)" >> ../mcp-server/.env
```

### Required `docker/.env` on the production host

Previously the production URLs were compose literals; they are now variables. Before deploying
with this compose file, `docker/.env` on the production host must carry (in addition to
`POSTGRES_PASSWORD`) — replace the `example.com` hosts with your own domains and point the
Keycloak URLs at your external IdP:

```dotenv
COMPOSE_PROFILES=full
POSTGRES_PASSWORD=<openssl rand -hex 16>

# MCP (multi-tenant) — the former compose literals:
KEYCLOAK_JWKS_URL=https://auth.example.com/realms/mcp/protocol/openid-connect/certs
OAUTH_AUTHORIZATION_SERVER=https://auth.example.com/realms/mcp
MCP_HOST=figma.mcp.example.com
PUBLIC_BASE_URL=https://figma.mcp.example.com
```

> `ENCRYPTION_KEY` is deliberately **not** listed here — it stays in `mcp-server/.env`
> (env_file) exactly as today, and it is deliberately **not mentioned in the compose
> `environment` block at all**. Compose `environment` entries take precedence over
> env_file, and even a *bare* entry (`- ENCRYPTION_KEY`, no `=`) with the host var unset
> does not fall through to env_file — it **removes** the variable from the container.
> Rule: a variable supplied by env_file must never also appear under `environment`.

> **`PUBLIC_BASE_URL` shadow warning:** the opposite trap. It IS listed under `environment`
> (with a localhost default), and that entry **shadows** any value in `mcp-server/.env` —
> so prod **must** set `PUBLIC_BASE_URL` explicitly in `docker/.env` (as in the block
> above). Setting `MCP_HOST` alone is no longer sufficient: without `PUBLIC_BASE_URL` in
> `docker/.env` the server would advertise `http://localhost:3846` as its OAuth identity.

If any of the MCP vars above is missing on prod, the multi-tenant server silently falls back
to its localhost defaults and auth breaks — treat the block as a required pre-deploy checklist.

---

## 3. Deploying from a published image (instead of building on the host)

CI (`.github/workflows/ci.yml`, job `publish-image`) builds `docker/Dockerfile` and pushes it
to **`ghcr.io/zylomeara/framefit`** — only after `unit`, `integration`, `stdio-smoke` and
`secrets-scan` are green. Tag scheme:

| Tag                       | When                                | Use it for                                    |
|---------------------------|-------------------------------------|-----------------------------------------------|
| `sha-<short>`             | every push to `main`                | naming a commit's build — stable, but see below|
| `main`                    | every push to `main`                | moving pointer — convenience, not a pin       |
| `<x.y.z>`, `<x.y>`, `latest` | **only** on a `v*` git tag       | releases                                      |

The version numbers do **not** advance on every push — only a `v*` tag mints them. So a
`main`/`sha-` image built after a release still reports the released version in its handshake;
the truth about what is deployed is the image **digest** plus the
`org.opencontainers.image.revision` OCI label (`docker inspect` the running container).

**Pin the digest, not the tag** — including `sha-<short>`, which looks immutable because it
names a commit. It is not: each publish of that commit builds a fresh image and the builds are
not bit-reproducible. On commit `28df820` the push-to-`main` run and the `v0.11.0` tag run each
pushed `sha-28df820` with a different digest, so the tag names whichever finished last.
Re-running a workflow, or tagging an already-published commit, moves it the same way.

The host then **pulls instead of building** — no compile on the box:

```bash
# resolve the tag you want to its digest (downloads nothing), then pin that
docker buildx imagetools inspect ghcr.io/zylomeara/framefit:v0.11.0 --format '{{.Manifest.Digest}}'
docker pull ghcr.io/zylomeara/framefit@sha256:<digest>
# then REPLACE the service's `build:` block with `image: ghcr.io/zylomeara/framefit@sha256:<digest>`
# — never keep both: a service with `image:` AND `build:` silently builds when a pull fails,
# which defeats the whole point of pinning. In this repo's compose the `full` service is
# build-only by design; the image-consuming production compose lives in the author's private
# deploy repo.
docker compose up -d --wait --wait-timeout 120 framefit
```

Rollback = pin the previous `sha-…`, pull, `up -d --wait` again. There is **no auto-deploy**:
CI publishes the image, a human decides when the host takes it.

### Two GHCR gotchas (both one-time, both bite silently)

- **Package visibility is not inherited from the repository.** Making the repo public does not
  make the package public. After the repo flips, set the package to public by hand in the GHCR
  package settings — until then, pulling needs a credential (a classic PAT with `read:packages`;
  fine-grained tokens have no such scope today).
- **The first push must come from CI.** If you hand-push an image to this namespace from a
  laptop first, GitHub creates a package that is not linked to the repository, and CI's
  `GITHUB_TOKEN` then gets a permanent `403` on it until the package is manually linked or
  deleted. Let `publish-image` create it.

---

## Secrets policy

**No literal secret is committed.** The only credentials that appear are obvious localhost
dev defaults, all overridable:

| Value             | Default (local)                        | Source                                                                |
|-------------------|----------------------------------------|-----------------------------------------------------------------------|
| Postgres password | `devpassword`                          | `${POSTGRES_PASSWORD:-…}`                                             |
| Encryption key    | *(none — you generate one for `full`)* | `mcp-server/.env` **only** (env_file; never in compose `environment`) |

Prod supplies real values via `docker/.env` (git-ignored) and `mcp-server/.env`.

---

## Failure modes

- **Port already in use** (`3846`): another process (or another profile) holds the port.
  `3846` is overridable via `MCP_PORT`.
- **`full` MCP won't start — "Missing required multi-tenant env vars: ENCRYPTION_KEY"**:
  add `ENCRYPTION_KEY=$(openssl rand -hex 32)` to `mcp-server/.env` (NOT `docker/.env` — see § 2).
- **MCP crash-loops with `invalid env config: FIGMA_TOKEN: String must contain at least 1
  character(s)`**: your image predates the empty-string coercion fix and your `mcp-server/.env`
  has a bare `FIGMA_TOKEN=` line (an empty assignment that docker's env_file injects as `''`).
  Rebuild the image (`docker compose --profile <local|full> up -d --build`) — current
  code treats an empty `FIGMA_TOKEN` as "not configured" — or delete/comment the empty line.
