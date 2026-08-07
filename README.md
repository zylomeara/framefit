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
  "font-weight is wrong". Minified builds can turn this on with one bundler setting — see
  [docs/named-classes.md](docs/named-classes.md).
- **Fix plan** — *what to change*. Fail rows are regrouped into concrete edits per candidate file.
- **Strictness profiles** — `strict` / `layout` / `token-aware`: a named tolerance-and-scope preset
  per run. A profile never relaxes a verdict; `layout` even blocks a final green until you re-run
  full-scope.

**Versus Figma's own MCP servers.** Figma ships two: a remote server its docs recommend for most
users, which needs no desktop app, and a desktop server that runs inside the app for specific
organization and enterprise needs. Both answer *what this design contains* — they return design
context for a model to act on. framefit answers a different question: *does the UI you built
actually match it*. It reads Figma over the REST API with a personal access token, so an agent or a
CI job can pull any file that token can reach with no interactive client, and then measures a
rendered DOM against the frame and returns a machine-checkable verdict with a done-gate. That
verification loop is what neither Figma server does.

Both paths are subject to Figma's per-seat rate limits. The MCP path additionally carries a daily
tool-call cap — as of July 2026, 200/day on Professional and Organization plans, 600/day on
Enterprise, and 6/month on View and Collab seats — invisible in interactive use, a wall in CI. Figma
reserves the right to change these, so check
[the current numbers](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/) before
planning batch usage.

> **Honest scope.** The verification layer is battle-tested against **one large production design
> system**, not yet a broad matrix of them. It is deliberately conservative — it would rather say
> "unchecked" than green something it did not measure. See
> [what the diff covers — honestly](docs/coverage.md).

## Quickstart

### Tier 1 — local stdio (the 10-minute path)

No server to host, no database, no auth, and nothing to clone: Claude Code spawns and tears down
the process itself. Prerequisite: Node 20+.

```bash
# not-executed: runs-published-package
npx -y framefit status
```

That is [`framefit status`](docs/status.md), a full diagnosis of the instance and worth meeting
before anything else here breaks. It needs no token, exits 0, and marks everything it cannot see
`[SKIP]` instead of guessing — including the token itself, which on stdio lives in your MCP host's
env block and not in your shell. Measured from an empty npm cache: about ten seconds to download
and answer.

Register it with Claude Code and supply a [Figma token](#figma-token):

```bash
# not-executed: requires-mcp-host,contains-placeholder
claude mcp add framefit \
  --env MCP_TRANSPORT=stdio \
  --env FIGMA_TOKEN=figd_your_token_here \
  -- npx -y framefit
```

Run `/mcp` inside Claude Code to confirm the 26 tools are live. Ready-to-copy config variants
(project-scoped `.mcp.json`, global) are in [`examples/mcp-config/`](examples/mcp-config/).

#### From source instead

If you want to read or change the code, the checkout replaces `npx` and nothing else does. It
additionally needs [pnpm](https://pnpm.io/installation):

```bash
# not-executed: clones-published-main
git clone https://github.com/zylomeara/framefit.git && cd framefit/mcp-server
pnpm install
pnpm build
node dist/index.js status   # the same diagnosis, from this checkout
```

Register that form by absolute path instead of `npx`:

```bash
# not-executed: requires-mcp-host,contains-placeholder
claude mcp add framefit \
  --env MCP_TRANSPORT=stdio \
  --env FIGMA_TOKEN=figd_your_token_here \
  -- node /absolute/path/to/framefit/mcp-server/dist/index.js
```

#### One prerequisite is not a package

The design-QA cycle measures a *rendered* page, so it drives a
real browser through a browser-automation MCP running alongside framefit (the
[agent skill](docs/agents/design-qa-skill.md) is written against chrome-devtools tool names). On
stdio there is no server for that browser to fetch the DOM extractor from, so `get_layout_spec`
hands it back inline — 58116 characters, once per session if you park it on a global
(`() => { window.__extract = <extractor_js VERBATIM>; return 'ok'; }` — `evaluate_script` calls
what you send, so the paste has to be a thunk). Each snapshot it returns then runs to tens of
thousands of characters — it scales with the nodes captured, up to the default 90-node budget, so
there is no one figure for it — and one capture carries one snapshot per pair — three for the
tutorial's card — each crossing the agent's context twice: out of the browser, and back in as
`compare_node_to_dom`'s `pairs[].dom`. (The [tutorial](docs/design-qa-tutorial.md)'s printed snapshot
is trimmed to fit the page and is not a size reference.)

**Neither crossing is necessary, and [the recipe below](#your-first-verdict) does not make them.**
The extractor can reach the page over a loopback socket, and the snapshot can go to a file the
browser tool writes and this repository's client reads. Both cost tens of characters instead of tens
of thousands. What that does NOT change is the tool contract: `compare_node_to_dom` still takes
`pairs[].dom` inline and `suggest_pairs` still takes `dom_snapshot` inline, so the saving belongs to
the client standing between you and the tools. An agent driving the tools directly, or a different
client, still pays both costs in full.

### Your first verdict

[`examples/first-verdict.mjs`](examples/first-verdict.mjs) walks the
[design-QA cycle](docs/tools/design-qa.md#the-cycle) over stdio and installs nothing. It is honest
about the one step it cannot do: node has no browser, so it hands you two short thunks to paste
into whatever browser automation you have, and does everything on either side of that.

It is a script **in this repository**, so it belongs to the [from-source path](#from-source-instead)
above. If you registered framefit with `npx` and have no checkout, clone it for this walkthrough —
or skip straight to the [tutorial](docs/design-qa-tutorial.md), which drives the same cycle through
the tools themselves and needs no files of ours on your disk.

A Figma URL ends `?node-id=12-340`. The tools take `12:340`, with a **colon** — both spellings parse,
and this client rewrites the dash, so paste the id straight out of the address bar.

The clone fence above leaves you in `framefit/mcp-server`; this one runs from the repository root, so
it opens by going up one. (It used to open `cd framefit`, which exits 1 from both of the directories
this page actually produces — it worked only from the checkout's parent, where nothing puts you.)

```bash
# not-executed: contains-placeholder
cd ..
FIGMA_TOKEN=figd_your_token_here node examples/first-verdict.mjs serve-extractor \
  --file https://www.figma.com/design/AbCdEf012345/Product-Page --frame 12-340 \
  --pair '.card=12:340' --pair '.card__title=12:341' --pair '.card__price=12:344'
```

That prints the frame width, then holds the extractor on `127.0.0.1` at an ephemeral port and prints
the ~278-character thunk that fetches it. In the browser: size the viewport to that width, paste the
thunk into `evaluate_script` — it must return the `<length>:<hash>` line the command printed, and
anything else means what landed in the page is not the script this client was handed, so do not
measure it. Paste the second thunk to capture, and give your browser tool a **file** to write the
result to rather than returning it: chrome-devtools' `evaluate_script` takes a `filePath`. It
resolves a relative path against **its own workspace root** and refuses to write outside it — so do
not aim it at this checkout; give it a bare name and use the absolute path it echoes back. The
loopback server stops itself once the page has taken the extractor (it is needed exactly once), or
after `--timeout` seconds with nobody asking.

Feed that file back:

```bash
# not-executed: contains-placeholder
FIGMA_TOKEN=figd_your_token_here node examples/first-verdict.mjs verdict \
  --file https://www.figma.com/design/AbCdEf012345/Product-Page --frame 12-340 \
  --pair '.card=12:340' --pair '.card__title=12:341' --pair '.card__price=12:344' \
  --snapshots /the/absolute/path/evaluate_script/echoed/back.json
```

Measured end to end against a live Figma frame and a live page, one pair: **8655 characters** for the
whole cycle — the extractor crossing the agent zero times, the snapshot zero times. That is what the
loopback socket and the file are worth; the same run with both of them pasted through is about ten
times as much, and the snapshot half of it grows with every pair.

`prepare` is the same recipe with the extractor written to a file for you to paste **verbatim** —
58116 characters through your context. Keep it for a page whose CSP forbids the `eval` the fetch
thunk needs; there is no reason to reach for it otherwise.

Swap `AbCdEf012345`, the node ids and the selectors for your own; if your token already sits in
`mcp-server/.env`, run `node --env-file=mcp-server/.env examples/first-verdict.mjs …` instead of
setting it inline. You get a report, then `complete=false` and a `blocking` list. **That is the
usual first answer and it is the gate working**, not a failure: framefit will not call a page
verified while a region of the frame went unmeasured. Each blocking item names the action that
closes it (commonly `add_pair` for a region you did not pair) — do those, re-capture, run `verdict`
again. The exit code says the same: `0` green, `2` a verdict that is not green, `1` no verdict at all.

For cross-library design tokens, add `--env DS_TEAM_IDS=<team-id>,…` (comma-separated team ids or
`figma.com/team/<id>` URLs): the named teams' published libraries sync into an in-memory graph so
`get_variables` resolves those aliases headless (`resolved_via:"graph"`) — see
[`docs/tools/design-system.md`](docs/tools/design-system.md#get_variables). Unset, aliases stay
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
until one confirmed build lands the cadence is a minute, not a day.

> Published on npm as [`framefit`](https://www.npmjs.com/package/framefit), which replaces the
> clone-and-build step above with `claude mcp add framefit --env MCP_TRANSPORT=stdio -- npx -y
> framefit`. The transport flag is not optional: the server defaults to the HTTP transport, which
> is the shape the container deployments rely on. The clone-and-build path above stays documented
> and stays first here until the npx form has been run end to end by someone who is not its
> author; a quickstart is a promise about a stranger's ten minutes, and this one is not measured
> yet.

### Tier 2 — Docker (single-tenant or the production stack)

For a hosted HTTP server, or the production-shaped multi-tenant stack (MCP + Postgres against an
external Keycloak):

```bash
cd docker
docker compose --profile local up -d --build --wait   # single-tenant HTTP on 127.0.0.1:3846
curl -fsS http://127.0.0.1:${MCP_PORT:-3846}/health    # -> {"status":"ok","bind":{"address":"0.0.0.0","loopback":false}}
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
| **Comments & review** | `get_comments`, `summarize_comments`, `find_threads`, `post_comment`, `reply_to_comment`, `delete_comment`, `get_review_board`, `get_pin_detail` | [comments-review.md](docs/tools/comments-review.md) |
| **Design system** | `get_variables`, `search_design_system`, `get_libraries`, `get_code_connect_map`, `get_figjam` | [design-system.md](docs/tools/design-system.md) |

## Using with AI agents

The design-QA loop is packaged as a reusable agent skill:
[`docs/agents/design-qa-skill.md`](docs/agents/design-qa-skill.md). Copy it to
`.claude/skills/figma-design-qa/SKILL.md` in your project and the agent runs the verify-before-done
cycle automatically.

- [The cycle](docs/tools/design-qa.md#the-cycle) — the five steps, stated once. The server's MCP
  `instructions`, the skill and the tutorial all point at that list rather than paraphrasing it.
- [Design QA tutorial](docs/design-qa-tutorial.md) — the full cycle end to end (pairs → compare →
  verification receipt → fix plan → strictness profiles).
- [What the diff covers — honestly](docs/coverage.md) — the deterministic-vs-verify-by-eye table.

## Figma token

The server authenticates to Figma with a personal access token (`FIGMA_TOKEN`). Generate one in
Figma: **Settings → Security → Personal access tokens**, with the scopes for the tools you use:

- `file_content:read` — every file-reading tool: the design-QA loop, navigation, screenshots,
  asset export, and the review-board pair (`get_review_board`, `get_pin_detail`, which read pin
  text from nodes and never call the comments endpoint).
- `file_comments:read` — `get_comments`, `summarize_comments`, `find_threads`.
- `file_comments:write` — `post_comment`, `reply_to_comment`, `delete_comment`.
  `file_comments:read` is read-only and does not cover these; the server's own 403 names this
  scope. Those three tools are the only ones that take no per-call `figma_token`, so they always
  run on the server's token.
- `file_variables:read` — Enterprise only. `get_variables` fails outright without it;
  `get_design_context` reports the skipped stage in `degraded_stages`; `compare_node_to_dom`
  **degrades quietly**, and its token rows read `unknown`.
- `team_library_content:read` — `search_design_system`, which reads the published components,
  component sets and styles of a team. A 403 is diagnosed per team and re-thrown carrying Figma's
  own stated reason.
- `library_content:read` — `get_libraries` fails outright without it. Component identity in
  `get_layout_spec` / `suggest_pairs` / `compare_node_to_dom` / `get_view` **degrades quietly**
  instead, to a `setUnresolved` info row.
- `library_assets:read` — resolving a component key to the library file it came from. No caller
  raises: `get_code_connect_map` returns empty with `reason:"components_unresolved"`;
  `get_libraries` marks the result `degraded:true`; and `search_design_system`'s optional `file:`
  narrowing **degrades quietly** — with no library keys to narrow by it stops filtering
  altogether, still reporting `file` while returning the team's entire asset list.
- `projects:read` — the `DS_TEAM_IDS` variable-graph sync recommended above, where it **degrades
  quietly**: the sync logs and skips the team, so the advertised `resolved_via:"graph"` silently
  never happens. On the multi-tenant `/accounts` team-discovery path it raises instead.
- `current_user:read` — `framefit status`'s `figma` probe, which calls `GET /v1/me`.

The design-QA loop (`get_layout_spec` → `suggest_pairs` → `compare_node_to_dom`) needs
`file_content:read` and nothing else; each remaining scope unlocks the tools named beside it. Read
each entry for its failure mode: the ones marked **degrades quietly** return an incomplete answer
rather than an error, so a missing scope there looks like a result and not like a problem.

Per-scope necessity is unverified. The mapping above is derived from the endpoints this server
calls and from Figma's published scope table, not from minting one token per scope and observing
403 against 200. The failure modes were read from the code path that emits them, per scope; they
are not a closed list of everything a missing scope can affect.

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

- **Code Connect enrichment.** Figma exposes Code Connect through Dev Mode, the `figma connect`
  CLI and its own MCP tools — and the retrieval tool needs the *desktop* MCP server, because it
  reads the desktop app's local Code Connect database. There is still *no public REST endpoint*, so
  a headless server ingests CI-parsed mappings instead: your design-system CI runs
  `figma connect parse` and POSTs the JSON, and `get_design_context` / `get_code_connect_map` then
  enrich instances with code snippets.
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
# not-executed: long-running-process
cd mcp-server
pnpm install
cp .env.example .env      # fill FIGMA_TOKEN
pnpm dev                  # http://127.0.0.1:3846 - runs until you stop it
pnpm test                 # unit tests   (pnpm typecheck for types) - in a second shell
```

`pnpm dev` and `pnpm start` pass `--env-file-if-exists`, which needs Node **20.19** (or 22.9 on the
22.x line) — above the `"node": ">=20"` that `mcp-server/package.json` declares, and above the 20.6
that plain `--env-file` needs. Tier 1 above passes neither flag, so its Node 20+ prerequisite
stands; the [config examples](examples/mcp-config/) cover both and say which is which.

The server is hexagonal (domain / ports / application / adapters); `MCP_TRANSPORT` selects `http`
(Express + Streamable HTTP, for the docker/VPS deploy) or `stdio` (host-spawned, for local Claude
Code). [`mcp-server/.env.example`](mcp-server/.env.example) documents the full configuration
surface. Contributing a PR? See [CONTRIBUTING.md](CONTRIBUTING.md) for testing norms and repo
layout.

## Project status

Early `0.x` — the tool surface may still change between minor versions, and `0.x` is the honest
number: semver's promise about breaking changes is one this project cannot yet keep cheaply,
because nobody outside it has used the tool surface long enough to say what breaking it costs. The
verification layer is production-tested against one large design system; broader coverage is in
progress. Published on npm as [`framefit`](https://www.npmjs.com/package/framefit), MIT-licensed
(see [`LICENSE`](LICENSE)).
