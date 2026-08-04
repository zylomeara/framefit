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

**Which deployment the examples on this page need.** Every request example below is shaped for the
stdio server the [quickstart](../../README.md#quickstart) installs - substitute your own file key
and node ids and it runs there. The one thing that does not run there is `dom_ref`: it, and the
`upload_url` that mints it, need the DOM-snapshot store, which only the HTTP server paths construct.
On stdio `suggest_pairs` throws `snapshot store unavailable on this server — pass dom_snapshot
inline`, and `compare_node_to_dom` notes `snapshot store unavailable on this server — pass dom
inline` on the pair. So the examples here pass the snapshot inline; switch to `dom_ref` once you run
the server over HTTP.

**Where the response examples come from.** Each one below is a real return of that tool's handler,
captured from the request shown above it against a stub of one small Figma file (a `Product card`
section holding a `Desktop` and a `Mobile` frame, the Desktop one holding the 320x420 card the other
examples measure). They are then **trimmed, never edited**: an elided array or object tail is marked
`/* ... */`, and two strings too long to print — the inline extractor and the report markdown — are
replaced by a `<..., N chars - elided>` placeholder. Nothing is added.
`mcp-server/tests/unit/docs-response-examples.test.ts` rebuilds every capture from the handler on
each test run and fails if a key or a value on this page is not in it.

---

### get_layout_spec

Diff-ready layout spec of nodes: rect, auto-layout axis/gap/padding, in-flow children geometry,
typography, fill hex, component identity. Lightweight (shallow fetch) - use it to pick the target
frame width and build node<->selector pairs before `compare_node_to_dom`.

`include_extractor:true` returns the DOM extractor (schema-versioned with the server) as
`extractor_js`: the loader thunk that fetches the canonical script (`extractor_mode:"loader"`, the
default) is returned only when the server has a public base URL to point the browser at -
otherwise, and whenever `extractor_mode:"inline"` is passed, the full script comes back inline, with
`extractor_note` saying so when the loader was asked for and was unavailable. That same public base
URL, plus the snapshot store only the HTTP servers construct, is what also returns an `upload_url`
the extractor can POST snapshots to directly from the browser, yielding a `dom_ref` to pass to
`compare_node_to_dom`; the stdio server has neither, so pass the snapshot inline as
`compare_node_to_dom`'s `dom`.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key |
| `node_ids` | string[], **required** | Node ids to project into diff-ready layout specs, up to 20 per call (batched in one REST call). |
| `include_extractor` | boolean (default `false`) | Include the canonical DOM extractor script (paste it VERBATIM into chrome-devtools `evaluate_script`). |
| `extractor_mode` | `"loader"` \| `"inline"` (default `"loader"`) | `loader`: an 8-line thunk that fetches the versioned extractor from the server (`GET /api/dom-snapshots/extractor.js`) instead of inlining the whole script (738 lines, 54121 chars) every call - falls back to inline automatically if the server has no public base URL configured, which is every stdio deployment. `inline`: always return the full extractor script (e.g. if the loader's script-tag injection is CSP-blocked). |
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

Response (abridged), from the stdio server:

```jsonc
{
  "file": "AbCdEf012345",
  "snapshot_schema": 6,
  "specs": [
    {
      "node_id": "12:340",
      "spec": {
        "node": { "id": "12:340", "name": "Product card", "type": "FRAME" },
        "children": [
          { "id": "12:341", "name": "title", "type": "TEXT",
            "rect": { "x": 16, "y": 16, "w": 288, "h": 24 },
            "text": { "fontFamily": "Inter", "fontWeight": 600, "fontSize": 16 },
            "textSnippet": "Product card", "children": [] }
          /* ... then "price" (12:344) and the "list" frame (12:350) with its eight items */
        ],
        "rect": { "x": 0, "y": 0, "w": 320, "h": 420 },
        "axis": "col",
        "autoLayout": { "gap": 12, "padding": { "top": 16, "right": 16, "bottom": 16, "left": 16 } }
      }
    }
  ],
  "hydration": [
    { "node_id": "12:340", "held_depth": 5, "hydrated": true, "drill_free_upto": 4,
      "cause_breakdown": { "depth": 0, "breadth": 0, "budget": 0 } }
  ],
  "extractor_js": "<full inline extractor script, 54121 chars - elided>",
  "extractor_note": "loader unavailable without public base URL — inline returned",
  "extractor_hint": "no upload_url on this server: the extractor hands the snapshots back to you. Paste extractor_js ONCE as `window.__extract = <extractor_js VERBATIM>;`, then every capture is `async () => await window.__extract([\"<sel>\", …], undefined, 3, 90)` (a reload drops the handle — paste again). Pass include_extractor:false on every later get_layout_spec call. Hand each snapshot inline to the matching compare_node_to_dom pairs[i].dom."
  /* On an HTTP server with a public base URL, extractor_js is the versioned loader thunk instead,
     there is no extractor_note and no extractor_hint, and an
     "upload_url": "https://<server>/api/dom-snapshots/<capToken>" is returned alongside it, carrying
     its own "upload_hint" with the browser-POST call form. */
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
| `dom_ref` | object `{ ref, selector?, index? }` | Reference to a browser-uploaded snapshot (`get_layout_spec` `upload_url` flow) instead of inlining the whole-frame DOM JSON. Only the HTTP servers construct the snapshot store this resolves against; on stdio pass `dom_snapshot` inline. `ref` = the `snapshot_ref` from the extractor POST; `selector` must match byte-for-byte the root selector passed to the extractor, OR `index` addresses it by position (safe on duplicate selectors). Pass exactly one of `dom_snapshot` \| `dom_ref`. |
| `max_depth` | integer ≥ 1 | Bound matching depth (large frames - pair a subtree at a time). Levels 0..max_depth inclusive are processed. |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "frame_node_id": "12:340",
  "dom_snapshot": {
    "schema": 6,
    "selector": ".card",
    "innerWidth": 320,
    "rect": { "x": 0, "y": 0, "w": 320, "h": 420 },
    "borders": { "top": 0, "right": 0, "bottom": 0, "left": 0 },
    "paddings": { "top": 16, "right": 16, "bottom": 16, "left": 16 },
    "scroll": { "top": 0, "left": 0 },
    "children": [
      {
        "kind": "element",
        "tag": "h3",
        "classList": ["card__title"],
        "path": "1",
        "rect": { "x": 16, "y": 16, "w": 288, "h": 24 },
        "text": "Product card"
      }
    ]
  }
}
```

The `dom_snapshot` above is a two-node snapshot cut down to fit the page; the real one is whatever
the extractor printed for the frame root, pasted whole.

Response (abridged):

```jsonc
{
  "file": "AbCdEf012345",
  "frame": { "id": "12:340", "name": "Product card", "type": "FRAME" },
  "pairs": [
    { "node_id": "12:341", "name": "title", "type": "TEXT", "dom_path": "1",
      "confidence": "high", "signals": ["text-exact", "size", "order"],
      "figma_text": "Product card", "dom_text": "Product card" }
  ],
  "unmatched_figma": [
    { "node_id": "12:344", "name": "price", "reason": "no DOM candidate" }
    /* ... then the "list" frame (12:350), same shape */
  ],
  "unmatched_dom": [],
  "summary": { "paired": 1, "ambiguous": 0, "unmatched_figma": 2, "unmatched_dom": 0 }
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

The example below submits one pair out of the frame's three children, so its receipt reports
`complete: false` and names what is still unchecked. That is the gate doing its job, not the tool
failing: a `false` here means the run measured less than the whole frame, and `blocking` says which
action closes the gap. Note that pairing all three would still report `false` - a text pair carries
no auto-layout, and an unmeasurable property is a coverage hole by construction rather than
something more pairs can fix.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key |
| `pairs` | array, **required** | `node_id` <-> DOM snapshot pairs - up to 20 per call, all fetched in ONE REST call. Each item: `{ node_id, dom?, dom_ref?, label?, expected_component? }` - pass `dom` (extractor snapshot object) or `dom_ref` (uploaded-snapshot reference). |
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
    {
      "node_id": "12:341",
      "dom": {
        "schema": 6,
        "selector": ".card__title",
        "innerWidth": 320,
        "rect": { "x": 16, "y": 16, "w": 288, "h": 24 },
        "borders": { "top": 0, "right": 0, "bottom": 0, "left": 0 },
        "paddings": { "top": 0, "right": 0, "bottom": 0, "left": 0 },
        "scroll": { "top": 0, "left": 0 },
        "styles": { "fontFamily": "Inter", "fontWeight": 400, "fontSize": 16 },
        "componentHints": { "tag": "h3", "classList": ["ProductCard_title__a1b2c3"], "data": {} },
        "children": []
      },
      "label": "title"
    }
  ],
  "match_profile": "token-aware"
}
```

Two fields of that snapshot decide what comes back. `innerWidth` is the window width you captured
at: it must come within `max(24, 5% of the frame width)` of the `frame_node_id` frame's width (320
here, so 296 through 344), or the viewport guard turns every geometry row `unchecked` and adds a
`fix_viewport` blocking item. `componentHints.classList` is what
the code address is parsed from — a CSS-modules class gives you the `source` and `fix_plan[].target`
below; without one there is no `source` key at all, `target` is `null`, and the plan can only say
"address not resolved".

Response (abridged — see the [tutorial](../design-qa-tutorial.md) for a full annotated example):

```jsonc
{
  "file": "AbCdEf012345",
  "tolerance_px": 1,
  "frame": { "node_id": "12:340", "width": 320 },
  "pairs": [
    {
      "node_id": "12:341",
      "label": "title",
      "selector": ".card__title",
      "rows": [
        { "prop": "viewport", "figma": 320, "dom": 320, "status": "pass" },
        { "prop": "size.w", "figma": 288, "dom": 288, "status": "pass" },
        { "prop": "size.h", "figma": 24, "dom": 24, "status": "pass" },
        { "prop": "children", "status": "skip", "note": "node without auto-layout — inter-element metrics are not computed" },
        { "prop": "font-size", "figma": 16, "dom": 16, "status": "pass" },
        { "prop": "font-weight", "figma": 600, "dom": 400, "status": "fail", "srcChannel": { "kind": "root", "editKind": "property" } },
        { "prop": "font-family", "figma": "inter", "dom": "inter", "status": "pass" }
      ],
      "summary": { "pass": 5, "fail": 1, "warn": 0, "skip": 1, "info": 0, "demoted": 0, "unchecked": 0, "review": 0 },
      "coverage": { "measured": ["font-family", "font-size", "font-weight", "size", "viewport"], "skipped": [] },
      "source": { "root": { "module": "ProductCard", "local": "title", "raw": "ProductCard_title__a1b2c3" } },
      "fix_plan": [
        { "target": { "module": "ProductCard", "local": "title", "raw": "ProductCard_title__a1b2c3" },
          "channel": "root",
          "edits": [{ "prop": "font-weight", "kind": "property", "expected": 600, "actual": 400 }] }
      ]
    }
  ],
  "summary": { "pass": 5, "fail": 1, "warn": 0, "skip": 1, "info": 0, "demoted": 0, "unchecked": 0, "review": 0 },
  "verification": {
    "complete": false,
    "scope": "frame",
    "pairs": { "checked": 1, "clean": 0 },
    "match_profile": "token-aware",
    "frame_coverage": { "worthy": 3, "covered": 1, "uncovered": ["12:344", "12:350"], "partial": [],
      "enumeration_truncated": false, "enumeration_depth": 4, "enumeration_source": "pair_fetch" },
    "blocking": [
      { "kind": "uncovered_region", "node_id": "12:344", "action": "add_pair",
        "detail": "frame region unpaired — the region's layout is not verified" }
      /* ... then the same for the "list" frame (12:350), and a resolve_skip item for the
         skipped "children" row on 12:341 */
    ]
  },
  /* a "hydration" receipt follows here, in the same shape as get_layout_spec's */
  "not_covered_by_tool": ["icons"],
  "report_markdown": "<verification report markdown, 1257 chars - elided>"
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
  "render_width": 320
}
```

Response (abridged):

```jsonc
{
  "query": "product card",
  "render_width": 320,
  "tolerance": 24,
  "variants": [
    { "node_id": "12:300", "name": "Desktop", "container": "Product card", "frame_w": 1280,
      "content": [
        { "node_id": "12:340", "name": "Product card", "w": 320, "isBestMatch": true }
        /* ... then the "list" frame (12:350), w 288 */
      ] }
    /* ... then the "Mobile" variant (12:320), frame_w 375 */
  ],
  "match": { "node_id": "12:340", "w": 320, "variant_node_id": "12:300" }
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
  "file": "AbCdEf012345",
  "view": "skeleton",
  "effective_max_depth": 6,
  "node_id": "12:340",
  "skeleton": {
    "node_id": "12:340", "type": "FRAME", "name": "Product card", "child_count": 3, "axis": "col",
    "children": [
      { "node_id": "12:341", "type": "TEXT", "name": "title", "child_count": 0 },
      { "node_id": "12:344", "type": "TEXT", "name": "price", "child_count": 0 },
      { "node_id": "12:350", "type": "FRAME", "name": "list", "child_count": 8, "axis": "col",
        "children": [
          { "node_id": "12:351", "type": "INSTANCE", "name": "item", "child_count": 0,
            "repeated": { "count": 8, "of": "item", "signature": "INSTANCE|item|" } }
        ] }
    ]
  },
  "hydration": { "node_id": "12:340", "held_depth": 7, "hydrated": true, "drill_free_upto": 6,
    "cause_breakdown": { "depth": 0, "breadth": 0, "budget": 0 } }
}
```
