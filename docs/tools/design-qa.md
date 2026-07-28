# Design QA tools

Deterministic Figma ↔ DOM verification: project a Figma frame into a diff-ready spec, capture the
rendered DOM with the canonical extractor, pair the two sides, and get a machine-readable metric
diff with an honest verification receipt.

Typical order: [`find_breakpoint_variant`](#find_breakpoint_variant) →
[`get_layout_spec`](#get_layout_spec) → [`suggest_pairs`](#suggest_pairs) →
[`compare_node_to_dom`](#compare_node_to_dom), with [`get_view`](#get_view) for orientation inside
a large frame. The full cycle is walked through in the
[Design QA tutorial](../design-qa-tutorial.md).

To understand *how a node is built* (auto-layout, fills, tokens, component structure) rather than
to verify it against a rendered page, use
[`get_design_context`](navigation.md#get_design_context) — the code-oriented extraction tool.

---

### get_layout_spec

Diff-ready layout spec of nodes: rect, auto-layout axis/gap/padding, in-flow children geometry,
typography, fill hex, component identity. Lightweight (shallow fetch) - use it to pick the target
frame width and build node<->selector pairs before `compare_node_to_dom`.

`include_extractor:true` returns the DOM extractor (schema-versioned with the server) as
`extractor_js` - by default a short loader thunk that fetches the canonical script from the server
rather than inlining it (`extractor_mode:"inline"` forces the full script, e.g. if a CSP blocks
the loader's script tag). When the server is configured for it, it also returns an `upload_url`
the extractor can POST snapshots to directly from the browser, yielding a `dom_ref` to pass to
`compare_node_to_dom` instead of pasting raw snapshot JSON.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key |
| `node_ids` | string[], **required** | Node ids to project into diff-ready layout specs (batched in one REST call). |
| `include_extractor` | boolean (default `false`) | Include the canonical DOM extractor script (paste it VERBATIM into chrome-devtools `evaluate_script`). |
| `extractor_mode` | `"loader"` \| `"inline"` (default `"loader"`) | `loader`: a <=7-line thunk that fetches the versioned extractor from the server (`GET /api/dom-snapshots/extractor.js`) instead of inlining ~90 lines of JS every call - falls back to inline automatically if the server has no public base URL configured. `inline`: always return the full extractor script (e.g. if the loader's script-tag injection is CSP-blocked). |
| `max_depth` | integer 1–8 (default 4) | Capture depth for BOTH sides (Figma projection + emitted extractor). Drill into a `childrenTruncated` branch by re-fetching it deeper (e.g. `max_depth:6`) - pass the SAME `max_depth` to `compare_node_to_dom` for that pair, or the Figma/DOM sides desync. |
| `text_leaves` | boolean (default `false`) | Instead of the full spec tree, return a flat list of leaf TEXT nodes (id/name/path/text_snippet/typography) under each node_id - one call to enumerate typography for pair-building/inspection, no manual frame->children->text drill. Respects `max_depth`; `text_leaves_truncated` flags leaves beyond the depth cut (raise `max_depth` to reach them). |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "node_ids": ["12:340"],
  "include_extractor": true,
  "max_depth": 4
}
```

Response (abridged):

```jsonc
{
  "schema": 5,
  "specs": [
    {
      "node_id": "12:340",
      "spec": {
        "id": "12:340", "name": "Product card", "type": "FRAME",
        "rect": { "w": 320, "h": 420 },
        "layout": { "axis": "vertical", "gap": 12, "padding": { "top": 16, "right": 16, "bottom": 16, "left": 16 } },
        "children": [
          { "id": "12:341", "name": "title", "type": "TEXT", "rect": { "w": 288, "h": 24 },
            "typography": { "fontFamily": "Inter", "fontWeight": 600, "fontSize": 16 } }
          /* … */
        ]
      }
    }
  ],
  "extractor_js": "/* versioned loader thunk — run verbatim in the browser */",
  "upload_url": "https://<server>/api/dom-snapshots/<capToken>"
}
```

---

### suggest_pairs

Propose Figma-node <-> DOM-element pairs (by text/size/order/role) with confidence + ambiguous flags
+ honest unmatched, so you review proposed pairs instead of hand-building them (compound `I...;...`
ids come dug out of the frame). Two-step: capture the frame-root DOM subtree with the extractor,
pass it here, feed confirmed pairs to `compare_node_to_dom`.

Under an unpaired parent (or once one side of a pair is a leaf), its descendants are not
inspected - the top is reported honestly in `unmatched_figma` / `unmatched_dom` instead, and you
drill in by hand.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key |
| `frame_node_id` | string, **required** | Frame/root node to align against the DOM subtree |
| `dom_snapshot` | object | `DomSnapshot` object from the canonical extractor (`get_layout_spec include_extractor:true`) - the WHOLE frame-root subtree (root selector), carrying per-node `path`. Pass the OBJECT (same shape as `compare_node_to_dom.dom`), not a stringified JSON. Pass exactly one of `dom_snapshot` \| `dom_ref`. |
| `dom_ref` | object `{ ref, selector?, index? }` | Reference to a browser-uploaded snapshot (`get_layout_spec` `upload_url` flow) instead of inlining the whole-frame DOM JSON. `ref` = the `snapshot_ref` from the extractor POST; `selector` must match byte-for-byte the root selector passed to the extractor, OR `index` addresses it by position (safe on duplicate selectors). Pass exactly one of `dom_snapshot` \| `dom_ref`. |
| `max_depth` | integer ≥ 1 | Bound matching depth (large frames - pair a subtree at a time). Levels 0..max_depth inclusive are processed. |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "frame_node_id": "12:340",
  "dom_ref": { "ref": "snap_0f3a…", "index": 0 }
}
```

Response (abridged):

```jsonc
{
  "pairs": [
    { "node_id": "12:341", "selector": ".card__title", "confidence": "high", "matched_by": "text" },
    { "node_id": "12:344", "selector": ".card__price", "confidence": "medium", "ambiguous": true }
  ],
  "unmatched_figma": [{ "id": "12:349", "name": "badge" }],
  "unmatched_dom": [],
  "summary": { "pairs": 2, "unmatched_figma": 1, "unmatched_dom": 0 }
}
```

---

### compare_node_to_dom

Deterministic metric diff between Figma nodes and DOM computed snapshots: sizes, inter-child gaps
(derived from geometry - insensitive to margin/padding/gap implementation), effective paddings,
cross-axis offsets, typography, colors, component identity (warn-only). Returns machine-readable
rows `{prop, figma, dom, delta, status}` per pair + a ready "Verified against Figma" markdown block.
Snapshots come from the canonical extractor
(`get_layout_spec include_extractor:true`).

Token rows with status `review` carry `figma`/`dom` token names - judge them: return **same
token** (-> resolved) only if the names denote the same concept; **wrong token** (-> report) ONLY
when they denote clearly-DIFFERENT concepts (e.g. error vs success); when the names cannot be
bridged either way (a possible rename), answer **unsure** and escalate - never call it wrong.
`review` rows keep the verdict non-green until resolved; a name that merely differs textually is
not a defect.

The response also carries a `verification` receipt - a machine gate with `complete: true|false`
and an actionable `blocking` list - plus per-pair `source` hints (CSS-module file candidates) and
a `fix_plan` (grouped edits derived from fail rows). See the
[Design QA tutorial](../design-qa-tutorial.md) for how to read them.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key |
| `pairs` | array, **required** | `node_id` <-> DOM snapshot pairs, all fetched in ONE REST call. Each item: `{ node_id, dom?, dom_ref?, label?, expected_component? }` - pass `dom` (extractor snapshot object) or `dom_ref` (uploaded-snapshot reference). |
| `frame_node_id` | string | The breakpoint frame you resized the viewport to - enables the viewport guard |
| `expected_overlay_width` | number | The actual rendered width of a fixed-width overlay (drawer/modal) whose DOM box does not scale with the viewport. Decouples `size.w` and the viewport guard from `frame_node_id`, adds a dedicated `overlay_width` row, and - when `frame_node_id` is ALSO given - a preflight check that the chosen breakpoint frame actually matches this width. |
| `tolerance_px` | number 0–10 | A delta below this is a pass (px metrics); omitted -> 1 (token-aware/layout) or 0 (strict); an explicit >0 is rejected under strict |
| `match_profile` | `"strict"` \| `"layout"` \| `"token-aware"` | Named strictness/scope preset (omitted -> `token-aware`). `strict` = tolerance 0 (exact equality after 0.05px rounding). `token-aware` = default behaviour, `tolerance_px` default 1. `layout` = only visual-geometry axes are measured (typography/colors/styles/component out of scope). |
| `max_depth` | integer 1–8 (default 4) | Capture depth for BOTH sides (Figma projection + expected DOM snapshot depth). Drill into a `childrenTruncated` branch by re-fetching/re-extracting it deeper (e.g. `max_depth:6`) - pass the SAME `max_depth` used for the `get_layout_spec` extractor call that produced these dom snapshots, or the Figma side stays shallow while the DOM side is deep (or vice versa). |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "frame_node_id": "12:340",
  "pairs": [
    { "node_id": "12:341", "dom_ref": { "ref": "snap_0f3a…", "selector": ".card__title" }, "label": "title" }
  ],
  "match_profile": "token-aware"
}
```

Response (abridged — see the [tutorial](../design-qa-tutorial.md) for a full annotated example):

```jsonc
{
  "tolerance_px": 1,
  "pairs": [
    {
      "node_id": "12:341",
      "label": "title",
      "rows": [
        { "prop": "size.w", "figma": 288, "dom": 288, "delta": 0, "status": "pass" },
        { "prop": "font-weight[title]", "figma": 600, "dom": 400, "delta": 200, "status": "fail" }
      ],
      "summary": { "pass": 1, "fail": 1, "warn": 0, "skip": 0, "info": 0, "demoted": 0, "unchecked": 0, "review": 0 },
      "coverage": { "measured": ["size", "typography"], "skipped": [] }
    }
  ],
  "verification": {
    "complete": false,
    "scope": "frame",
    "pairs": { "checked": 1, "clean": 0 },
    "blocking": [
      { "kind": "uncovered_region", "node_id": "12:344", "action": "add_pair", "detail": "child \"price\" has no pair" }
    ]
  },
  "not_covered_by_tool": ["icons"],
  "report_markdown": "…ready-to-paste verification block…"
}
```

---

### find_breakpoint_variant

Resolve which breakpoint variant frame matches your rendered width. Works from a bare text query
(no node_id required - avoids a whole-file `find_nodes` on files with many near-duplicate variant
frames). Rank is by CONTENT frame width, not the variant frame's own width (a variant named
"desktop" (w1280) whose inner drawer content is w420 matches `render_width` 420). On huge files
pass `parent_node_id` (a section or page) to scope the walk and avoid timing out.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key |
| `query` | string, **required** | Substring to match against a breakpoint-variant frame's own name OR its nearest section/page (container) name, case-insensitive. |
| `render_width` | number, **required** | The width you rendered the DOM at - variants are ranked by how close a CONTENT frame's width is to this. |
| `parent_node_id` | string | Scope the walk to this node's subtree (e.g. a section or page) instead of the whole document. Use on huge files to avoid a slow/timing-out whole-document walk. |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "query": "product card",
  "render_width": 1280
}
```

Response (abridged):

```jsonc
{
  "matches": [
    { "node_id": "12:340", "name": "Desktop", "frame_width": 1280, "content_width": 1280, "container": "Product card" },
    { "node_id": "12:400", "name": "Tablet", "frame_width": 768, "content_width": 768, "container": "Product card" }
  ]
}
```

---

### get_view

Single-root navigation over a held frame: one `node_id`, five pure lenses
(skeleton/branch/coverage/typography/spacing) sliced from one deep-fetch, zero re-fetch across
views/depths.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key |
| `node_id` | string, **required** | Single node to view (globally unique). `get_layout_spec` keeps the `node_ids[]` batch for pairs. |
| `view` | enum, **required** | `skeleton` (default depth 6): collapsed structural map (single-child wrappers collapsed, repeated siblings summarized). `branch` (default depth 4): the compare-compatible layout spec. `coverage` (default depth 6): per-container which children will yield gap rows. `typography` (default depth 8): flat TEXT leaves (single-root -> reaches deep DS text). `spacing` (default depth 6): gaps/paddings per container. |
| `max_depth` | integer 1–8 | Projection depth (per-view default 4-8). |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "node_id": "12:340",
  "view": "skeleton"
}
```

Response (abridged):

```jsonc
{
  "node_id": "12:340",
  "view": "skeleton",
  "held_depth": 7,
  "tree": {
    "name": "Product card", "type": "FRAME",
    "children": [
      { "name": "title", "type": "TEXT" },
      { "name": "item", "type": "INSTANCE", "repeated": 8 }
    ]
  }
}
```
