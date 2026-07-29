# Design system tools

Design tokens (Figma variables), published libraries, Code Connect mappings, and FigJam boards.

---

### get_variables

List design tokens (Figma variables) in a file: name, type, default-mode value (colors as hex),
and collection. Pass `node_id` to return ONLY the variables a node subtree references (the
headless analogue of `get_variable_defs`) instead of the whole-file catalog.

Returns a summary header (`total`, `resolved_via` buckets `{local,graph,snapshot}`, `unresolved`
count, `by_type` counts) plus optional filters (`collection`, `name`, `type`, `unresolved_only`)
and pagination (`limit`/`offset`). Duplicate rows are deduped and case-variant collection names
are unified.

Aliases within the file are resolved. Cross-library aliases are resolved headless via the
registered library graph: when the source library's team is registered, the token returns
`value:<hex>`, `resolved_via:"graph"`, and `source_library` (the source file key). Otherwise it
stays honest - `value:null`, `alias:true`, `alias_of:<VariableID>` - meaning that library's team
is not registered yet (register it to resolve).

**How the graph gets built.** The cross-library graph exists in two deployment shapes. In
single-tenant/stdio it is built in-memory from the teams named in the `DS_TEAM_IDS` env var
(comma-separated team ids or `figma.com/team/<id>` URLs; see the
[`.env` reference](../../mcp-server/.env.example) and the [deployment guide](../deployment.md)). In
multi-tenant it is built per user from the teams each user registers - via the bundled `framefit`
operator CLI (`framefit teams add` then `framefit sync`) or the `/accounts` portal API (see
[docker/README](../../docker/README.md)). In multi-tenant an uploaded per-user snapshot is the
fallback when the graph can't resolve a key (`resolved_via:"snapshot"`) - the rescue path for
libraries whose variables the REST API refuses to serve at all; its upload contract is open and
documented in [snapshot-ingest](../snapshot-ingest.md) (bring your own uploader). Single-tenant has
the graph only.

Access to the Variables REST API depends on the file's Figma plan, on the token being valid, and on
the token carrying `file_variables:read` - a 403 here is one of several causes, and the error
message quotes Figma's own reason. Raise `timeout_ms` on large files.
Multi-mode tokens (collections with >1 mode) carry `mode_dependent:true` and
`modes:{<modeName>:<hex>}` - `value` is the DEFAULT mode; do not treat it as the on-screen value
without checking the node's mode (see
[`get_design_context`](navigation.md#get_design_context)).

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key |
| `node_id` | string | When set, return ONLY the variables referenced by this node subtree (the headless analogue of `get_variable_defs`). Omit for the whole-file token catalog. |
| `depth` | integer 1–8 (default 4) | Subtree depth scanned for variable references (`node_id` mode only). |
| `timeout_ms` | integer 1000–120000 | Per-call Figma request timeout in ms (default 90000). The variables endpoint can be slow on large files. |
| `collection` | string | Filter tokens by collection name (case-insensitive substring match). |
| `name` | string | Filter tokens by name (case-insensitive substring match). |
| `type` | string | Filter tokens by resolved type (case-insensitive exact match, e.g. `COLOR`, `FLOAT`, `STRING`, `BOOLEAN`). |
| `unresolved_only` | boolean (default `false`) | Return only tokens whose cross-library alias could not be resolved (`value:null`, `alias:true`). Useful to identify which teams need to be registered. |
| `limit` | integer 1–1000 (default 200) | Maximum number of tokens to return. |
| `offset` | integer ≥ 0 (default 0) | Number of tokens to skip for pagination. |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "node_id": "12:340",
  "type": "COLOR"
}
```

---

### search_design_system

Search published design-system libraries (components, component sets, styles) by
name/description. `team_id` is required on the stdio and single-tenant servers; only the
multi-tenant server can omit it, and there it falls back to the design-system teams you
registered. Pass a `file` to narrow results to the libraries that file consumes. Returns matches
with key, kind, library file, node_id, page and source team_id - use `node_id` with
[`get_design_context`](navigation.md#get_design_context). Lexical name search; run short queries.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `team_id` | string | Figma team id OR a team URL (id is extracted). Optional only on the multi-tenant server, which falls back to the design-system teams you registered there; on stdio and single-tenant it is required. |
| `query` | string, **required** | Search terms; spaces = AND. Matches component/style name, description, page. Lexical, not semantic - try short fragments ("button", "space", "toast"). |
| `file` | string | Figma file URL/key - narrows results to the libraries this file actually consumes (does not add teams). |
| `limit` | integer 1–50 (default 15) | Max matches |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "team_id": "1234567890123456789",
  "query": "button primary",
  "limit": 10
}
```

Omitting `team_id` is the multi-tenant fallback: it searches the design-system teams that user
registered. On the stdio server the quickstart installs, and on single-tenant, the same call fails
with `team_id is required. Pass a Figma team id or a team URL`.

**Example** (multi-tenant only)

```json
{
  "query": "button primary",
  "limit": 10
}
```

---

### get_libraries

List the design-system libraries a Figma file publishes or consumes. `"publishes"` = components this
file itself exports (`GET /files/:key/components`). `"consumes"` = external libraries the file
actually uses, detected from remote component references resolved to their source files (grouped
by library file key with `component_count` + sample names). Best-effort: it surfaces libraries
with USED components, not merely-subscribed-but-unused ones. Use a library file key with
`get_design_context`; for `search_design_system` pass the team id from the library file's URL.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key whose libraries to list |
| `node_id` | string | Scope the consumed-library scan to this node's subtree (bounds REST cost on huge files); omit to scan the whole file |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page"
}
```

---

### get_code_connect_map

Map Figma instance nodes to their Code Connect code snippets (component, imports, source) from
mappings your CI uploaded (Figma exposes no Code Connect REST endpoint, so this reads CI-ingested
mappings, not Figma directly). When the map is empty the response carries a `reason`
(`no_instances` | `components_unresolved` | `no_mappings` | `not_configured`) and a `note`
explaining why and how to populate mappings.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key |
| `node_ids` | string[], **required** | Instance node ids - top-level (`"1:42"`) or nested (`"I12:340;56:7890"`, copied from `get_metadata`/`get_review_board`). Resolved shallowly (depth 1); for a whole frame use `get_design_context`. Up to 50 node ids per call. |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "node_ids": ["12:345"]
}
```

---

### get_figjam

Structured content of a FigJam board: sticky notes (text + color), shapes-with-text, sections,
connectors (from->to edges with labels), and tables. The headless analogue of the official
`get_figjam` - returns board data, not generated UI code. Use `nodeNames` to label connector
endpoints. Tables degrade to an ordered flat list of cell texts (REST exposes no row/column
index).

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | FigJam board URL (`/board/<key>`) or raw key |
| `node_id` | string | Scope to a section/subtree; omit for the whole board |
| `depth` | integer 1–8 (default 4) | Tree depth to walk. Lower it (or pass `node_id`) if the board overflows the size budget. |
| `include_hidden` | boolean (default `false`) | Include hidden nodes. |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/board/XyZaBc678901/Team-Retro",
  "node_id": "3:200"
}
```

