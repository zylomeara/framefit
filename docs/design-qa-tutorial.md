# Design QA tutorial: verifying a rendered page against Figma

This walkthrough shows the full design-QA cycle with the five tools from
[docs/tools/design-qa.md](tools/design-qa.md):

1. [Pick the breakpoint frame](#step-1--pick-the-breakpoint-frame)
2. [Capture both sides](#step-2--capture-both-sides) (`get_layout_spec` + the DOM extractor)
3. [Build pairs](#step-3--build-pairs) (`suggest_pairs`)
4. [Compare](#step-4--compare) (`compare_node_to_dom`)
5. [Read the verification receipt](#step-5--read-the-verification-receipt) — the machine gate
6. [Navigate to the code](#step-6--navigate-to-the-code-source-hints-and-fix_plan) (source hints + `fix_plan`)
7. [Strictness profiles](#step-7--strictness-profiles)
8. [What the tool does not check](#step-8--what-the-tool-does-not-check)

All node ids, file keys and selectors below are neutral examples, and they are the same ones the
[tool reference](tools/design-qa.md) uses, so the two pages describe one file. The scenario: a
`Product card` frame in Figma, rendered on a page as `.card`, driven from an agent that also
controls a browser (e.g. via chrome-devtools MCP).

Every request example below is tagged `jsonc` rather than `json`: each opens with a `// <tool>` line
naming the tool to call it on, and the DOM snapshots in steps 3 and 4 are trimmed with `/* ... */`
markers. Drop the comments before sending one — nothing in them belongs to the argument object.

The comparison is **deterministic**: it diffs numbers projected from the Figma REST API against
numbers computed from the live DOM. No screenshots are compared, no model judgement is involved in
a `pass`/`fail` row.

> Complementary tool: to *implement* the node in the first place (auto-layout, fills, tokens,
> component structure), use [`get_design_context`](tools/navigation.md#get_design_context). The
> comparison tools verify the result; `get_design_context` describes the source.

## Step 1 — pick the breakpoint frame

Your page is rendered at some viewport width; Figma usually has one frame per breakpoint. Rank the
variants by how close their **content** width is to your render width:

```jsonc
// find_breakpoint_variant
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "query": "product card",
  "render_width": 320
}
```

Take the best match — here the content frame `12:340` (`Product card`, 320 wide) inside the
`Desktop` variant `12:300` — and resize the browser viewport to that width. Passing this id later as
`frame_node_id` arms the **viewport guard**: if the window and the frame disagree, size rows are
demoted to `unchecked` with a `fix_viewport` action instead of producing false reds.

## Step 2 — capture both sides

One call projects the Figma side and hands you the DOM extractor:

```jsonc
// get_layout_spec
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "node_ids": ["12:340"],
  "include_extractor": true,
  "max_depth": 4
}
```

On the stdio server the [quickstart](../README.md#quickstart) installs, this call comes back with
`file`, `snapshot_schema`, `specs`, `hydration`, `extractor_js` and `extractor_note`:

- `specs[]` — the diff-ready Figma projection (rects, auto-layout axis/gap/padding, children
  geometry, typography, fills);
- `extractor_js` — the canonical DOM extractor, schema-versioned with the server. It is an **async
  function expression, not a script**: it begins
  `async (selectors, uploadUrl, depthLeft = 3, budget = 90) => {`. Evaluated as it stands it yields
  a function object and captures nothing, and handing it to chrome-devtools `evaluate_script` on its
  own calls it with no arguments, which throws a `TypeError` on the missing `selectors`. Wrap it in
  a thunk that names every selector and awaits the call:

  ```js
  async () => {
    const extract = <extractor_js VERBATIM>;
    return await extract([".card", ".card__title", ".card__price"]);
  }
  ```

  `extractor_js` goes into that one slot verbatim, and on stdio that is the whole inline script —
  tens of kilobytes of it, which is more than you want to repeat per capture. **Paste it once and
  keep the handle**: send one `evaluate_script` whose whole body is
  `window.__extract = <extractor_js VERBATIM>;`, and every capture after that is the short
  `async () => await window.__extract([".card", ".card__title", ".card__price"])`. The handle lives
  on the page, so a reload or a navigation drops it and you paste again. Do not write your own
  `getComputedStyle` walker instead: the extractor and the server agree on a snapshot schema, and the
  server rejects a stale schema honestly (`extractor_outdated`) rather than diffing garbage;
- `extractor_note` — `loader unavailable without public base URL — inline returned`. A loader is what
  `extractor_mode` asks for by default, and it degrades to the inline script whenever the server has
  no public base URL to point a browser at
  (see `mcp-server/src/adapters/driving/tools/get-layout-spec-tool.ts`, `useLoader = extractorMode === 'loader' && !!deps.publicBaseUrl`).

That key list is this call's, not the tool's: `extractor_mode: "inline"` returns no `extractor_note`
(nothing degraded — you asked for inline), and `text_leaves: true`, or a `node_ids` entry the file
does not hold, returns no `hydration`. What a stdio response never carries is an `upload_url` or an
`upload_hint`.

> **An HTTP deployment has two things stdio does not, and both come from the public base URL.**
> First, the loader actually loads: `extractor_js` comes back as a short thunk that fetches the
> versioned script from the server (`GET /api/dom-snapshots/extractor.js`), so nothing large is
> pasted at all — and `extractor_mode: "inline"` forces the full script back when you want it (the
> loader injects a script tag, which a strict CSP will block). Second, `get_layout_spec` also returns
> an `upload_url`: the extractor POSTs the snapshots there straight from the browser, returns a short
> `{snapshot_ref, summaries}` in their place, and you pass `dom_ref: { ref, selector | index }`
> wherever this page passes a snapshot object. That second path needs the DOM-snapshot store, which
> only the HTTP server paths construct, so on stdio it is not the other of two working options:
> `suggest_pairs` fails outright with `snapshot store unavailable on this server — pass dom_snapshot
> inline`, and `compare_node_to_dom` puts a `snapshot_ref` `warn` row and a `re_extract_dom` blocking
> item on the pair and measures nothing.

**Call the extractor once with every pair's selector, and hand `snapshots[i]` to `pairs[i].dom`.**
With no upload URL the extractor returns a plain array — one snapshot per selector, in selector
order — while `compare_node_to_dom` takes exactly one snapshot object per pair. So capture all three
selectors step 4 declares pairs for, in the order it declares them: the frame root `.card` first
(that snapshot carries the whole subtree, which is what step 3 needs), then `.card__title`, then
`.card__price`. Capture the frame root alone and `snapshots[1]` and `snapshots[2]` are `undefined`,
leaving two of the three pairs with nothing to pass. Under the inline form there is no
`dom_ref.selector` resolved against the snapshot, so the question of which nesting level a selector
addresses does not arise here.

`max_depth` applies to **both** sides — remember the value you used. These examples pass
`max_depth: 4`, which is exactly what the extractor's own defaults capture, so the two-argument call
is enough. Raise it and that stops holding: nothing tells the extractor the new depth, so pass it
yourself as the third and fourth arguments — `extract([...], undefined, depthLeft, budget)` — with
`depthLeft = max_depth - 1` and `budget` from the server's own mapping: `max_depth` 4 gives
`(3, 90)`, 6 gives `(5, 180)`, 8 gives `(7, 180)`. Re-running the two-argument call after raising
`max_depth` captures the DOM three levels deep against a Figma projection that went deeper — which
is the trap waiting for anyone working step 5's `raise_max_depth` action.

## Step 3 — build pairs

Hand the frame root and the DOM snapshot to the pair proposer:

```jsonc
// suggest_pairs
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "frame_node_id": "12:340",
  "dom_snapshot": {
    "schema": 5,
    "status": "ok",
    "selector": ".card",
    "innerWidth": 320,
    "rect": { "x": 0, "y": 0, "w": 320, "h": 420 },
    "borders": { "top": 0, "right": 0, "bottom": 0, "left": 0 },
    "paddings": { "top": 16, "right": 16, "bottom": 16, "left": 16 },
    "scroll": { "top": 0, "left": 0 },
    "componentHints": { "tag": "div", "classList": ["card", "ProductCard_card__e4f5a6"], "data": {} },
    "children": [
      { "kind": "element", "tag": "h3", "classList": ["card__title", "ProductCard_title__a1b2c3"],
        "path": "> :nth-child(1)", "rect": { "x": 16, "y": 16, "w": 288, "h": 24 } /* ... */ }
      /* ... then the price element and the list */
    ]
    /* ... */
  }
}
```

That object is `snapshots[0]`, the frame-root snapshot the extractor printed, **trimmed to fit this
page** — paste yours whole. `paddings` is not decoration: a snapshot missing it makes the diff report
`extractor_outdated` and raise an `update_extractor` blocking item, so a hand-shortened snapshot has
the tool telling you to repair an extractor that is fine.

You get proposed `pairs` (each with a confidence and an `ambiguous` flag), plus honest
`unmatched_figma` / `unmatched_dom` lists. Review the proposals — confirm the high-confidence
ones, resolve ambiguous ones by hand (`get_view` with `view:"skeleton"` helps to see the frame
structure at a glance). Unmatched subtrees are *not* silently skipped: they will resurface in the
verification receipt as uncovered regions if you leave them unpaired.

## Step 4 — compare

```jsonc
// compare_node_to_dom
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "frame_node_id": "12:340",
  "pairs": [
    { "node_id": "12:340", "label": "card root",
      "dom": { "schema": 5, "selector": ".card", "innerWidth": 320,
               "rect": { "x": 0, "y": 0, "w": 320, "h": 420 },
               "paddings": { "top": 16, "right": 16, "bottom": 16, "left": 16 } /* ... snapshots[0] */ } },
    { "node_id": "12:341", "label": "title",
      "dom": { "schema": 5, "selector": ".card__title", "innerWidth": 320,
               "rect": { "x": 16, "y": 16, "w": 288, "h": 24 },
               "paddings": { "top": 0, "right": 0, "bottom": 0, "left": 0 } /* ... snapshots[1] */ } },
    { "node_id": "12:344", "label": "price",
      "dom": { "schema": 5, "selector": ".card__price", "innerWidth": 320,
               "rect": { "x": 16, "y": 52, "w": 288, "h": 20 },
               "paddings": { "top": 0, "right": 0, "bottom": 0, "left": 0 } /* ... snapshots[2] */ } }
  ],
  "max_depth": 4
}
```

Every `dom` here is the matching `snapshots[i]` cut to its first few keys; pass each one whole, in
the order the extractor returned them. `innerWidth` must equal the frame's width — 320 for `12:340`
— or the viewport guard turns every geometry row `unchecked` and adds a `fix_viewport` blocking item
per pair.

Each pair yields rows `{ prop, figma, dom, delta, status }`. Row statuses:

| Status | Meaning |
| --- | --- |
| `pass` | Measured, within tolerance |
| `fail` | Measured, out of tolerance — a real diff |
| `warn` | Suspicious but not provably wrong (e.g. component identity hints) |
| `review` | A token-name divergence a human/agent must judge (see below) |
| `skip` / `unchecked` | Could not be measured in this environment — with the reason attached |
| `info` / `demoted` | Measured, but a known legitimate cause downgraded it (e.g. hug/fill sizing, viewport mismatch) |

Abridged sanitized output:

```jsonc
{
  "tolerance_px": 1,
  "frame": { "node_id": "12:340", "width": 320 },
  "pairs": [
    {
      "node_id": "12:341", "label": "title",
      "rows": [
        { "prop": "size.w",             "figma": 288, "dom": 288, "delta": 0,   "status": "pass" },
        { "prop": "font-size[title]",   "figma": 16,  "dom": 16,  "delta": 0,   "status": "pass" },
        { "prop": "font-weight[title]", "figma": 600, "dom": 400, "delta": 200, "status": "fail" }
      ],
      "summary": { "pass": 2, "fail": 1, "warn": 0, "skip": 0, "info": 0, "demoted": 0, "unchecked": 0, "review": 0 },
      "coverage": { "measured": ["size", "typography"], "skipped": [] },
      "source": {
        "root": { "module": "ProductCard", "local": "title", "file": "ProductCard.module.css" }
      },
      "fix_plan": [
        {
          "target": { "module": "ProductCard", "local": "title", "file": "ProductCard.module.css" },
          "channel": "root",
          "edits": [
            { "prop": "font-weight[title]", "kind": "property", "expected": 600, "actual": 400, "delta": 200 }
          ]
        }
      ]
    }
    /* … more pairs … */
  ],
  "verification": { /* see step 5 */ },
  "not_covered_by_tool": ["icons"],
  "report_markdown": "…ready-to-paste verification block…"
}
```

`report_markdown` is a ready verification block you can paste into a PR description. It is headed
by `Verified against Figma`; per-row lines read `Figma X / DOM Y`, and fix suggestions sit under
`Edits:`. The machine-readable `pairs[].rows` carry the same data in structured fields.

**Token `review` rows.** When both sides bind a color to a design token but the token *names*
differ, the row is `status:"review"` and carries both names. The tool does not guess: you judge.
Same concept under different spelling → resolved; clearly different concepts (error vs success) →
report as wrong; cannot tell (possible rename) → escalate as unsure. A `review` row keeps the
verdict non-green until resolved — but a textual name difference alone is never auto-reported as a
defect.

## Step 5 — read the verification receipt

The `verification` object is the machine gate — read it instead of eyeballing rows:

```jsonc
{
  "verification": {
    "complete": false,
    "scope": "frame",
    "pairs": { "checked": 3, "clean": 2 },
    "frame_coverage": { "covered": 4, "total": 5 },
    "blocking": [
      { "kind": "uncovered_region", "node_id": "12:349", "action": "add_pair",
        "detail": "frame region unpaired — the region's layout is not verified" },
      { "kind": "children_truncated", "node_id": "12:344", "action": "raise_max_depth",
        "detail": "the tail of children beyond the cap/depth was not checked (childrenTruncated at the pair level or deeper)" }
    ]
  }
}
```

- `complete: true` is the **only** green signal: nothing failed, nothing was left unmeasured, and
  (when `scope:"frame"`) every worthy frame region was covered by an effective pair. Do not report
  a page as verified while `complete` is `false`.
- `scope: "pairs"` means only the submitted pairs were checked — **not** the whole screen.
  Passing `frame_node_id` upgrades the scope to `"frame"` and adds coverage accounting.
- `blocking[]` lists only *actionable* next steps, each with a machine token in `action`:
  `add_pair` / `add_pairs_on_children` / `add_text_pair` / `add_container_pair` (cover a region),
  `raise_max_depth` (a branch was cut), `re_extract_dom` / `update_extractor` (snapshot problems),
  `fix_pair` (selector matched nothing/multiple), `fix_viewport` (window ≠ frame width),
  `confirm_token` (judge a token `review` row), `resolve_skip`, `run_token_aware` (you finished on
  a scope-narrowed profile — see step 7).
- The receipt is budget-honest: if the blocking list is truncated, `blocking_capped` says how many
  items were cut and `complete` stays `false` — nothing green is ever produced by truncation.

Work the loop: execute the blocking actions (add pairs, raise depth, fix the viewport…), re-run
the compare, repeat until `complete: true`.

## Step 6 — navigate to the code: source hints and fix_plan

When the DOM uses CSS modules, class names carry a deterministic file address
(`ComponentName.module.css` → local class). The differ surfaces this as:

- `pairs[].source` — per-channel hints: `root` (the pair root), `anchor` (the styled wrapper that
  actually carries fills/borders/radius), `children[]` (per gap/offset row), `text[]` (per
  typography row);
- `pairs[].fix_plan` — fail rows regrouped into edit groups per candidate file:

```jsonc
{
  "target": { "module": "ProductCard", "local": "title", "file": "ProductCard.module.css" },
  "channel": "root",
  "edits": [
    { "prop": "font-weight[title]", "kind": "property", "expected": 600, "actual": 400 }
  ]
}
```

`kind: "property"` means "set the literal value" (e.g. `font-weight: 600`); `kind: "layout"` means
"fix the layout *rule*" (gap/flex/width logic) — do not hard-code the pixel number. The `target`
is a **candidate**, not ground truth (module + local class is not globally unique): confirm the
file before editing. A `null` target collects edits whose address could not be derived. Under
transport pressure the plan may be dropped as a whole — then the response carries
`fix_plan_stripped: true` instead of a silently missing plan.

## Step 7 — strictness profiles

`match_profile` sets tolerance and scope in one word:

| Profile | Tolerance | Scope |
| --- | --- | --- |
| `token-aware` (default) | `tolerance_px` default 1 | Everything: geometry, typography, colors (token-resolved), component identity |
| `strict` | 0 (exact after 0.05px rounding); an explicit `tolerance_px > 0` is rejected | Same full scope |
| `layout` | `tolerance_px` default 1 | Only visual geometry — typography/colors/styles/component are consciously out of scope |

`layout` is for fast iteration on spacing. It cannot produce a final verdict: the receipt carries
the profile you used (`verification.match_profile`), profile-skipped axes are marked distinctly
from environment skips, and a `scope_incomplete` blocking item with `action: "run_token_aware"`
reminds you to finish with a full-scope run.

## Step 8 — what the tool does not check

The response says so itself: `not_covered_by_tool: ["icons"]`. Icon glyphs (and any purely
pictorial content) are not metrically diffed — verify them visually, e.g. with
[`get_screenshot`](tools/navigation.md#get_screenshot) `return=preview` next to the rendered page.
Decorative leaf nodes (backgrounds, dividers, vector glyphs) are covered by their container's
geometry rather than flagged as missing pairs.

Everything else that could not be measured is *reported*, not guessed: that is the receipt's job.
The rule of thumb — trust `complete: true`, act on `blocking`, and never treat a truncated or
scope-narrowed run as a green verdict.
