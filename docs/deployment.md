# Deployment guide

Four shapes, from a laptop to a VPS. Pick the row that matches where the server runs
and who needs to reach it.

| Shape | Where | Auth | Guide |
|---|---|---|---|
| stdio (recommended start) | your machine | none needed — process-local | [README Tier 1](../README.md#tier-1--local-stdio-the-10-minute-path) |
| Docker, local | your machine | none — published on `127.0.0.1` only | [docker/README §1](../docker/README.md) |
| **VPS, single-tenant** | a server you own | **you add it** (SSH tunnel or reverse proxy) | this page |
| VPS, multi-tenant | a server you own | OIDC (external Keycloak) — audience enforcement is opt-in, read the note below | [docker/README §2](../docker/README.md) + notes below |

## VPS, single-tenant — one user, one token, reachable from anywhere

The single-tenant server has **no authentication of its own** and holds your `FIGMA_TOKEN`. It
binds `127.0.0.1` by default (`BIND_HOST`), and refuses `/mcp` requests carrying a browser `Origin`
it does not recognise, so a fresh install is reachable only from the box it runs on. Anyone who can
reach `/mcp` can read every Figma file your token can - so the whole question of a VPS deployment
is *how you gate access*. Two safe answers:

> The loopback default is IPv4-only. A client configured with `http://localhost:3846/mcp` on a host
> whose resolver returns `::1` first will not connect. Fix it on the client: point it at
> `http://127.0.0.1:3846/mcp`, the form every example in this repository uses.
>
> `BIND_HOST=::1` is not the same fix. One listen cannot be both loopback-only and dual-stack, so
> it does not add IPv6 - it swaps which clients break, and `http://127.0.0.1:3846/mcp` then gets
> `ECONNREFUSED`. Never set it on the container either: `/health` reports `loopback: true` for
> `::1`, and the image healthcheck exits 0 only on `"loopback":false`, so the container would go
> permanently unhealthy. The image sets `BIND_HOST=0.0.0.0` on purpose - the compose port mapping
> is what keeps it host-local.

### Option A — SSH tunnel (no domain, no TLS setup, 5 minutes)

Run the server on the VPS exactly like the local path:

```bash
# not-executed: requires-public-repo,contains-placeholder
git clone https://github.com/zylomeara/framefit.git && cd framefit/docker
FIGMA_TOKEN=figd_your_token docker compose --profile local up -d --build --wait
curl -fsS http://127.0.0.1:${MCP_PORT:-3846}/health   # -> {"status":"ok","bind":{"address":"0.0.0.0","loopback":false}}
```

On your workstation, forward the port over SSH:

```bash
# not-executed: long-running-process,contains-placeholder
ssh -N -L 3846:127.0.0.1:3846 you@your-vps
```

The server is now `http://127.0.0.1:3846` locally — connect the client exactly as in
[examples/mcp-config — HTTP transport](../examples/mcp-config/README.md#http-transport):

```bash
# not-executed: requires-mcp-host
claude mcp add --transport http framefit http://127.0.0.1:3846/mcp
```

Nothing is ever exposed publicly; the tunnel is the auth. This is the recommended VPS
shape for a single user.

### Option B — reverse proxy with TLS and basic auth (a real URL)

Prerequisites: a domain pointed at the VPS, Caddy installed (it provisions TLS
automatically). Start the server as in Option A, then front it:

```bash
# not-executed: requires-interactive-input
caddy hash-password   # enter a password, copy the bcrypt hash
```

```caddyfile
mcp.your-domain.com {
	log {
		output file /var/log/caddy/framefit.log
		format json
	}

	# Exempt on purpose: the browser extractor loads this script cross-origin and POSTs its
	# capture back, and neither request can carry basic-auth credentials. The unguessable
	# capToken minted by get_layout_spec is the credential. log_skip keeps that capToken - which
	# travels in the URL path - out of the access log. 2MiB, not 2MB: Caddy reads 2MB as
	# 2,000,000 bytes, below the server's own 2,097,152, and a body between the two dies at the
	# edge as a bare 413 with no CORS header - which a browser can only report as
	# "Failed to fetch".
	@dom_snapshots path /api/dom-snapshots/*
	handle @dom_snapshots {
		log_skip
		request_body {
			max_size 2MiB
		}
		reverse_proxy 127.0.0.1:3846
	}

	handle {
		# /health is behind the credential too. An uptime monitor just sends it:
		# `curl -fsS -u you:<password> https://mcp.your-domain.com/health` returns 200.
		basic_auth {
			you <bcrypt-hash-from-above>
		}
		reverse_proxy 127.0.0.1:3846
	}
}
```

(`Caddyfile.example` in the repo root is the same configuration as a snippet for an existing
Caddyfile, including the `/api/dom-snapshots/*` carve-out. Do not add `encode` to either: the MCP
route is an SSE stream and gzip buffers it.) One server-side setting to add in `docker/.env`:

```dotenv
# The origin browsers and clients actually reach — used in emitted URLs
# (dom-snapshot upload_url, extractor loader). Without it they would point
# at 127.0.0.1 and break for anything outside the VPS.
PUBLIC_BASE_URL=https://mcp.your-domain.com
```

Restart (`docker compose --profile local up -d`), then connect the client with the
auth header:

```bash
# not-executed: requires-mcp-host,contains-placeholder
claude mcp add --transport http framefit https://mcp.your-domain.com/mcp \
  --header "Authorization: Basic $(printf 'you:<password>' | base64)"
```

**Never skip the `basic_auth` block.** An unauthenticated `/mcp` behind a public
domain is an open proxy to your Figma account. The one exception is
`/api/dom-snapshots/*`, which is authenticated by the per-call capability token instead - putting
`basic_auth` in front of it breaks the in-browser capture with an opaque "Failed to fetch" and does
not make the deployment safer. Everything else is behind the credential, `/health` included: an
uptime monitor sends it like any other client -
`curl -fsS -u you:<password> https://mcp.your-domain.com/health` returns 200.

That carve-out is not rate-limited anywhere in this project, and a stock Caddy cannot rate-limit it
either: `rate_limit` is a third-party module, absent from the official binary (verified on 2.11.4 -
`caddy list-modules` lists no rate-limiting module at all). `max_size` bounds one request, not their
rate, so an anonymous caller can keep sending unknown tokens; each costs the server a map lookup, a
drained body it never buffers, and one log line. If that matters on your domain, put the cap outside the snippet above -
rebuild Caddy with `xcaddy build --with github.com/mholt/caddy-ratelimit`, or add a firewall /
fail2ban rule on the prefix - and keep the container's log rotation (`docker/docker-compose.yml`
already caps the json-file driver at 10m x 3), which is what bounds the rejected-upload log lines.

### Cross-library design tokens (optional)

Files that reference variables from *other* published libraries need `DS_TEAM_IDS` —
comma-separated team ids (or `figma.com/team/<id>` URLs) — set on the **server process**
alongside `FIGMA_TOKEN`, so those teams' libraries sync into an in-memory graph and
`get_variables` resolves the aliases headless (`resolved_via:"graph"`); unset, they stay
honestly unresolved.

The first graph-needing call (`get_variables`, `get_design_context`, or `compare_node_to_dom`)
after startup blocks while those libraries sync — several minutes on a large design system (the
~11 libraries / 7000+ variables figure is inherited from earlier notes and was not re-measured
here). Calls that arrive during that sync do not skip it: they join the same in-flight build and
block with it, so for those minutes every graph-needing call waits. None is hung — they all
unblock together when the build finishes, and from then on the sync adds nothing to a call
until the graph goes stale.

The sync is not a one-off either: the graph rebuilds whenever the last confirmed build is older
than `DS_LIBRARY_TTL_SEC` (default `86400` seconds — 24 hours), so on a long-lived server the
first graph-needing call after the TTL lapses pays the same several minutes, roughly once a day.
A build that throws, or that comes back with zero libraries, is not confirmed and does not start
that clock: it is retried by the next graph-needing call past a fixed 60-second interval, so
until one confirmed build lands the cadence is a minute, not a day (see `mcp-server/.env.example`, `DS_LIBRARY_TTL_SEC=86400`).

The `local` compose service passes `DS_TEAM_IDS` through to the container (the same bare
pass-through as `FIGMA_TOKEN`), so just set it at startup — inline or in `docker/.env`:

```bash
# not-executed: contains-placeholder
cd docker
FIGMA_TOKEN=figd_your_token DS_TEAM_IDS=1234567890,9876543210 \
  docker compose --profile local up -d --build
```

To sanity-check a sync without a database or restarting the server, run the diagnostic inside
the container (both `FIGMA_TOKEN` and `DS_TEAM_IDS` are already there from startup):

```bash
# not-executed: requires-running-deployment
cd docker
docker compose exec framefit-local framefit graph check
# -> teams / libraries / variables counts; exit 1 if 0 libraries synced
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
- **Audience enforcement is opt-in, and off by default — so the realm is the blast radius.**
  `ENFORCE_AUDIENCE` defaults to `false`. Enabling it requires a Keycloak audience mapper that
  stamps a framefit-scoped `aud` on the portal's tokens; turn the flag on before that mapper
  exists and every `/accounts` call 401s, which is exactly why it is not the default.

  While it is off, **any valid token from that realm is accepted on `/accounts`** — the API that
  adds and removes Figma PATs, mints CI keys and issues bridge tokens. Signature, issuer and expiry
  are still checked; what is not checked is *who the token was minted for* — the server logs the
  audience mismatch and serves the request anyway. So if framefit shares a realm with other
  applications, a token minted for any one of them can drive `/accounts` as its own subject.
  Configure the mapper, then set `ENFORCE_AUDIENCE=true`; give framefit its own realm if you cannot.

  `/mcp` is a separate case and stays soft **regardless of this flag**, deliberately: hosts that
  register as dynamic OAuth clients present a token whose `azp` framefit cannot predict, so a hard
  check there would break legitimate connectors. A valid same-realm token therefore reaches the
  tool surface — under that subject's own stored PAT — whichever way you set this. There is no
  setting in this repo that changes that; realm separation is the control.

  The server states which of the two it is doing, at boot, so you are not left inferring it from
  config: under the `full` profile `docker compose logs framefit | grep mt.audience_enforcement_disabled`
  prints the line while enforcement is off, and prints nothing once it is on. (`framefit status`
  does *not* cover this — it reports the deployment's mode and subsystems, not this flag.)

  Every admitted mismatch is logged too, one line per request:
  `docker compose logs framefit | grep mt.jwt_audience_soft_mismatch` lists the requests that were
  served while carrying someone else's `aud`/`azp`, and names the client they came from — that is
  how you learn a foreign client is using your `/accounts`, or which connector's tokens `/mcp` is
  admitting. In soft mode it is the *only* signal there is: nothing is refused, so nothing else
  marks it. A matching token logs no line, so a quiet grep is an answer rather than an absence of
  logging.

## Troubleshooting

Run `framefit status` first — it names the failing subsystem instead of you guessing which of the
checks below applies. See [docs/status.md](status.md) for what each check covers.

```bash
# not-executed: alternative-forms,requires-running-deployment
# Four alternatives, not a sequence - pick the row matching where you are. The first three run from
# `docker/`; the last runs from `mcp-server/` in a checkout you have already built.
docker compose exec framefit-local framefit status       # local profile (this page's Option A/B)
docker compose exec framefit framefit status             # full profile (multi-tenant, below)
docker compose run --rm framefit-local framefit status   # container NOT running (crash loop) - see last bullet
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
- `status`'s `config` check only confirms the environment is well-formed, not that `PUBLIC_BASE_URL`
  is the value you meant — a wrong-but-valid URL still reports `[OK]`. If snapshot upload / extractor
  URLs still point at `127.0.0.1` from another machine, set `PUBLIC_BASE_URL` yourself (Option B
  above).
- `docker compose exec ... framefit status` failing with `Container <id> is restarting, wait until
  the container is running` is not a `status` problem — it is the diagnosis. Every service declares
  `restart: unless-stopped`, so a container that dies during boot sits in `Restarting` and `exec`
  has nothing to attach to. Ask the same question with `run` instead, which starts a throwaway
  container from the same image and service environment (`--rm` cleans it up, no host port is
  published, and the image's inherited `docker-entrypoint.sh` execs the arguments it is handed, so
  the command replaces the server cleanly):

  ```bash
  cd docker
  set -o pipefail
  docker compose run --rm framefit-local framefit status | tee /tmp/framefit-crashloop.txt
  docker compose logs framefit-local --tail 20             # the crash itself, for cross-checking
  grep -qE '^[0-9]+ ok, [0-9]+ skipped, [0-9]+ failed' /tmp/framefit-crashloop.txt
  ```

  The `grep` is not ceremony. `docker compose logs` on a service with no container prints nothing
  and exits `0`, so ending the block on it would make this recipe green in exactly the case it is
  written for — measured: `logs framefit-local --tail 20` returned exit `0` and zero lines against a
  tree where nothing had ever started. The assertion is that `run` produced a verdict.

- A port that is **already taken** announces itself at `up` time, not at `exec` time: compose
  reports `Error response from daemon: ports are not available: ... bind: address already in use`
  and the container stays in `Created` (never Running, never Restarting) → retry on another port
  with `MCP_PORT=4000 docker compose --profile local up -d`.
