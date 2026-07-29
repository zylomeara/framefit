# Contributing to framefit

This is a headless Figma MCP server: read the Figma REST API without the desktop app, and verify
a rendered UI against its design with a deterministic metric diff. This doc covers dev setup, the
repo's testing norms, and how a PR gets merged.

## Dev setup

Node 20+ and [pnpm](https://pnpm.io/installation). Everything below runs from `mcp-server/`:

```bash
# not-executed: long-running-process
cd mcp-server
pnpm install
pnpm build       # tsc -> dist/
pnpm dev         # http server on 127.0.0.1:3846, watches src/ - runs until you stop it
pnpm test        # unit suite (excludes tests/e2e) - in a second shell
pnpm typecheck   # tsc --noEmit over src/ + tests/
```

`cp .env.example .env` and fill `FIGMA_TOKEN` to exercise the server against real Figma files
locally. `.env.example` documents the full config surface and is machine-checked against the
config schema, so an undocumented env var fails CI.

## Repo layout

- `mcp-server/` — the server, hexagonal: `src/domain` (pure logic, no I/O), `src/ports`
  (interfaces the domain depends on), `src/adapters/driving` (MCP tool registration, the inbound
  side), `src/adapters/driven` (Figma REST, Postgres, the outbound side), `src/application`
  (use-case orchestration between tools and domain), `src/infrastructure` (config, logging,
  transport wiring), `src/multi-tenant` (optional OAuth/Postgres tenancy layer). The
  multi-tenant server exposes an `/accounts` HTTP API; the admin portal UI that drives it in
  the author's deployment is not part of this repo.
- `docker/` — Dockerfile, compose profiles (`local` / `full`).
- `docs/` — `docs/tools/*.md` (per-tool reference, kept in sync with live registration, see
  below), `docs/coverage.md`, `docs/design-qa-tutorial.md`, `docs/agents/`.

## Testing norms

This repo does TDD, and treats a passing test as evidence only if it can also fail:

- Write the test first; watch it fail for the right reason before writing the fix.
- A new assertion that pins a bug fix or an edge case should be mutation-verified: revert the
  production change locally, confirm the new test goes red, then restore it. Commit messages in
  this repo's history reference this as "mutation-lock" — it is a review discipline, not an
  automated CI step.
- Never weaken an existing assertion to make a new change pass. If a behavior change makes an old
  assertion wrong, replace it with one that pins the new, correct behavior, and say so in the PR.
- Run the full suite before opening a PR, not just the files you touched: `pnpm test`.

### Test tiers

- **Unit** (`tests/unit/`) — no external dependencies, part of `pnpm test`.
- **Integration** (`tests/integration/`) — Postgres-gated: every file wraps its `describe` block in
  `describe.skipIf(!process.env.TEST_DATABASE_URL)`, so `pnpm test` skips them cleanly without a
  DB, and CI's `integration` job (which starts a `postgres:16` service) runs them for real. If
  you're changing `src/multi-tenant/`, set `TEST_DATABASE_URL` locally to exercise these.
- **E2E** (`tests/e2e/`) — hit the real Figma REST API. Excluded from `pnpm test`; run via
  `pnpm test:e2e` with `FIGMA_TOKEN_E2E` and `E2E_FILE_URL` set (see `.env.example`). Not part of
  CI — use them as your own sanity check against a live file.

### Doc sync

`docs/tools/*.md` must list exactly the tools the server registers. `tests/unit/docs-tools-sync.test.ts`
drives the real registration path with a recording stub and diffs the result against every
`### tool_name` heading in `docs/tools/*.md`, both directions. Add a tool and forget its doc
section (or vice versa) and this test fails. Add or rename a tool → add or update its
`### tool_name` section in the matching `docs/tools/` file.

### Honesty policy

The verification tooling (`compare_node_to_dom` and friends) never claims more than it measured. A
verdict is never softened to make output look cleaner, and any scope narrowing — skipped nodes,
unresolved tokens, capped depth — is surfaced in the response's machine-readable fields, not just
in prose. If your change touches diff logic, keep this invariant: a real finding stays red, and
things the code genuinely could not check are flagged, never silently passed.

## Opening a PR

- Keep it small and focused; include tests for the behavior you're adding or fixing.
- Describe what changed and *why* — intent stated up front makes review faster.
- CI must be green: unit + typecheck, Postgres-gated integration, the `stdio-smoke` matrix
  (3 OSes × Node 20/22), and the gitleaks secrets scan. See `.github/workflows/ci.yml`.

## Licensing

The project is MIT-licensed (see `LICENSE`). By contributing you agree that your contributions
are licensed under the same MIT license. No CLA, no per-file license headers.

## Maintainers

The license is pinned in three places that must stay in lock-step: the `LICENSE` file at the
repo root, `package.json`'s `"license"` field, and the assertion in
`tests/unit/publication-metadata.test.ts` (the machine gate on package metadata). If the license
ever changes, move all three in one commit.
