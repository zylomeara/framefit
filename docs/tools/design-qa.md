# Design QA tools

Deterministic Figma ↔ DOM verification: project a Figma frame into a diff-ready spec, capture the
rendered DOM with the canonical extractor, pair the two sides, and get a machine-readable metric
diff with an honest verification receipt.

## The cycle

Stated once, here. The server's own MCP `instructions`, the
[agent skill](../agents/design-qa-skill.md) and the [tutorial](../design-qa-tutorial.md) point at
this list and add detail to it; none of them redefines it.

1. [`find_breakpoint_variant`](#find_breakpoint_variant) — pick the frame whose **content** width
   matches your render width. Skip it when you already know the frame id.
2. [`get_layout_spec`](#get_layout_spec) with `include_extractor: true` — the Figma side of the
   comparison, plus the canonical DOM extractor.
3. **In the browser, not in a framefit tool** — run that extractor over your CSS selectors and keep
   the snapshot it returns for each one. No tool on this page can do this step: it needs a rendered
   page, and the server never sees one. This is where an agent uses its browser automation.
4. [`suggest_pairs`](#suggest_pairs) — propose `node_id` ↔ selector pairs out of the frame-root
   snapshot, with honest `unmatched_figma` / `unmatched_dom` lists. Skip it when you already know
   which node each selector renders: it is the answer to "I do not know the node ids", not a toll
   gate on the compare.
5. [`compare_node_to_dom`](#compare_node_to_dom) — the measurement, and the verdict.

Then read `verification.complete` — the done-gate. Never claim the UI matches the design while it is
`false` or `blocking[]` is non-empty: each blocking item names the action that closes it. Work those
actions, re-capture the pairs they name (step 3), and run step 5 again.

[`get_view`](#get_view) is not a step in that sequence — it is orientation inside a large frame, at
any point. [`examples/first-verdict.mjs`](../../examples/first-verdict.mjs) is the same five steps
as a runnable stdio client, and the [tutorial](../design-qa-tutorial.md) walks them end to end with
a worked example.

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

**What the two big payloads cost, and who can avoid paying it.** Step 2's `extractor_js` is the whole
script inline on stdio, and step 3's snapshot is tens of thousands of characters per pair. Both cross
an agent's context by default, and neither has to:
[`examples/first-verdict.mjs`](../../examples/first-verdict.mjs) `serve-extractor` holds the script on
a loopback socket so the page fetches it, and its `verdict` reads the capture from a file the browser
tool wrote (chrome-devtools' `evaluate_script` takes a `filePath`). **That is the client avoiding the
crossing, not the tool contract changing.** `suggest_pairs` still takes `dom_snapshot` inline and
`compare_node_to_dom` still takes `pairs[].dom` inline — an agent calling these tools directly, with
no client in between, pays both costs in full, and so does any other client that does not do the same
two things.

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
| `extractor_mode` | `"loader"` \| `"inline"` (default `"loader"`) | `loader`: a short thunk that fetches the versioned extractor from the server (`GET /api/dom-snapshots/extractor.js`) instead of inlining the whole script every call - falls back to inline automatically if the server has no public base URL configured, which is every stdio deployment. `inline`: always return the full extractor script (e.g. if the loader's script-tag injection is CSP-blocked). |
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
  "extractor_js": "<full inline extractor script, 58116 chars - elided>",
  "extractor_note": "loader unavailable without public base URL — inline returned",
  "extractor_hint": "no upload_url on this server: the extractor hands the snapshots back to you. Paste extractor_js ONCE inside a thunk: `() => { window.__extract = <extractor_js VERBATIM>; return 'ok'; }` (evaluate_script CALLS what you send with no arguments, so a bare assignment throws) — then every capture is `async () => await window.__extract([\"<sel>\", …], undefined, 3, 90)` (a reload drops the handle — paste again). Pass include_extractor:false on every later get_layout_spec call. Hand each snapshot inline to the matching compare_node_to_dom pairs[i].dom."
  /* On an HTTP server with a public base URL, extractor_js is the versioned loader thunk instead,
     there is no extractor_note and no extractor_hint, and an
     "upload_url": "https://<server>/api/dom-snapshots/<capToken>" is returned alongside it, carrying
     its own "upload_hint" with the browser-POST call form. */
}
```

The spec keeps flow children only. When a node's direct children include rendered but absolutely
positioned layers (`layoutPositioning: ABSOLUTE` - overlays, modals, pins), that node carries
`outOfFlow: N` (mirroring the DOM snapshot's field of the same name) instead of listing them:
raising `max_depth` will NOT reveal such a child - request its node id directly, or pair it as its
own pair in `compare_node_to_dom`.

**Variable-bound colors carry their token name.** `fillHex`/`strokeHex` (and a TEXT child's
`text.colorHex`) are the RAW paint values from the REST response - for a color bound to a Figma
variable that raw hex is a snapshot in the library's default mode and may legitimately differ in
the app under another mode. When the binding can be resolved, the spec carries a sibling
`fillToken`/`strokeToken`/`text.colorToken` object: `{ token, hex, mode?, mode_dependent?,
mode_source? }` (single-mode tokens omit `mode_source`) - `token` is the variable name (the thing to write into code), `hex` its
mode-resolved value. `mode_source: "node"` means the mode was confirmed by an explicit pin inside
the FETCHED subtree; `"default"` means no pin was visible here and the value shown is the
collection default - this tool deliberately does not pay for whole-file ancestor discovery, so a
pin sitting above the requested node reads `"default"` where `get_design_context` (which does
discover ancestors) says `"node"`. When both tools name a binding they name it identically - one
shared resolver - but today `get_design_context` does not name every binding this tool can: a
single-mode variable bound at the PAINT level renders there as its raw hex (a legacy naming path
that predates paint-level reads), and a name recovered from the snapshot-DB tier is likewise
known here and not there. For a mode-confirmed value use `get_design_context` or
`compare_node_to_dom`. When the fill is bound but
NO resolver can name it (stdio without variables access, non-Enterprise file, unpublished
variable), the spec keeps the raw `fillBoundVar` alias id and no token object; if the variables
fetch itself failed or timed out, the response says so in `degraded_stages` (stage `variables`,
with the ms spent) - an absent token with no degradation entry means "nothing can name it", not
"the fetch broke".

---

### suggest_pairs

Propose Figma-node <-> DOM-element pairs (by text/size/order/role) with confidence + ambiguous flags
+ honest unmatched, so you review proposed pairs instead of hand-building them (compound `I...;...`
ids come dug out of the frame). Two-step: capture the frame-root DOM subtree with the extractor,
pass it here, feed confirmed pairs to `compare_node_to_dom`.

Under an unpaired parent (or once one side of a pair is a leaf), its descendants are not
inspected - the top is reported honestly in `unmatched_figma` / `unmatched_dom` instead, and you
drill in by hand.

Every proposal carries the receipt the ranking ran on: `score`, `margin` over the runner-up, both
rects, the DOM `dom_tag`, and `dom_selector` - the capture-root selector (which the extractor
already refused to accept unless it matched exactly one element) `:is()`-scoped over the
`dom_path`. It is pasteable as the *extractor's* root selector to re-capture that element -
`compare_node_to_dom` itself takes a snapshot or a `dom_ref`, never a selector, and a `dom_ref`
selector has to match the string the extractor was given byte-for-byte. No root selector in the
snapshot means no `dom_selector` field: an address is never synthesized. Each entry of
`candidates[]` carries the same `dom_tag` and `dom_rect` as the pair row: two near-tied candidates
print the same rounded `score`, and the tie then falls to document order, so the identity fields
are what actually decide it. A `children_skipped` row carries the list too, even when the runner-up
was too weak to be called an alternative - if it was decisive enough to withdraw a subtree, it is
named. Read the receipt, not the word - an
exact text match is worth +100 of a ~145 scale, so on a frame of containers every proposal reads
`low`, which says *no text on either side here*, not *bad geometry*. Those are yours to confirm,
and the two rects are usually enough to do it by eye. `children_skipped: true` means the lead over
the runner-up was inside the ambiguity band and no text below could settle it, so the subtree was
**not** matched underneath a parent that may be wrong - confirm or retarget the pair, then re-run
rooted on the confirmed element. A withheld subtree appears in *neither* unmatched list, on
purpose: an unmatched row asserts "no counterpart here", and we did not look. `summary.
children_skipped` counts those pairs, so an all-zero unmatched summary is not read as full
coverage over a frame where some nodes were never judged.

An address is only as fresh as the capture it came from. An `nth-child` chain always resolves to
*something*: after a navigation or a re-render the same chain can land on a different element, the
extractor answers `ok`, and `compare_node_to_dom` then reports the difference between two unrelated
elements as a design defect. Measured on an in-app route change, a pair scored against a 1280x348
grid re-resolved to a 44x44 button - silently, with `status: "ok"`. That is what `dom_rect` is for:
if the element you are about to compare no longer matches the rect on the row, re-capture instead
of trusting the verdict.

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
        "path": "> :nth-child(1)",
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
    { "node_id": "12:341", "name": "title", "type": "TEXT", "dom_path": "> :nth-child(1)",
      "dom_selector": ":is(.card) > :nth-child(1)",
      "confidence": "high", "signals": ["text-exact", "size", "order"],
      "score": 100, "figma_rect": { "w": 288, "h": 24 }, "dom_rect": { "w": 288, "h": 24 },
      "dom_tag": "h3", "figma_text": "Product card", "dom_text": "Product card" }
    /* score 100 = the unique-text bijection, which is not ranked against a runner-up, hence no
       margin. A container proposal instead reads confidence low, score ~30, margin ~3 and
       children_skipped: geometry only, unresolved, yours to confirm */
  ],
  "unmatched_figma": [
    { "node_id": "12:344", "name": "price", "reason": "no DOM candidate", "rect": { "w": 288, "h": 20 } }
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
not a defect. Exception: a `semantic-diverged` row was measured against the authored codeSyntax
mappings (the file's own variables and its synced libraries') - the DOM var is the authored name
of a DIFFERENT variable - and blocks even when the hexes match; align the code with the authored
var (or fix the mapping in Figma).

The response also carries a `verification` receipt - a machine gate with `complete: true|false`
and an actionable `blocking` list - plus per-pair `source` hints (CSS-module file candidates) and
a `fix_plan` (grouped edits derived from fail rows). See the
[Design QA tutorial](../design-qa-tutorial.md) for how to read them.

Token wiring is checked against the authored `codeSyntax.WEB` mappings when they exist - the
file's own variables and, for cross-library bindings, the synced libraries' (scoped to the
libraries the compared subtrees actually reference; ambiguous names and alias tiers across the
library boundary never gate):
a DOM custom property that exactly matches the bound variable's authored name (and no other
variable mints that name) passes outright, and one that is the authored name of a DIFFERENT,
non-alias-related variable becomes `semantic-diverged` - the one review row that blocks even when
the two hexes match, because the wiring itself was measured against the DS's own mapping and
diverged. Everything without such evidence keeps the value-based rule below. This evidence lives
in the variables payload, so it is only as available as the fetch that carries it.

Colors are enriched from the file's variables, and that fetch is the slowest thing this tool does on
a large file. When it fails or times out, the run degrades honestly - token rows read as unresolved
and a `confirm_token` blocker appears for every row whose two values did not already match
byte-for-byte (a matched pair stays a visible `review` row without blocking) - and the codeSyntax
evidence above dies with the same fetch - and says so in two places a caller sees: a
`degraded_stages: [{ stage, reason, ms, detail }]` key, and one `ℹ️` line in `report_markdown`. `ms`
is the point. Measured on this transport, that one endpoint took 90 seconds of a 93-second call, and
without it the caller has a two-minute silence and no way to tell a slow call from a hung one.

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
| `exclude_regions` | string[] | Frame regions to EXCLUDE from the coverage demand - up to 50 ids per call (chrome outside your task: page footer, global tabs). An excluded region stops being demanded as uncovered, the receipt lists it under `frame_coverage.excluded` and the report prints "excluded by the caller", and any measurement from a pair you submitted inside it still counts - exclusion can never hide a measured fail. What is NOT demanded is the excluded container's own derived between-children audit: excluding a container renounces its internal spacing question along with the rest of its scope. Ids that match no coverage region come back loud in `excluded_not_found`. Meaningful only together with `frame_node_id`. Exclude ONLY what is outside YOUR task. |
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
        "children": [ { "kind": "text", "rect": { "x": 16, "y": 16, "w": 288, "h": 24 }, "text": "Product card" } ]
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
