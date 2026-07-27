# Framefit
[![CI](https://github.com/zylomeara/framefit/actions/workflows/ci.yml/badge.svg)](https://github.com/zylomeara/framefit/actions/workflows/ci.yml)

Does your UI actually **fit the frame**? A **headless Figma MCP server for AI agents** — read
the Figma REST API without opening the desktop app, and **verify** a rendered UI against its
design with a deterministic metric diff that refuses to say "fits" unless it actually measured it.

## Why this exists

Most Figma-to-code tooling hands an agent *context and hope*: here is the design, now trust the
model to reproduce it and to judge whether it did. This server adds a **verification layer** on
top of headless design reads. Ask it "does my page match the frame?" and it answers with numbers,
not vibes — and it is built to **not lie**:

- **Verification receipt** — a machine gate (`verification.complete`). Green means every paired
  region was measured and nothing was left unchecked; anything out of reach is enumerated, never
  silently passed off as verified.
- **Source hint** — *which file*. Diffs carry a code address parsed from CSS-module class names
  (works in production builds too), so a failing row points at `ProductCard.module.css`, not just
  "font-weight is wrong".
- **Fix plan** — *what to change*. Fail rows are regrouped into concrete edits per candidate file.
- **Strictness profiles** — `strict` / `layout` / `token-aware`: a named tolerance-and-scope preset
  per run. A profile never relaxes a verdict; `layout` even blocks a final green until you re-run
  full-scope.

**Versus the official Figma Dev Mode MCP.** That server is *interactive* — it reads the file you
have open in the Figma desktop app and returns design context for the model to act on. This one is
**headless**: it talks to the Figma REST API with a personal access token, so an agent (or CI) can
read any file it has access to with no app, no open document, no seat. On top of the read side it
adds the deterministic verification loop above, which Dev Mode does not have.

> **Honest scope.** The verification layer is battle-tested against **one large production design
> system**, not yet a broad matrix of them. It is deliberately conservative — it would rather say
> "unchecked" than green something it did not measure. See
> [what the diff covers — honestly](docs/coverage.md).

## Quickstart

### Tier 1 — local stdio (the 10-minute path)

No server to host, no database, no auth. Claude Code spawns and tears down the process itself.
Prerequisites: Node 20+ and [pnpm](https://pnpm.io/installation).

```bash
git clone https://github.com/zylomeara/framefit.git && cd framefit/mcp-server
pnpm install
pnpm build
node dist/index.js status   # sanity check: is this checkout able to do its job?
```

That last line is [`framefit status`](docs/status.md) — a full diagnosis of the instance, worth
knowing about before anything else here breaks.

Register it with Claude Code — replace the path with your absolute checkout path and supply a
[Figma token](#figma-token):

```bash
claude mcp add framefit \
  --env MCP_TRANSPORT=stdio \
  --env FIGMA_TOKEN=figd_your_token_here \
  -- node /absolute/path/to/framefit/mcp-server/dist/index.js
```

Run `/mcp` inside Claude Code to confirm the 26 tools are live. Ready-to-copy config variants
(project-scoped `.mcp.json`, global) are in [`examples/mcp-config/`](examples/mcp-config/).

For cross-library design tokens, add `--env DS_TEAM_IDS=<team-id>,…` (comma-separated team ids or
`figma.com/team/<id>` URLs): the named teams' published libraries sync into an in-memory graph so
`get_variables` resolves those aliases headless (`resolved_via:"graph"`) — see
[`docs/tools/design-system.md`](docs/tools/design-system.md#get_variables). Unset, aliases stay
honestly unresolved. The first graph-needing call (`get_variables`, `get_design_context`, or
`compare_node_to_dom`) after startup blocks while those libraries sync — several minutes on a large
design system (measured ~11 libraries / 7000+ variables), one-time per process; later calls are
fast and the call is not hung.

> An npm package is on the way — it will replace the clone-and-build step with a one-line
> `claude mcp add framefit -- npx -y framefit`. Until it is published, use the path form above.

### Tier 2 — Docker (single-tenant or the production stack)

For a hosted HTTP server, or the production-shaped multi-tenant stack (MCP + Postgres against an
external Keycloak):

```bash
cd docker
docker compose --profile local up -d --build   # single-tenant HTTP on 127.0.0.1:3846
curl -s http://127.0.0.1:3846/health            # -> {"status":"ok"}
```

The compose file is profile-driven (`local` / `full`); prerequisites and production notes are in
[`docker/README.md`](docker/README.md). Putting it on a VPS (SSH tunnel or TLS + basic-auth
reverse proxy — the server has no auth of its own) is covered in [`docs/deployment.md`](docs/deployment.md).

## Tools

26 MCP tools, grouped below. Per-tool descriptions and parameters (taken from the live
`tools/list`) live in [`docs/tools/`](docs/tools/README.md) — this table is a map, not the catalog.

| Group | Tools | Reference |
| --- | --- | --- |
| **Design QA** | `get_layout_spec`, `suggest_pairs`, `compare_node_to_dom`, `find_breakpoint_variant`, `get_view` | [design-qa.md](docs/tools/design-qa.md) |
| **Navigation & content** | `get_metadata`, `find_nodes`, `get_node_ancestry`, `get_text_styles`, `compare_breakpoints`, `get_screenshot`, `export_assets`, `get_design_context` | [navigation.md](docs/tools/navigation.md) |
| **Comments & review** | `get_comments`, `summarize_comments`, `find_threads`, `post_comment`, `reply_to_comment`, `resolve_comment`, `get_review_board`, `get_pin_detail` | [comments-review.md](docs/tools/comments-review.md) |
| **Design system** | `get_variables`, `search_design_system`, `get_libraries`, `get_code_connect_map`, `get_figjam` | [design-system.md](docs/tools/design-system.md) |

## Using with AI agents

The design-QA loop is packaged as a reusable agent skill:
[`docs/agents/design-qa-skill.md`](docs/agents/design-qa-skill.md). Copy it to
`.claude/skills/figma-design-qa/SKILL.md` in your project and the agent runs the verify-before-done
cycle automatically.

- [Design QA tutorial](docs/design-qa-tutorial.md) — the full cycle end to end (pairs → compare →
  verification receipt → fix plan → strictness profiles).
- [What the diff covers — honestly](docs/coverage.md) — the deterministic-vs-verify-by-eye table.

## Figma token

The server authenticates to Figma with a personal access token (`FIGMA_TOKEN`). Generate one in
Figma: **Settings → Security → Personal access tokens**, with scopes:

- `file_comments:read`
- `file_content:read`
- `file_variables:read` — Enterprise only; enables `get_variables` and token-name resolution in
  design context. Everything else works without it.

Keep the token in the client's env block (Tier 1) or `mcp-server/.env` — never in a committed
config file. Note: Figma PATs now expire after at most 90 days.

## Multi-tenant deployment (optional)

Beyond single-tenant, the server can run **multi-tenant**: each user authenticates with an OAuth
JWT (Keycloak or any OIDC IdP) and the server stores their Figma PAT encrypted (AES-256-GCM),
managed through the server's `/accounts` HTTP API (team registration, token management, CI keys,
variable snapshots). The `MULTI_TENANT` server and that `/accounts` API are **fully in this repo**.
The **admin portal UI** and the **Dev-Mode variable-snapshot plugin** the author's deployment
drives them with are **not** — those are part of the author's own private deployment, not a
public service you can sign up for. You don't need the portal to run it: operators diagnose an
instance with `framefit status` ([docs/status.md](docs/status.md)) and register teams / trigger
library syncs with the bundled `framefit` operator CLI (`framefit teams add`, `framefit sync`) —
the walkthrough is in [`docker/README.md`](docker/README.md).

Two design-system capabilities build on the multi-tenant store and are inactive in
single-tenant/stdio:

- **Code Connect enrichment.** Figma exposes Code Connect only through Dev Mode and the
  `figma connect` CLI — there is *no public REST endpoint*. So a headless server ingests CI-parsed
  mappings: your design-system CI runs `figma connect parse` and POSTs the JSON, and
  `get_design_context` / `get_code_connect_map` then enrich instances with code snippets.
- **Cross-library token resolution.** Figma's REST API returns external-library variable aliases
  unresolved. The server closes that gap two ways — a **headless graph** built from your registered
  design-system teams' variable libraries, and a per-user **plugin snapshot** fallback (a Dev-Mode
  plugin uploads resolved values). Resolution is graph-first with snapshot fallback, at each
  collection's default mode; it reached ~99% on two real consumer files (the rest are files REST
  cannot serve — timeouts, `400 Request too large`, or "disable copying" — irreducibly interactive).

Both build on the multi-tenant store; deployment shapes are in
[`docker/README.md`](docker/README.md).

## Development

```bash
cd mcp-server
pnpm install
cp .env.example .env      # fill FIGMA_TOKEN
pnpm dev                  # http://127.0.0.1:3846
pnpm test                 # unit tests   (pnpm typecheck for types)
```

The server is hexagonal (domain / ports / application / adapters); `MCP_TRANSPORT` selects `http`
(Express + Streamable HTTP, for the docker/VPS deploy) or `stdio` (host-spawned, for local Claude
Code). [`mcp-server/.env.example`](mcp-server/.env.example) documents the full configuration
surface. Contributing a PR? See [CONTRIBUTING.md](CONTRIBUTING.md) for testing norms and repo
layout.

## Project status

Early `0.x` — the tool surface may still change between minor versions. The verification layer is
production-tested against one large design system; broader coverage and an npm release are in
progress. MIT-licensed (see [`LICENSE`](LICENSE)).
