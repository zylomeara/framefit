# Deployment guide

Four shapes, from a laptop to a VPS. Pick the row that matches where the server runs
and who needs to reach it.

| Shape | Where | Auth | Guide |
|---|---|---|---|
| stdio (recommended start) | your machine | none needed — process-local | [README Tier 1](../README.md#tier-1--local-stdio-the-10-minute-path) |
| Docker, local | your machine | none — binds `127.0.0.1` only | [docker/README §1](../docker/README.md) |
| **VPS, single-tenant** | a server you own | **you add it** (SSH tunnel or reverse proxy) | this page |
| VPS, multi-tenant | a server you own | OIDC (external Keycloak) | [docker/README §2](../docker/README.md) + notes below |

## VPS, single-tenant — one user, one token, reachable from anywhere

The single-tenant server has **no authentication of its own** and holds your
`FIGMA_TOKEN`. It deliberately binds `127.0.0.1`, so nothing is exposed by default.
Anyone who can reach `/mcp` can read every Figma file your token can — so the whole
question of a VPS deployment is *how you gate access*. Two safe answers:

### Option A — SSH tunnel (no domain, no TLS setup, 5 minutes)

Run the server on the VPS exactly like the local path:

```bash
git clone https://github.com/zylomeara/framefit.git && cd framefit/docker
FIGMA_TOKEN=figd_your_token docker compose --profile local up -d --build
curl -s http://127.0.0.1:3846/health   # -> {"status":"ok"}
```

On your workstation, forward the port over SSH:

```bash
ssh -N -L 3846:127.0.0.1:3846 you@your-vps
```

The server is now `http://127.0.0.1:3846` locally — connect the client exactly as in
[examples/mcp-config — HTTP transport](../examples/mcp-config/README.md#http-transport):

```bash
claude mcp add --transport http framefit http://127.0.0.1:3846/mcp
```

Nothing is ever exposed publicly; the tunnel is the auth. This is the recommended VPS
shape for a single user.

### Option B — reverse proxy with TLS and basic auth (a real URL)

Prerequisites: a domain pointed at the VPS, Caddy installed (it provisions TLS
automatically). Start the server as in Option A, then front it:

```bash
caddy hash-password   # enter a password, copy the bcrypt hash
```

```caddyfile
mcp.your-domain.com {
    basic_auth {
        you <bcrypt-hash-from-above>
    }
    reverse_proxy 127.0.0.1:3846
}
```

(`Caddyfile.example` in the repo root shows the same shape as a snippet for an
existing Caddyfile.) Two server-side settings to add in `docker/.env`:

```dotenv
# The origin browsers and clients actually reach — used in emitted URLs
# (dom-snapshot upload_url, extractor loader). Without it they would point
# at 127.0.0.1 and break for anything outside the VPS.
PUBLIC_BASE_URL=https://mcp.your-domain.com
```

Restart (`docker compose --profile local up -d`), then connect the client with the
auth header:

```bash
claude mcp add --transport http framefit https://mcp.your-domain.com/mcp \
  --header "Authorization: Basic $(printf 'you:your-password' | base64)"
```

**Never skip the `basic_auth` block.** An unauthenticated `/mcp` behind a public
domain is an open proxy to your Figma account.

### Cross-library design tokens (optional)

Files that reference variables from *other* published libraries need `DS_TEAM_IDS` —
comma-separated team ids (or `figma.com/team/<id>` URLs) — set on the **server process**
alongside `FIGMA_TOKEN`, so those teams' libraries sync into an in-memory graph and
`get_variables` resolves the aliases headless (`resolved_via:"graph"`); unset, they stay
honestly unresolved. The first graph-needing call (`get_variables`, `get_design_context`, or
`compare_node_to_dom`) after startup blocks while those libraries sync — several minutes on a
large design system (measured ~11 libraries / 7000+ variables), one-time per process; later
calls are fast and the call is not hung.

The `local` compose service passes `DS_TEAM_IDS` through to the container (the same bare
pass-through as `FIGMA_TOKEN`), so just set it at startup — inline or in `docker/.env`:

```bash
FIGMA_TOKEN=figd_your_token DS_TEAM_IDS=1234567890,9876543210 \
  docker compose --profile local up -d --build
```

To sanity-check a sync without a database or restarting the server, run the diagnostic inside
the container (both `FIGMA_TOKEN` and `DS_TEAM_IDS` are already there from startup):

```bash
docker compose exec framefit-local framefit graph check
# → teams / libraries / variables counts; exit 1 if 0 libraries synced
```

Do **not** set `DS_TEAM_IDS` under the multi-tenant (`full`) profile — there the graph is
built per-user from the database; see [docker/README](../docker/README.md).

## VPS, multi-tenant — teams, per-user tokens, OAuth

The `full` compose profile runs the multi-tenant server (Postgres, encrypted per-user
PAT storage, OAuth resource-server against an external OIDC IdP). It is how the
author runs their own deployment, and the server side is fully in this repo — see
[docker/README §2](../docker/README.md) for the env contract.

Honest scope notes before you pick this shape:

- **You bring the IdP.** The server validates JWTs against `KEYCLOAK_JWKS_URL`; realm
  setup and client registration in your Keycloak (or other OIDC provider) are up to you.
- **The admin portal UI is not in this repo** (it is part of the author's private
  deployment). Team registration and token management are driven through the server's
  `/accounts` HTTP API directly.
- Expect assembly. If you just want *a server on a VPS for yourself*, single-tenant
  above is the right shape.

## Troubleshooting

Run `framefit status` first — it names the failing subsystem instead of you guessing which of the
checks below applies. See [docs/status.md](status.md) for what each check covers.

```bash
docker compose exec framefit-local framefit status       # local profile (this page's Option A/B)
docker compose exec framefit framefit status             # full profile (multi-tenant, below)
docker compose run --rm framefit-local framefit status   # container NOT running (crash loop) — see last bullet
node dist/index.js status                                # source checkout, from mcp-server/
```

- `[SKIP] figma` naming a missing `FIGMA_TOKEN`, or `[FAIL] figma` carrying the HTTP status Figma
  returned → the server runs, the token doesn't: check `FIGMA_TOKEN` is set (see
  [README — Figma token](../README.md#figma-token) for scopes) and not expired (Figma PATs expire
  after at most 90 days).
- `[FAIL] config` → the misconfiguration names itself in the check's `reason`, regardless of mode —
  no more matching a crash log by hand. Some of these genuinely abort boot: an invalid `LOG_LEVEL`
  (`loadConfig` throws before the server starts) or `DS_TEAM_IDS` together with `MULTI_TENANT=true`
  (a hard boot guard, `fatal:` + exit 1) leave the container restart-looping, which is exactly when
  `docker compose run` is the way to ask. Others are misconfigurations the server *survives*:
  `DS_TEAM_IDS` set without `FIGMA_TOKEN` boots healthy and only logs
  `env_graph.disabled_no_token`, leaving cross-library aliases silently unresolved — nothing
  crashes, so this check is the only place it surfaces.
- `[FAIL] key` → `ENCRYPTION_KEY` is set but isn't a 64-char hex string. The `local` profile above
  never wires `ENCRYPTION_KEY` into the container at all, so you'd only see this from a source
  checkout or a hand-exported value; regenerate with `openssl rand -hex 32`.
- `status`'s `config` check only confirms the process would boot, not that `PUBLIC_BASE_URL` is
  the value you meant — a wrong-but-valid URL still reports `[OK]`. If snapshot upload / extractor
  URLs still point at `127.0.0.1` from another machine, set `PUBLIC_BASE_URL` yourself (Option B
  above).
- `docker compose exec ... framefit status` failing with `Container <id> is restarting, wait until
  the container is running` is not a `status` problem — it is the diagnosis. Every service declares
  `restart: unless-stopped`, so a container that dies during boot sits in `Restarting` and `exec`
  has nothing to attach to. Ask the same question with `run` instead, which starts a throwaway
  container from the same image and service environment (`--rm` cleans it up, no host port is
  published, and the image is CMD-only so the command replaces the server cleanly):

  ```bash
  docker compose run --rm framefit-local framefit status   # or `framefit` under the full profile
  docker compose logs framefit-local --tail 20             # the crash itself, for cross-checking
  ```

- A port that is **already taken** announces itself at `up` time, not at `exec` time: compose
  reports `Error response from daemon: ports are not available: ... bind: address already in use`
  and the container stays in `Created` (never Running, never Restarting) → retry on another port
  with `MCP_PORT=4000 docker compose --profile local up -d`.
