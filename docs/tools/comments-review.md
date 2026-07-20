# Comments & review tools

Read and write Figma comment threads, and extract structured data from design-review boards
(prod screenshots + numbered pins + comment fields + reference frames).

On large files start with [`summarize_comments`](#summarize_comments) to scope, then fetch full
threads with [`get_comments`](#get_comments) or search them with [`find_threads`](#find_threads).
The write tools ([`post_comment`](#post_comment), [`reply_to_comment`](#reply_to_comment),
[`resolve_comment`](#resolve_comment)) are disabled when the server runs in read-only mode.

## Shared filter parameters

`get_comments`, `summarize_comments` and `find_threads` accept the same filter set:

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw file key |
| `include_resolved` | boolean (default `true`) | Include resolved threads |
| `node_id` | string | Filter threads anchored to this node (exact unless `include_descendants=true`) |
| `include_descendants` | boolean (default `false`) | With `node_id`, also include threads on descendant nodes (e.g. all threads on a page) |
| `node_type` | enum | Only threads anchored to a node of this Figma type (`FRAME`, `COMPONENT`, `COMPONENT_SET`, `INSTANCE`, `GROUP`, `SECTION`, `TEXT`, `CANVAS`) |
| `author_id` | string | Filter by stable `user.id` (preferred) |
| `author_handle` | string | Filter by display name (handles can change) |
| `message_contains` | string | Case-insensitive substring filter on message (root + replies) |
| `since` / `until` | string | Only threads where `root.created_at` is >= / <= this ISO8601 time |
| `min_replies` | integer ≥ 0 | Only threads with at least N replies |
| `min_reactions` | integer ≥ 0 | Only threads whose root has at least N reactions |
| `has_mentions` | boolean | Only threads with @-mentions in root or any reply |
| `node_depth` | integer 0–10 (default 0) | Figma `/nodes` depth for fallback name resolution — 0 = name only (fast) |
| `timeout_ms` | integer 1000–120000 | Per-call Figma request timeout in ms (default 90000). Raise toward the max for very large files if you still hit timeouts. |
| `figma_token` | string | Override Figma PAT; falls back to `FIGMA_TOKEN` env |

---

### get_comments

Fetch review comments from a Figma file as threads, with rich filtering (author, message, dates,
node, mentions) and pagination. Anchors resolve to node names/pages. Use `summarize_comments`
first on large files.

**Parameters** — all [shared filters](#shared-filter-parameters), plus:

| Parameter | Type | Description |
| --- | --- | --- |
| `as_markdown` | boolean (default `true`) | Return markdown (default) vs structured JSON |
| `limit` | integer 1–200 (default 50) | Max threads returned |
| `offset` | integer ≥ 0 (default 0) | Skip first N matching threads (pagination) |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "node_id": "12:340",
  "include_descendants": true,
  "include_resolved": false,
  "limit": 20
}
```

---

### summarize_comments

Aggregate statistics for a Figma file's comments (counts by author/anchor/node/date, top threads,
mentions) using the same filters as `get_comments`. Returns a compact ~1-2KB summary — use this
first to scope large files before fetching full threads.

**Parameters** — all [shared filters](#shared-filter-parameters), plus:

| Parameter | Type | Description |
| --- | --- | --- |
| `top_n` | integer 1–50 (default 10) | How many entries in `by_top_nodes` and `top_threads_by_replies` |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "since": "2026-01-01T00:00:00Z"
}
```

---

### find_threads

Search a Figma file's comment threads by text, ranked by relevance, with optional fuzzy matching
and the full filter set. Returns scored matches with highlights — use to locate specific
discussions in large files.

**Parameters** — all [shared filters](#shared-filter-parameters), plus:

| Parameter | Type | Description |
| --- | --- | --- |
| `query` | string, **required** | Search text; space-separated words are AND clauses |
| `fuzzy` | boolean (default `false`) | Typo-tolerant fuzzy matching. Default `false` uses fast exact substring. For word-form variants search by the common stem; enable fuzzy for typos. |
| `limit` | integer 1–50 (default 10) | Max matches returned |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "query": "contrast button",
  "fuzzy": true
}
```

---

### post_comment

Post a new root-level comment on a Figma file. Disabled in read-only mode.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw file key |
| `message` | string, **required** | Comment text |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "message": "Design QA passed for the checkout flow — see the verification report in the PR."
}
```

---

### reply_to_comment

Reply to an existing comment thread in a Figma file. Disabled in read-only mode.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw file key |
| `comment_id` | string, **required** | ID of the root comment to reply to |
| `message` | string, **required** | Reply text |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "comment_id": "123456789",
  "message": "Fixed in the latest build — gap is now 12px as specified."
}
```

---

### resolve_comment

Resolve a Figma comment thread (marks it resolved; it stays visible in the file). Disabled in
read-only mode. Pass the comment id from `get_comments`.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw file key |
| `comment_id` | string, **required** | ID of the comment or thread root to resolve |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "comment_id": "123456789"
}
```

---

### get_review_board

Extract a design-review board in one call. Use this when a section packs a prod screenshot with
numbered pin markers, "comment field" frames of numbered notes, and reference frames — the classic
design-review layout. Returns each note linked pin↔text↔target (the pin number, its comment text,
and the prod-screenshot coordinate the pin points at), grouped by lane (the prod screenshot each
pin sits on) — no manual x/y geometry.

Pins link to comments by their sequential number, assuming numbering is unique board-wide; when it
is not, a `duplicate_pin_numbers` warning is emitted and ambiguous/cross-lane links are left as
unmatched (honest-unmatched over confidently-wrong).

Each note also resolves a `referenceNode` (the node under the pin in the lane's aligned reference
frame): the deepest leaf, a `suggested` container, and an ancestor `path`; `nearestTargetNodeId`
is the deepest leaf id. When no aligned reference exists, `referenceNode` is `null` with a
`referenceReason`. Each `referenceNode` also carries a `confidence`
(`{level: high|medium|low, scaleDiscrepancyPx, boundaryMarginPx}`) for the linear pin→reference
projection — when `level` is not `"high"`, re-verify the `suggested` node visually with
`get_screenshot` (`return=preview`) before acting on it, because prod/reference layout differences
can drift the projection into a neighbouring band. To identify the element directly, call
`get_screenshot` with `focus=target.atPercent` (a zoomed crop around the pin), read what it points
at, then locate that element in the reference with `find_nodes` — this beats the linear projection
when prod/reference layouts drift.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key |
| `node_id` | string, **required** | The review-board section/frame to extract (e.g. a section packed with numbered pins and comment fields) |
| `include_screenshots` | boolean (default `false`) | Attach a short-lived signed prod-screenshot URL per lane for visual context (token-light — a URL, not base64). |
| `pin_name` | string | Override the pin marker name pattern (regex; the default matches common "pin" names). |
| `comment_field_name` | string | Override the comment-field name pattern (regex; the default matches common "comment"/"note" names). |
| `reference_name` | string | Override the reference-frame name pattern (regex). By default the reference frame is detected structurally (the aligned non-screenshot column), not by name. |
| `include_bounds` | boolean (default `false`) | Add w/h to each `referenceNode.path` node — container size is often the answer in design review. |
| `depth` | integer 1–10 (default 6) | Subtree depth to fetch. |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Design-Review",
  "node_id": "20:100",
  "include_screenshots": true
}
```

---

### get_pin_detail

Inspect ONE review-board pin in a single call: returns a zoomed, reticle-marked PNG crop of
exactly where the pin points (the prod screenshot region) plus its resolved `referenceNode`
(deepest leaf + `suggested` container + `path` + `confidence`), the reference-frame node_id, and
the full-res screenshot URL.

Use this to recover a pin whose `get_review_board` confidence is not `"high"`: read the element in
the crop, then `find_nodes(file, query=<what you see>, node_id=<referenceFrameNodeId>)` to locate
it in the reference — this beats the linear projection when prod/reference layouts drift.
`board_node_id` is the same section you pass to `get_review_board`. Address the pin by
`pin_number` (unique-numbered boards) OR by `pin_node_id` (from `item.pinNodeId` in the
`get_review_board` output) — use `pin_node_id` on multi-lane boards where numbers repeat per lane.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key |
| `board_node_id` | string, **required** | The review-board section (the same node_id you pass to `get_review_board`). |
| `pin_number` | integer ≥ 1 | The pin number to inspect. Use on boards where numbering is unique. Provide either `pin_number` OR `pin_node_id` (exactly one). |
| `pin_node_id` | string | Address the pin directly by its marker node id (from `item.pinNodeId` in `get_review_board` output). Use this on multi-lane boards where pin numbers repeat per lane and a number alone is ambiguous. |
| `focus_radius` | number 0.02–0.5 (default 0.12) | Focus-crop half-size as a fraction of the prod screenshot width. 0.12 ≈ a ~24%-wide window. |
| `depth` | integer 1–10 (default 6) | Subtree depth to fetch (match `get_review_board`). |
| `pin_name` | string | Override the pin marker name pattern (regex). |
| `comment_field_name` | string | Override the comment-field name pattern (regex). |
| `reference_name` | string | Override the reference-frame name pattern (regex). |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Design-Review",
  "board_node_id": "20:100",
  "pin_number": 3
}
```
