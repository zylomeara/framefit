# Variable-snapshot ingest — an open contract

## When you actually need this

On a very large design-system file `GET /v1/files/:key/variables/local` can answer
`400 Request too large`. That failure is **intermittent, not permanent**: it is Figma's ~55s
server-side job limit for the endpoint, so it is load-dependent. The remedies, in order — the same
order the shipped error hint gives you
(see `mcp-server/src/adapters/driving/tools/get-variables-tool.ts`, `This is intermittent (load-dependent), so retry first`):

1. **Retry.** It often succeeds on the next attempt. Do this first.
2. **Split the design-system file** into smaller files if it keeps failing. The endpoint has no
   filtering and `node_id` scoping still fetches the whole file, so nothing client-side shrinks the
   job.
3. **Raising `timeout_ms` does not help.** This is Figma's job limit, not a client timeout. (A
   *timeout* error is a different failure and does respond to a higher `timeout_ms`.)

The snapshot is the **last resort**, for when retry and splitting are not available to you — for
example the library belongs to another team and you cannot restructure it.

**What the snapshot rescues, precisely:** the keys a **consuming** file aliases **from a library**
whose variables REST cannot serve. Without those values `framefit sync` cannot build the graph edge
for that library, so every alias into it stays `value:null, alias:true`. The snapshot supplies the
values so the consuming file's tokens resolve.

**What it does not do:** it does **not** make a too-large file's own `get_variables` succeed. That
call fetches *that* file's variables and will still error — the snapshot is never consulted as a
substitute for reading the file you asked about.

Anything that *can* read the values (a Figma plugin running in the editor, where a
`Variable`'s `resolveForConsumer(node)` is available) uploads them to the server once. Resolution order
is always graph-first, snapshot as fallback.

This page documents the upload contract so **you can bring your own uploader**. The author's own
Dev-Mode plugin is part of their private deployment and is not in this repository — but nothing about
the server side is private: the endpoint, the auth, and the body shape are all here, and any client
that can produce the values may use them.

> **Multi-tenant only.** Snapshots are stored per user, so the endpoint exists only when the server
> runs with `MULTI_TENANT=true`. Single-tenant/stdio deployments resolve cross-library tokens through
> the in-memory graph (`DS_TEAM_IDS`) instead — see [deployment](deployment.md).

## 1. Mint an upload token

Uploads are authenticated by a short-lived token scoped to `variables:snapshot` — deliberately not a
full OAuth JWT, which would over-scope to the whole `/mcp` + `/accounts` surface. It is signed with
the server's `ENCRYPTION_KEY`, so it can be minted offline by the operator CLI:

```bash
# The token is the only thing on stdout — capture it in a shell variable, never in the checkout:
TOKEN=$(framefit bridge-token --user <keycloak-user-id>)            # 30-minute default
# in docker:
TOKEN=$(docker compose exec -T framefit framefit bridge-token --user <keycloak-user-id>)
```

Scope, expiry and caveats go to stderr, so the token pipes cleanly. `framefit users` lists the user
ids that have a registered PAT — **cross-check the id before you mint**, see §3. The server exposes
the same capability over HTTP at `POST /accounts/bridge-token` (OAuth-authenticated) if you prefer
that route.

Two properties worth internalising before you reach for `--ttl`:

- **A bridge-token cannot be revoked.** There is no revocation list; the only ways it stops working
  are expiry and rotating `ENCRYPTION_KEY` — and rotating that key also invalidates **every stored
  PAT**, so all users must re-register. Treat rotation as an incident, not a control.
- Therefore **keep the 30-minute default and mint on demand** instead of raising `--ttl` (the cap is
  24h). A long-lived token is a long-lived, unrevocable credential.
- **Do not redirect the token into a file inside the repository** (`> token.txt`). Pipe it into the
  upload, or write it outside the checkout. `token*.txt` is in `.gitignore` as belt and braces, not
  as permission.

## 2. Upload the entries

```
POST <base>/api/variables/snapshot
Authorization: Bearer <token>
Content-Type: application/json

{
  "library_file_key": "<the file key the variables are published from>",
  "entries": [
    { "key": "<40-hex published variable key>", "value": "#f6f6f9", "resolved_type": "COLOR", "name": "bg/level 1" },
    { "key": "<40-hex published variable key>", "value": "16",      "resolved_type": "FLOAT", "name": "space/md" }
  ]
}
```

Field notes, exactly as the server treats them:

| Field | Required | Handling |
|---|---|---|
| `library_file_key` | yes | non-empty string; the snapshot replaces any previous snapshot for this (user, library) pair |
| `entries` | yes | must be an **array** — absent or non-array is a `400`, never an empty upload |
| `entries[].key` | yes | the **published** variable key (the 40-hex `key`, not the file-local `VariableID:…`); lower-cased on store, so case does not matter |
| `entries[].value` | yes | coerced to string — colors as hex (`#rrggbb`), numbers as digits; `null`/absent entries are dropped |
| `entries[].resolved_type` | no | `COLOR` / `FLOAT` / `STRING` / `BOOLEAN`; defaults to empty |
| `entries[].name` | no | human-readable token name, surfaced in tool output |

Individual malformed entries are skipped rather than failing the whole upload — **as long as at least
one entry is valid**:

```
200 {"stored": 1, "received": 2}
```

`received` counts what you sent, `stored` what survived validation — a gap between them means some
entries were dropped (missing `key`, or a null/absent `value`).

### Status codes

| Code | Meaning |
|---|---|
| `200 {stored, received}` | replaced the snapshot for this (user, library). |
| `400` | bad body: `library_file_key` missing or blank, **or** `entries` absent / not an array. Nothing is written. |
| `401` | no `Authorization: Bearer` header. |
| `403` | invalid, expired, or wrong-scope token — **or a token minted with a different `ENCRYPTION_KEY` than the server runs**. The 403 body cannot tell those apart, so check the key first if the token looks fresh. |
| `422` | every entry was malformed. The upload is **refused** and the stored snapshot is left untouched. (Partial skipping applies only when at least one entry is valid.) |

An explicit `"entries": []` is a **legal destructive request**: it clears the snapshot for that
(user, library) pair. That is the only supported way to remove a snapshot, and it is why an absent or
non-array `entries` is rejected with `400` instead of being treated as an empty list.

### Bringing your own uploader

**Server-side clients are the straightforward case** (curl, a CI job, a Node script): CORS is
enforced by browsers, not by the server, so nothing stands in your way.

**From a browser, mind the CORS headers.** The route answers the `OPTIONS` preflight with `204` and
sets exactly:

```
Access-Control-Allow-Origin: https://www.figma.com
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: authorization, content-type
```

Any browser origin other than that one is blocked. Note that a Figma plugin UI runs in a sandboxed
iframe that may send `Origin: null` rather than `https://www.figma.com` — if you build a browser-side
uploader, check what origin your client actually sends and adjust the header in
`mcp-server/src/multi-tenant/variable-snapshot-ingest.ts` to match your deployment.

```bash
curl -sS --fail-with-body -X POST "$BASE/api/variables/snapshot" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @entries.json
```

## 3. Verify it took effect

`get_variables` is the tool that shows provenance — use it to confirm the upload:

```
get_variables { file: "<consuming file>", node_id: "<node>" }
```

The summary header counts buckets: `resolved_via: {local, graph, snapshot}`. Keys served from your
upload carry `resolved_via: "snapshot"` and land in the `snapshot` bucket.

The other two consumers mark it differently — do not expect `resolved_via` from them:

| Tool | Marker on a snapshot-resolved value |
|---|---|
| `get_variables` | `resolved_via: "snapshot"` on the row + the `snapshot` summary bucket |
| `compare_node_to_dom` | `snapshot_default: true`, `defaultHex`, `effectiveHex: null`, and `effectiveModeSource: "unverifiable"` (mode-blind: the upload has no ancestor-mode context) |
| `get_design_context` | the resolved value, with **no** provenance marker |

`compare_node_to_dom` also consults the snapshot **only** when it could not read the consuming file's
own variables at all (the prefetch is gated on `variableIndex === undefined`), and then only for the
keys the graph missed. Both halves of that gate are load-bearing: the graph is mode-aware and the
snapshot is not, so the snapshot must never shadow a key the graph can answer.

If your tokens still come back unresolved, in order of likelihood:

1. **Wrong `--user` id.** Snapshots are keyed by the signed user id and nothing checks that the id
   exists — a typo mints a perfectly valid token, the upload answers `200`, and nothing ever
   resolves, because the tools look under *your* id. Cross-check with `framefit users` and re-upload
   under the right id. To clean up the wrong one you must re-mint a token **for that same wrong id**
   and POST `"entries": []` to it.
2. **Published key vs `VariableID`.** `value:null, alias:true` means the key in your entries does not
   match the alias the consuming file references — upload the **published** 40-hex key, not the
   library-local `VariableID:…`.
3. **Wrong `library_file_key`.** Lookup is by (user, variable key) alone, so a wrong
   `library_file_key` still *resolves* — but it is the grouping the full replace deletes by, so your
   next upload under the correct key will not clear those rows and the stale values keep winning
   whenever they are newer. Clear the wrong grouping with `"entries": []` under that same key.

## Honest limitations

- A snapshot carries **one value per key** — the default mode. It cannot answer "what is this token
  under mode X"; that is what the graph does (`modes` / `mode_dependent` in `get_variables`). Use the
  graph when REST can read the library, and the snapshot only for libraries it cannot.
- Snapshots do not expire on their own. Re-upload after the library changes, or the values go stale
  silently — the server has no way to notice.
- Nothing validates that a value is *true*; the server trusts the uploader. Garbage in, garbage
  resolved.
