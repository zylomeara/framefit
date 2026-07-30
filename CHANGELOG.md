# Changelog

This file starts at 0.13.0. Versions are the `framefit` package version, which is also what the MCP
handshake reports as `serverInfo.version` and what `framefit status` prints in its header.

## 0.13.0

This release closes a set of defects that made the server unsafe or dishonest to run outside the
machine that built it. Several of them change behaviour you may be relying on.

Read the Breaking section in order. It is arranged the way you will meet it: the server has to be
reachable before a client can connect, a client has to connect before it can call a tool, and a
tool has to run before its output matters.

### Breaking

**1. The HTTP transport binds `127.0.0.1` by default. New setting: `BIND_HOST`.**

It previously bound every interface. The single-tenant server has no authentication of its own and
wires your `FIGMA_TOKEN` into every call, so an unset value must not mean "reachable from the
network".

- Running under Docker or compose: nothing to do. The image sets `BIND_HOST=0.0.0.0`, and the
  compose port mapping is what keeps it on the host's loopback.
- Running `node dist/index.js` or `npx framefit` on a box you reach from another host: set
  `BIND_HOST` explicitly, and put authentication in front of it.
- Loopback here is IPv4-only. A client configured with `http://localhost:PORT` may resolve `::1`
  first and fail to connect. Point the client at `127.0.0.1`. Setting `BIND_HOST=::1` is not the
  same fix - one listen cannot be both loopback-only and dual-stack, so it only swaps which clients
  break, and inside the container it produces a permanently unhealthy box (see item 2).
- `BIND_HOST` is validated at startup: an IP literal or `localhost`. It is the interface to bind,
  not the public hostname you advertise - that is `MCP_HOST`, and passing one for the other used to
  surface as an `EADDRNOTAVAIL` restart loop.

**2. `GET /health` gained a `bind` block, and the image healthcheck now requires it.**

The payload is now `{"status":"ok","bind":{"address":"<canonical>","loopback":<bool>}}` on both the
single-tenant and multi-tenant servers. The container healthcheck reads it and passes only on
`"loopback":false`, because a container bound to its own loopback has a dead published port and
nothing inside the container can observe host-side port publication.

- If you set `BIND_HOST` to a loopback address for the container (including through a copied
  `mcp-server/.env`, whose `env_file` beats the image's own `ENV`), the container is now
  permanently unhealthy instead of quietly serving nothing. The shipped `.env.example` keeps the
  line commented out for exactly this reason.
- The check is fail-closed: a server that does not report the field is unhealthy, not healthy.
- If you parse `/health` strictly, it has one more key than before.
- Known false alarm, accepted: under `network_mode: host` a loopback bind is correct and reachable,
  and this check still fails it. Neither compose profile here uses host networking.

**3. `Caddyfile.example` now requires a credential.**

The shipped example had no `basic_auth` at all, so an operator who followed the "front it with
Caddy" instructions got an open proxy to their Figma account. If you re-copy the example you must
create a credential (`caddy hash-password`) or every request, including a `/health` monitor, gets
401.

- `/api/dom-snapshots/*` is the one route deliberately left anonymous. The page being measured
  loads the extractor cross-origin and cannot carry basic-auth credentials; its credential is the
  per-call capability token in the URL path. That route is also excluded from the access log, since
  Caddy logs `request.uri` verbatim and the token lives in the path.
- `encode gzip` is gone: the MCP route answers `text/event-stream` and gzip buffers it.
- The body cap on the exempted route is `2MiB`, not `2MB`. Caddy reads `2MB` as 2,000,000 bytes
  while the server's limit is 2,097,152, and an upload between the two returned an opaque 413 with
  no CORS header at the edge.
- That exempted prefix has no rate limit and cannot get one in this file: rate limiting is a
  third-party Caddy plugin, not part of the official build. Use an xcaddy rebuild or a firewall
  rule if you need one.

**4. `/mcp` refuses a request carrying an unrecognised browser `Origin`. New setting:
`ALLOWED_ORIGINS`.**

A loopback bind is exactly the deployment DNS rebinding targets: a page on any domain that resolves
to 127.0.0.1 reached the socket same-origin and could call tools under your `FIGMA_TOKEN`. Requests
with no `Origin` header - every ordinary, non-browser MCP client - are unaffected.

The server always admits its own advertised origins: the bind host at the bound port,
`PUBLIC_BASE_URL`, `https://MCP_HOST` in multi-tenant, and `localhost` at that port - but the
`localhost` alias only when the bind is IPv4 loopback or a wildcard, since that is when the two
name the same endpoint. Bind a LAN address or `::1` and `http://localhost:PORT` is foreign like
any other origin.

`ALLOWED_ORIGINS` is a comma-separated escape hatch so the gate can never become an unopenable
door. Read its name narrowly: it stops this guard from refusing an origin and does nothing else.
Cross-origin browser use of `/mcp` still does not work whatever you list, because nothing sets
CORS response headers on `/mcp` and the transport answers `OPTIONS` with 405.

**5. `resolve_comment` is now `delete_comment`.**

Figma exposes no endpoint that marks a comment thread resolved. The call has always issued
`DELETE /v1/files/:key/comments/:id`, while the description an agent read said it "marks it
resolved; it stays visible in the file". Update any agent prompt, skill or client config that names
the old tool - there is no deprecated alias, because a second name for a permanently destructive
operation doubles the ways an agent can reach it while halving the chance it reads the honest
description.

The new description says what the call does: the deletion is permanent and is not undone by file
version history, it is not a way to resolve a thread, and only the comment's author may delete one.
It deliberately says nothing about what deleting a thread root does to its replies: Figma's
reference documents the author-only rule and no cascade, and the only experiment that would settle
it destroys real comments.

**6. The structured log surface changed: one field's value changed, one field added, five new
events.**

`use_case.start` and `tool.error` lines now carry `tool: "delete_comment"`. A log query, alert or
dashboard pinned to `resolve_comment` matches nothing.

Two more things an operator parsing these lines will see. `server.listening` gained `bind_host`,
carrying the address the socket actually bound (see item 1). And five events are new. Three of them
are `info`, one per tool that now degrades instead of failing when a render is unavailable:
`review_board.screenshots_unavailable`, `get_screenshot.tiles_unavailable` and
`get_pin_detail.full_res_unavailable`. They fire on calls that used to either fail outright or succeed
silently.

The other two are refusals, one for each refusal this release adds. `mcp.origin_rejected` (`warn`,
item 4) is one line per request turned away for its `Origin`, carrying that origin truncated to 64
characters plus `origin_truncated`. `dom_snapshot.upload_rejected` (`info`, item 8) is one line per
404 on an unknown or expired capability token, carrying `capTokenPrefix` and the client's declared
`content-length` - which is a claim rather than a measurement, since that path deliberately never
reads the body. Both fire on paths that logged nothing at all before.

**7. `FRAMEFIT_READ_ONLY` now actually refuses writes on the single-tenant and stdio paths.**

The flag, and the "Disabled in read-only mode" sentence in three tool descriptions, were previously
false outside multi-tenant: nothing wired a gate, so every write went through. If you set this
variable and observed writes working, they will now be refused.

- Only the exact value `true` (any case) enables it. Unset or unrecognised leaves writes enabled,
  which is the previous behaviour for everyone else. A typo does not crash the server.
- The refusal now names the remediation for the mode you are in: multi-tenant points at the portal,
  single-tenant names the environment variable. Multi-tenant is unchanged - there read-only is
  per-user and lives in the database, and this variable is ignored.
- The compose local profile forwards the variable; the multi-tenant service does not.

**8. `POST /api/dom-snapshots/:capToken` answers 404 for an unknown or expired token before it
reads the body.**

The token check moved above the body parser. A request against a bad token that also had a
malformed body, a schema-invalid body, or a body over the 2mb limit previously won with 400, 422 or
413; it is now 404 in every case. The limit itself is unchanged for anyone holding a live token.

Two smaller changes on the same endpoint, for anyone matching on its responses. Under a LIVE token,
a body that is both over the per-POST snapshot count and schema-invalid now answers **413, where it
used to answer 422**: the count cap moved ahead of the per-element validation, so the array is
refused by count rather than by 50,000 schema failures. And the 404 body text is now
`upload token expired or unknown - re-run get_layout_spec`, with an ASCII hyphen where it used to
carry an em dash.

It is also a large latency and memory saving on a rejected upload. A 400KB body of 50,000 objects
against a bad token used to cost about 0.55s over HTTP and answer with a 2.1MB array of per-element
complaints. A 2MB probe now costs about 1.4ms and 68 bytes, flat in body size.

**9. Every Figma error message was rewritten to quote the reason Figma gave.**

Errors are now classified from the response body rather than from the status code, and Figma's own
`err`/`message` string is quoted back, bounded to 120 characters and stripped of anything outside
printable ASCII. If you match on the text of these messages, all of them changed.

The behaviour change under it: a dead token is no longer diagnosed as a plan or permission problem.
`get_variables` used to answer every 403 with "The Variables REST API requires an Enterprise plan"
and every 400 with advice to split the design-system file; both are now gated on what Figma
actually said. `search_design_system` carried the same defect and carries the same reason now.

**10. One error CLASS moved, which changes the `[kind]` prefix and the `error_kind` log field.**

Separate from item 9, and easier to miss because it is not text: every tool result for a failed
Figma call is prefixed `[<kind>]`, and every `tool.error` log line carries the same value as
`error_kind`. One class of 403 changed which kind it gets.

A 403 is now classified from Figma's own parsed reason. Previously the word "scope" appearing
ANYWHERE in the response body - including in an HTML error page this server did not write, or in a
field next to a reason that names something else - produced kind `auth`. It now produces
`forbidden`, the frozen default for a 403, unless the reason Figma actually gave names a scope.
The same applies to a reason naming both an account-type limit and a scope: plan outranks scope,
so that is `forbidden` too.

Nothing Figma really sends moved: measured over a 476-case matrix - 17 bodies x 7 statuses x 4 call
shapes - the 16 cases that changed are all bodies Figma does not produce. But if you alert on `error_kind: "auth"`, or branch on the
`[auth]` prefix, those cases now arrive as `forbidden`. The point of the change is that an
intermediary can no longer choose the kind by writing one word into a body.

**11. `framefit status` reports and checks the bind interface, and its skipped Figma check no
longer reads as a pass.**

- The report JSON gained `mode.bind_host` and `mode.bind_host_source`; the human header prints
  `bind: 127.0.0.1 (default)`; the single-tenant `config` line carries the bind too.
- The `config` check now fails on a `BIND_HOST` that is not an IP literal or `localhost` (it runs
  the real config loader, so it fails wherever the server would fail to boot).
- The `figma` check's skipped text changed. It used to read as reassurance in a run that exits 0.
  It now says it is not a verdict about the token, and that on stdio the token lives in your MCP
  host's env block rather than your shell.
- A failing token probe prints Figma's own reason next to the HTTP status, per user in
  multi-tenant.

**12. Every tool description was rewritten to ASCII.**

`tools/list` delivers all of it to every client and a model reads it. 17 of the 26 descriptions and
38 input-schema field descriptions carried non-ASCII characters. Typographic characters were
substituted, not deleted. Two tools carried Russian example values and now carry English ones that
teach the same thing: `find_nodes` and `get_review_board`. `compare_node_to_dom` no longer carries
an emoji in instructions an agent acts on. Five field descriptions that quoted the Cyrillic halves
of the default review-board and `find_threads` name patterns now describe the default instead - the
patterns themselves are behaviour, are correct, and are unchanged.

**13. The DOM snapshot schema is v6. Snapshots captured with an older extractor are refused.**

Re-fetch the script (`get_layout_spec {include_extractor:true}`) and re-capture. A `schema: 5`
snapshot now gets a `snapshot_schema` warn row and a `re_extract_dom` blocking item from
`compare_node_to_dom`, and a hard error from `suggest_pairs`. Cached `snapshot_ref`s taken before
the upgrade are equally stale.

The version had to move because the change is not additive - it redefines an existing field.
`styles.borderRadius` now means "all four CSS corners are this ONE px number", which is the only
shape Figma's single px `cornerRadius` can be compared against. Any other radius omits the field and
sets `styles.borderRadiusUncomparable: true` instead: corners that differ, a percentage, or an
elliptical `8px / 4px`.

Older extractors emitted a plain number for all of them - `borderRadius: 8` for
`border-radius: 8px 0 0 0`, `50` for `border-radius: 50%` - with no flag at all, so on the wire their
output is indistinguishable from a genuinely uniform 8px or 50px and the server has no way to tell
the two apart. Each of those passed a matching Figma `cornerRadius`. Without the version bump the
`corner-radius` row would have kept passing over an unmeasured difference on every stale capture -
the same defect this release removes from the code, displaced onto the wire. Same reasoning as the
v4 bump, where old extractors truncated text without flagging it.

### Added

- **MCP tool annotations on all 26 registrations.** `readOnlyHint` on the 23 reads;
  `readOnlyHint: false, destructiveHint: false` on `post_comment` and `reply_to_comment`;
  `readOnlyHint: false, destructiveHint: true` on `delete_comment`. These are disclosures for hosts
  that surface them. The spec tells clients to treat annotations as untrusted, nothing in this
  server reads them, and the only enforcement here is the read-only gate above.
- **The image declares how it is invoked** (`FRAMEFIT_INVOCATION=docker`), so a diagnosis printed
  from inside a container names the `docker compose exec` form a reader on the host can paste, not
  only the in-container path. Outside the image the command is derived from `argv[1]`.
- **`ENFORCE_AUDIENCE` is documented for what it is** (multi-tenant only): off by default, and off
  in the shipped examples, because hard enforcement needs a Keycloak audience mapper that stamps a
  framefit-scoped `aud` on portal tokens. Until that mapper exists, any valid token from the same
  realm is accepted on `/accounts` - the API that manages Figma PATs, CI keys and bridge tokens.
  `/mcp` stays soft regardless, because dynamic-client tokens carry an `azp` this server cannot
  predict.

### Fixed

- **`get_screenshot` and `export_assets` surface render failures.** `GET /v1/images` reports them
  inside a 200 body, and that field was dropped, so the tools returned an empty image set with no
  reason at all. Where the render is only an enrichment of an otherwise complete answer
  (`get_review_board`, `get_screenshot` with tiles, `get_pin_detail`'s full-resolution URL), the
  answer still arrives and carries the reason instead of failing the call. Those three results
  gained a key to carry it: `warnings` (already present, now also fed by render failures),
  `children_map_note` and `full_res_url_note`.
- **`search_design_system`'s `skipped_teams` is ordered by input, not by completion.** The team
  requests run concurrently and the array used to be appended in whatever order they settled, so a
  positional join against your own team list was unreliable - and silently so, since with one slow
  team it was usually right. Each failure is now recorded at its own index and the array is
  compacted before it is returned, so it carries only the teams that failed, in the order the
  teams were searched. That order is not necessarily your array: the searched list is your ids
  deduplicated and capped at the first 5, and if you passed no `team_id` at all it is your
  registered teams, which you never passed. So a positional join still does not work - the entry
  at position `n` is the `n`th team that FAILED. Read `team_id` off each entry.
- **A repeated failure is no longer diagnosed differently from the first one.** The negative cache
  dropped the upstream reason on the way in and out, so a cached 400 lost the quote and fell back
  to generic advice.
- **A 429 with no `Retry-After` header** rendered as "Retry-After: unknowns." and would have told
  you to wait an unknown amount of time.
- **The extractor loader and upload URL follow the bind.** With `BIND_HOST` set to a LAN address,
  the browser-facing base is that address rather than the browser machine's own loopback. A
  wildcard bind still advertises loopback, which is the only dialable thing it means.
- **Both documented `npx -y framefit` one-liners now set `MCP_TRANSPORT=stdio`.** The server
  defaults to the HTTP transport, so the documented line used to boot an HTTP server the MCP host
  never spoke to.
- **`get_variables` and `search_design_system` now end a refusal at a command you can actually
  run.** Every branch of their 403 diagnosis used to end in Figma's web UI and at nothing runnable
  against this instance. Both now append a `framefit status` line derived from how this process was
  started - a source checkout, an installed bin, or a container - together with the caveat that
  makes it answerable in the mode you are in: which credential that run would probe, and whether it
  would probe one at all. This is a change to those two tool errors only; what `status` itself
  prints changed for its own reasons, in item 11 above.
