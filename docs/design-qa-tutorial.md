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

All node ids, file keys and selectors below are neutral examples. The scenario: a `Product card`
frame in Figma, rendered on a page as `.product-card`, driven from an agent that also controls a
browser (e.g. via chrome-devtools MCP).

The comparison is **deterministic**: it diffs numbers projected from the Figma REST API against
numbers computed from the live DOM. No screenshots are compared, no model judgement is involved in
a `pass`/`fail` row.

> Complementary tool: to *implement* the node in the first place (auto-layout, fills, tokens,
> component structure), use [`get_design_context`](tools/navigation.md#get_design_context). The
> comparison tools verify the result; `get_design_context` describes the source.

## Step 1 — pick the breakpoint frame

Your page is rendered at some viewport width; Figma usually has one frame per breakpoint. Rank the
variants by how close their **content** width is to your render width:

```json
// find_breakpoint_variant
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "query": "product card",
  "render_width": 1280
}
```

Take the best match (say `12:340`, "Desktop", width 1280) and resize the browser viewport to that
width. Passing this id later as `frame_node_id` arms the **viewport guard**: if the window and the
frame disagree, size rows are demoted to `unchecked` with a `fix_viewport` action instead of
producing false reds.

## Step 2 — capture both sides

One call projects the Figma side and hands you the DOM extractor:

```json
// get_layout_spec
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "node_ids": ["12:340"],
  "include_extractor": true,
  "max_depth": 4
}
```

The response contains:

- `specs[]` — the diff-ready Figma projection (rects, auto-layout axis/gap/padding, children
  geometry, typography, fills);
- `extractor_js` — the canonical DOM extractor, schema-versioned with the server. Run it
  **verbatim** in the browser (e.g. chrome-devtools `evaluate_script`). Do not write your own
  `getComputedStyle` walker: the extractor and the server agree on a snapshot schema, and the
  server rejects stale schemas honestly (`extractor_outdated`) instead of diffing garbage;
- `upload_url` (when the server has a public base URL) — the extractor POSTs snapshots there
  directly from the browser and returns a small `snapshot_ref`. You then pass
  `dom_ref: { ref, selector | index }` instead of pasting megabytes of snapshot JSON through the
  MCP wire. Without an upload URL, pass the snapshot object inline — both work.

Capture the frame root (here `.product-card`) so the whole subtree is available for pairing.
`max_depth` applies to **both** sides — remember the value you used.

## Step 3 — build pairs

Hand the frame root and the DOM snapshot to the pair proposer:

```json
// suggest_pairs
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "frame_node_id": "12:340",
  "dom_ref": { "ref": "snap_0f3a…", "index": 0 }
}
```

You get proposed `pairs` (each with a confidence and an `ambiguous` flag), plus honest
`unmatched_figma` / `unmatched_dom` lists. Review the proposals — confirm the high-confidence
ones, resolve ambiguous ones by hand (`get_view` with `view:"skeleton"` helps to see the frame
structure at a glance). Unmatched subtrees are *not* silently skipped: they will resurface in the
verification receipt as uncovered regions if you leave them unpaired.

## Step 4 — compare

```json
// compare_node_to_dom
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "frame_node_id": "12:340",
  "pairs": [
    { "node_id": "12:340", "dom_ref": { "ref": "snap_0f3a…", "index": 0 }, "label": "card root" },
    { "node_id": "12:341", "dom_ref": { "ref": "snap_0f3a…", "selector": ".product-card__title" }, "label": "title" },
    { "node_id": "12:344", "dom_ref": { "ref": "snap_0f3a…", "selector": ".product-card__price" }, "label": "price" }
  ],
  "max_depth": 4
}
```

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
  "frame": { "node_id": "12:340", "width": 1280 },
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
