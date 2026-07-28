# framefit status

`framefit status` answers one question: **is this instance able to do its job right now, and if not,
which part is broken?** It needs no prerequisites - it uses whatever happens to be configured and
honestly reports the rest as skipped, so it is the first thing to run on a box that is behaving
strangely, including a box whose server refuses to boot: a crash-looping container has no reachable
`/health`, and it is not running either, so `docker compose run` - not `exec` - is what still gets a
verdict out of the same image and the same service environment.

Three invocation forms:

```bash
# A source checkout. There is no `framefit` on PATH - the bin symlink exists only in the image
# (docker/Dockerfile:21) - so call the built entrypoint directly.
node dist/index.js status

# A deployed box whose container is RUNNING (compose service `framefit`, or `framefit-local` under
# the local profile).
docker compose exec framefit framefit status

# A deployed box whose container is NOT running - the crash-loop case this command exists for.
# Every compose service declares `restart: unless-stopped`, so a container that dies during boot
# sits in `Restarting`, and `exec` refuses outright:
#     Error response from daemon: Container <id> is restarting, wait until the container is running
# `run` starts a THROWAWAY container from the same image, carrying the same service environment
# (compose enables the service's own profile for `run`, so no --profile flag is needed). The image
# is CMD-only, so `framefit status` replaces the server command cleanly; `--rm` leaves nothing
# behind, and `run` publishes no host port, so it cannot collide with the looping container.
docker compose run --rm framefit framefit status
```

Flags:

| Flag | Effect |
|---|---|
| `--json` | Print one JSON document on stdout instead of the human table. Everything advisory stays on stderr, so stdout pipes straight into a parser. |
| `--probe` | Force the Figma network probe on. In multi-tenant that is one call per user. |
| `--no-probe` | Force it off. Single-tenant probes by DEFAULT (without it a stdio run says nothing about the token, which is the newcomer's actual question); multi-tenant does not. |

An unknown flag, a flag with a value, `--probe` together with `--no-probe`, or any positional argument
is a usage error (exit 2), never silently ignored: `--no-prob` accepted at exit 0 would PERFORM the
network call the operator asked to suppress.

## The three states

| State | Meaning |
|---|---|
| `ok` | The check ran and what it examined was healthy. Its `detail` carries the numbers behind that verdict. |
| `skipped` | A **precondition was absent**, so nothing was attempted. Not a pass and not a failure - there is simply no evidence either way. The `reason` names the missing precondition. |
| `fail` | Something **was** attempted and answered badly. That includes a timeout (10s per check): a dependency that never answers is a failure, never a skip. |

The distinction is the whole point of the command. A check that cannot examine anything must say so
rather than report a green line, and a check that got a bad answer must never soften it into "not
applicable".

## Exit codes

| Code | Meaning |
|---|---|
| `0` | No check failed. (Skipped checks do not fail the command.) |
| `1` | At least one check failed. |
| `2` | The command could not run: a usage error, an internal throw, or the 30s hard deadline. On the deadline path stdout still carries the PARTIAL report - the checks that did finish are the evidence narrowing down which dependency hangs - and `summary.complete` is `false`. |

So a cron wrapper can tell a typo (2) from an unhealthy instance (1).

## The checks

Six checks run in this order, sequentially - they share one connection pool, and the probe makes real
network calls.

### config

Whether this environment would BOOT, would boot as the MODE it claims, and would have the
CAPABILITIES it declares. Not every failure here aborts boot: some of them are misconfigurations the
server survives, and for those this check is the only place they ever surface.

- **ok**: `loadConfig` (the real zod schema) accepts the environment, and in multi-tenant
  `loadMultiTenantEnv` accepts it too. `detail` names the effective mode and which loaders ran.
- **fail, and boot aborts**: `DS_TEAM_IDS` and `MULTI_TENANT` set together (a hard boot guard, so the
  container restart-loops); `loadConfig` rejects a value (`LOG_LEVEL=verbose`, a broken limits
  relationship); in multi-tenant, a required variable missing or `ENCRYPTION_KEY` not 64 hex
  characters.
- **fail, and the server still boots**: `MULTI_TENANT` set while `MCP_TRANSPORT` is not `http` - it
  boots, but single-tenant with no auth layer, which is not the mode the environment claims;
  `DS_TEAM_IDS` set without `FIGMA_TOKEN` - it boots healthy and only logs
  `env_graph.disabled_no_token`, leaving cross-library aliases silently unresolved; an unparseable
  team id (the message names it - team ids are public identifiers and are deliberately not redacted).
- **skipped**: never. It needs nothing but the environment.

The `config` check answers questions about the environment's SHAPE. It cannot tell you that a
well-formed value is the value you meant: a `PUBLIC_BASE_URL` pointing at the wrong host parses fine
and reports `[OK]`.

`FIGMA_TOKEN` is optional by design in single-tenant: callers may pass a per-call `figma_token`, and
the stdio handshake needs no token at all.

### db

Whether the database is reachable and carries the schema this build expects.

- **ok**: users listed and their team registrations counted. `detail` reports `users` and
  `team_registrations` - a per-user SUM, deliberately not named `teams`, because `library_graph`
  reports the DISTINCT team count instead and the two measures need not agree.
- **fail**: any Postgres error, surfaced with its own text - a missing relation arrives naming the
  relation. Credentials in a driver message are masked; the host is kept, because the host is the
  diagnostic value.
- **skipped**: `DATABASE_URL` is not set, or it is set but no database handle reached status.

Caveat: with zero users, `listTeams` is never called, so exactly one relation is exercised. A missing
relation only the per-user query touches does not surface until a user exists.

### key

Whether `ENCRYPTION_KEY` is the key this data was written with.

- **ok**: the key signs a bridge token and verifies it back to the same subject; with a database, every
  user's default PAT decrypts. `detail` reports `decrypted: "k of n"`.
- **fail**: the key is not 64 hex characters; sign+verify does not round-trip (a wrong key surfaces as
  a bare `403` from the ingest endpoint, and that path is exactly the one a database-only check skips
  entirely); AES-GCM cannot authenticate the stored data for some users (they are named, alongside the
  key fingerprint); a stored PAT could not be read for any other reason (a dead pool is reported as a
  read failure, never blamed on the key).
- **skipped**: `ENCRYPTION_KEY` is not set.

Every user is checked, not a sample: after a key rotation a capped sample makes the verdict an
alphabetical accident. If no user has a default PAT, `detail` says the decrypt count proves nothing -
that is an absence of evidence, not a pass.

### tokens

Whether the stored Figma PATs are usable, and whether anything is still validating them.

- **ok**: at least one PAT stored, every token-holding user has a usable default, and in multi-tenant
  the nightly validation is recent. `detail` reports `stored`, `invalid_non_default`,
  `validated_age_sec` and the soonest default expiry.
- **fail**: a user has a registered Figma team but holds no PAT at all (multi-tenant only - single-
  tenant never populates that table); a user holds tokens but no DEFAULT one; a default PAT is invalid
  or expired; and in multi-tenant: validation has never run, last ran more than 48h ago, some token was
  never validated or is stale (the age is a MIN, which ignores nulls - this counts them), or a
  validation timestamp lies in the future, which means the database clock is skewed and every age above
  is untrustworthy.
- **skipped**: `DATABASE_URL` is not set, or no handle reached status, or nothing is registered yet.

"0 invalid" means nothing if the validator is dead, which is why validation freshness is itself a
failure condition. Nightly validation runs only inside the multi-tenant server process, so
single-tenant reports the age as not-checked rather than as a gap in the data.

`invalid_non_default` counts invalid tokens that are NOT their user's default, and it appears on the
failure line as well as on the ok one. Invalid DEFAULTS are already named, per user, in that failure
reason; counting them here too would read as a second, separate problem to go hunt.

### library_graph

Whether the per-user variable-library graph can resolve anything.

- **ok**: libraries are synced; or nothing is registered yet on a genuinely fresh install. Staleness is
  REPORTED, not judged - a design system that never changes is not broken - and so is a PARTIAL per-team
  gap, because a team can legitimately hold no variable libraries while the user still resolves through
  their other teams.
- **fail**: a user's registered teams yield zero libraries ACROSS ALL of them, so their token resolves
  nothing (the users are named, with the exact `framefit sync --user <id>` to run); or teams are
  registered and no libraries exist anywhere.
- **skipped**: single-tenant, always - that graph lives in the server process and this CLI cannot see
  it (`framefit graph check` REBUILDS it instead, which takes minutes on a large design system); or
  `DATABASE_URL` is not set; or no handle reached status.

### figma

Whether Figma itself accepts the credentials this instance holds. The only check that leaves the box.

- **ok**: single-tenant, `FIGMA_TOKEN` accepted (`detail` carries the account handle); multi-tenant,
  every probed stored PAT accepted (`detail` reports `accepted: "k of n"`).
- **fail**: Figma refused, reported with the HTTP status **and Figma's own reason when it gave a
  readable one** (`Figma refused the token (HTTP 403): Invalid token.`) - the status code alone
  cannot tell a revoked token from an expired or mistyped one, and in multi-tenant the reason is
  reported per user. A `429` is reported as a `429`, not translated into "rejected", and it does not
  get the token-expiry sentence: only `401` and `403` mean the credential itself was refused.
- **skipped**: the probe is off (the default in multi-tenant; `--no-probe` in single-tenant); no
  `FIGMA_TOKEN` in single-tenant - which is **not a verdict that the token is fine**, because on
  stdio the token lives in your MCP host's env block (`claude mcp add --env FIGMA_TOKEN=...`) and
  never in your shell, so a bare run of this command skips the one check you came for; re-run it
  with `FIGMA_TOKEN` set to the value your host passes. Or, in multi-tenant, no `DATABASE_URL`, no handle, no
  `ENCRYPTION_KEY`, no registered users, or no user with a default PAT to probe. That last case is a
  skip and not a green "0 of 0": nothing was called, so nothing was proven. The `tokens` check is where
  "nobody has a default" becomes a hard failure.

Multi-tenant makes one call per user, and those calls SHARE the single per-check budget, so one hanging
user cannot take the whole check down to a bare timeout and throw away the per-user attribution.

## The JSON contract (`--json`)

Exactly one JSON document on stdout. Fields:

- `schema` - integer contract version, currently `1`. It changes only for a breaking change.
- `generated_at` - ISO 8601 UTC timestamp of when the report was built.
- `version` - the framefit version, the same literal the MCP handshake reports
  (`src/infrastructure/version.ts`; the stdio smoke script cross-checks the two).
- `mode` - `{ multi_tenant, transport, transport_source, bind_host, bind_host_source }`: the
  EFFECTIVE mode, the raw `MCP_TRANSPORT` (`null` when unset), and `transport_source` = `"env"` or
  `"unset"`, because hosts set the transport per launch and "unset" is a different fact than any
  particular value.
  - `bind_host` / `bind_host_source` - the interface a server started from THIS environment would
    listen on (`BIND_HOST`, default `127.0.0.1`), and whether that came from the environment
    (`"env"`) or from the schema default (`"default"`). An empty `BIND_HOST=` counts as
    `"default"`, because the config preprocess turns it back into loopback. Derived, not observed:
    this command does not connect to a running server, so the field says which interface would be
    bound, not which one currently is.
- `scope` - `{ hostname, pid, env_source }`: which process answered. `env_source` is always
  `"process"`.
- `key_fingerprint` - the first 8 hex characters of sha256 over the DECODED `ENCRYPTION_KEY` bytes, or
  `null`. Two boxes can be compared for "same key?" without either revealing it; hex case and a
  trailing newline do not change it.
- `checks[]` - one object per check, in registry order: `{ id, state }` plus `reason` and/or
  `detail`, by state: an `ok` row always carries `detail` and never `reason`; a `skipped` row always
  carries `reason` and never `detail`; a `fail` row always carries `reason` and MAY carry `detail`
  too. Read both on a failure - a `figma` failure carries `detail.accepted` ("k of n" probes
  accepted) and a `tokens` failure over a bad default carries `detail.invalid_non_default`, so a
  consumer that reads only `reason` on failures drops the numbers behind them.
- `summary` - `{ total, ok, skipped, failed, complete, ok_overall }`.
  - `total`, `ok`, `skipped`, `failed` - counts over the checks that COMPLETED, which on the deadline
    path is fewer than the whole registry.
  - `complete` - `false` when fewer checks ran than the run asked for (the hard deadline fired), and
    also for a run over no checks at all. When it is `false`, the counts describe a subset and the human
    output says `INCOMPLETE` on its summary line.
  - `ok_overall` - the VERDICT, not a count: `complete` AND `failed === 0`. An aborted run never
    reached a verdict, so it can never claim one - a consumer reading only this field must never see
    "healthy" for a run that was cut short.

## Scope: what status can and cannot see

`status` reads the **process environment only**. It never loads a `.env` file - unlike `pnpm start`,
which passes `--env-file-if-exists=.env` (`mcp-server/package.json:23`). Under `docker compose exec` it
therefore sees exactly the service's environment, which is the environment the server itself booted
with. Under `docker compose run` it sees that environment as compose renders it NOW - from the compose
file, `env_file` and your shell - which is the right question to ask of a container that will not boot,
but it is not proof of what the looping container started with if the config changed since. In a shell
where you have only sourced a `.env` by hand, it sees whatever that shell exported and nothing more.

It also cannot see a **running server's memory**. The single-tenant variable graph is built in the
server process and held there for the life of that process, so a fresh `sync` is invisible to a running
server until it restarts, and this command cannot report on the graph that server is actually using.
What `status` reports is what THIS process sees with THIS environment and database - which is why it
prints that caveat on stderr on every run.

It does not migrate anything either: a diagnostic that changes the schema it inspects is not a
diagnostic. The pool it opens is read-only and always closed, under a bounded budget, so the command
stays bounded end to end.
