# What the design-QA diff covers — honestly

`compare_node_to_dom` is deterministic: every claim below is backed by a diff axis in code, and
everything it does NOT measure is flagged in the response (a status row, a coverage hole, or the
report footer) rather than silently passed. The rule the tool lives by: **a green verdict never
includes what wasn't measured** — anything out of reach is surfaced as 👁 unchecked / ⚠️ warn /
ℹ️ info, and the machine gate `verification.complete` stays `false` until holes are closed or
explicitly inherent.

See the [Design QA tutorial](design-qa-tutorial.md) for the workflow and
[docs/tools/design-qa.md](tools/design-qa.md) for tool parameters.

## Measured deterministically

| Area | What exactly | Notes |
| --- | --- | --- |
| Element geometry | width/height of every paired node | tolerance-gated (`tolerance_px`, default 1) |
| Inter-element spacing | gaps between siblings computed from bounding rects | margin vs padding vs gap vs spacer elements are indistinguishable by design — the rendered distance is compared |
| Container insets | padding of auto-layout containers | border-box aware; insets baked into a child's padding are skipped honestly, not false-failed |
| Cross-axis alignment | offset-cross of each in-flow child | measured on the child's box edges (content alignment inside the child needs its own pair) |
| Structure | child count, single-wrapper auto-unwrap, equal-count child reorder detection | mismatches are ⚠️ warn (pair quality), reorders come with an anchor map |
| Typography | font-size, font-weight, font-family, line-height, letter-spacing, text color | direct TEXT children + auto-descent into containers with several texts; text below the capture cut is flagged 👁 unchecked, never assumed |
| Colors (token-aware) | solid fills and text colors with token provenance on BOTH sides | Figma variable vs DOM CSS-var: hex-match under an unconfirmed mode → `review` (confirm the semantic token), token-vs-hardcoded-literal → ❌ fail even when hexes match; mode-aware resolution with graph + snapshot fallback |
| Borders | border-color + border-width on the pair root | per-side asymmetries and partial borders (Figma stroke is whole-perimeter) → ⚠️ warn, not silence |
| Shadows | the FIRST box-shadow: x/y/blur/spread/color/inset | spread is a regular axis (Figma REST provides it); >1 shadow → ⚠️ warn `"the shadow list was not matched (single-shadow-first) — verify visually"` |
| Corner radius | one uniform px corner radius | the DOM side yields ONE comparable px number or it says so: all four CSS corners equal **and** a px length → diffed as that number (including the exponent form, which is not a size threshold but Chrome's six-significant-digit serialization: measured, `999999.4px` reads back as `999999px`, and `999999.5px` — seven digits once rounded — as `1e+06px`); **anything else the browser computed** → 👁 unchecked, never a pass (see limits). The corners are compared as strings rather than parsed values, because `parseFloat('8px 4px')` is 8 and would read an 8×4 ellipse as a circle. The one silence left is an empty computed value: nothing was computed, so no number and no row |
| Gradients | kind (linear/radial/conic), per-stop colors and positions (equal stop counts), linear angle (±3°), token provenance per stop and whole | radial/conic geometry is NOT measured — flagged 👁 unchecked (see below); unequal stop counts → ⚠️ warn, no guessed matching |
| Opacity | node opacity | delta-gated like other numeric axes |
| Component identity | DS component detection from class/data tokens vs Figma component-set name; explicit `expected_component` | **warn-only** — it is a heuristic, never a ❌ fail |
| Overlay width | fixed-width overlays via `expected_overlay_width` | ℹ️ info row (app vs overlay width), viewport guard decoupled |
| Between-children spacing audit | gaps inside containers that have no pair of their own | works only when the adjacent pairs came through `dom_ref` of ONE batch (one extractor POST = one layout state). Inline `dom` or mixed refs → the gap is honestly `unchecked`, so **on stdio this channel never verifies a gap at all** — add a container pair there instead of waiting for it |
| Verification receipt | `verification.complete` machine gate, frame coverage enumeration, blocking actions | `complete:true` is the only "verified" — everything else enumerates exactly what remains |

## Verify visually (the tool flags these, it does not measure them)

| Area | How it is flagged |
| --- | --- |
| Icon glyphs (WHICH icon is drawn; box size/position ARE measured) | listed in the report footer as not covered by the tool (`not_covered_by_tool: ['icons']`) |
| Radial/conic gradient geometry (center/radius/shape/rotation) | dedicated 👁 unchecked `gradient-geometry` row — counted as a coverage hole, blocks terminal green |
| Second and further background layers | only the first layer is compared; a `gradient-layers` ℹ️ info row surfaces both sides |
| Multi-shadow stacks (>1 shadow) | ⚠️ warn `"the shadow list was not matched (single-shadow-first) — verify visually"` |
| Raster effects (layer blur, background blur) | not projected at all — only DROP_SHADOW/INNER_SHADOW reach the diff |
| Image/video fill CONTENT (the pixels) | node geometry is measured; content is not compared — image-like layers are counted into the multi-layer flag |
| Animations / transitions | the workflow disables them before capture (step 2); motion itself is never diffed |
| DOM colors the parser can't read (`oklch()`, `color()`, transparent) | not one bucket: fills, text color and gradient stops get ℹ️ info "DOM color not recognized"; `border-color` and `shadow-color` get ⚠️ warn, because there exactly one side produced a color and the axis is unmatched rather than merely unparsed |
| Rotated nodes / `transform ≠ none` | environment 👁 unchecked with the reason (AABB unreliable / wait out the animation) |
| Content alignment INSIDE a paired child | offset-cross measures box edges; add a pair on the child itself |

## Known limits

| Limit | Behavior |
| --- | --- |
| Figma Variables REST is Enterprise-only | without it, token names come from the style/variable graph or an ingested plugin snapshot; colors still diff by value with honest `review` provenance |
| Huge files can return `400 Request too large` from `/variables/local` (no pagination upstream) | the resolver falls back to the graph/snapshot path; token semantics get `review` (confirm under mode) instead of a false verdict |
| Files with "disable copying/exporting/sharing" | Figma REST (and plugins) are blocked entirely — headless-irreducible until the owner lifts the restriction |
| `max_depth` capped at 8 (both the Figma projection and the DOM extractor) | anything deeper is flagged (`raise_max_depth` / `add_text_pair` blocking items, enumeration caveats) — never silently assumed verified |
| Viewport must match the frame width | otherwise every geometry row is 👁 unchecked via the viewport guard and each pair gets a `fix_viewport` blocking item. The guard fires whenever the ABSOLUTE difference between the window's `innerWidth` and the frame width exceeds `max(24, 5% of the frame width)`, and it is SYMMETRIC: a wider window is refused exactly like a narrower one, centered layout or not (see `mcp-server/src/domain/layout-spec/diff.ts`, `Math.abs(d.innerWidth - opts.frameWidth)`). `expected_overlay_width` overrides it, and it does more than silence the guard: on EVERY pair it also demotes any `size.w` ❌ fail to 🟰 demoted and strips that row's `fix_plan` edit address. What replaces the width signal is a single `overlay_width` row — ℹ️ info within tolerance, ⚠️ warn outside it, never a fail — and neither status can become a blocking item, so a wrong `expected_overlay_width` is reported without ever blocking. The demotions do keep `verification.complete` false, so this is not a false green; it is an incomplete verdict with nothing in `blocking` naming the width. Chrome won't shrink its window below ~500px — use CDP emulation for narrow frames |
| How much DOM one capture may carry | TWO caps bind on every capture, on every deployment, and the node budget is only one of them. **Breadth, which bites first and answers to nothing:** the root keeps its first 30 in-flow children (see `mcp-server/src/adapters/driving/tools/dom-extractor.ts`, `const children = kids.slice(0, 30);`) and every level below it keeps 15 (see `mcp-server/src/adapters/driving/tools/dom-extractor.ts`, `child.children = kids.slice(0, 15);`). No argument and no `max_depth` raises either, and both cut far under any budget. Measured, and the counts below say which side of the capture they describe: a root with 40 flat children — a 41-node DOM tree — comes back as a 31-node SNAPSHOT (the root plus 30 of them), and a child holding 20 grandchildren — a 22-node DOM tree — comes back as a 17-node snapshot (root, child, 15 grandchildren); at those tree sizes the 90-node budget is never in play. **The node budget:** 90 by default, and 180 at `max_depth` 5–8 only if the CALLER passes it, because `budget` is the extractor's 4th positional argument and defaults to 90. `get_layout_spec` prints the 4-argument call form only when `max_depth` was given, so raising `max_depth` while reusing a 1-argument call form silently captures at 90 against a Figma projection that went deeper (the [tutorial](design-qa-tutorial.md) spells the mapping out: `max_depth` 4 → `(3, 90)`, 6 → `(5, 180)`, 8 → `(7, 180)`). Both of these TRIM, and both flag every cut as `childrenTruncated` — never silently dropped — and the fix is a narrower pair, not a bigger request. **Behind them, and reachable by neither: the schema backstop** — a static 300-node ceiling that does not trim but REJECTS the whole snapshot before the diff (see `mcp-server/src/adapters/driving/tools/dom-snapshot-schema.ts`, `snapshot exceeds 300 nodes total`). It binds on no capture this workflow can ask for: `max_depth` is capped at 8 (see `mcp-server/src/adapters/driving/tools/get-layout-spec-tool.ts`, `z.number().int().min(1).max(8).optional()`) and the budget formula yields only 90 or 180 across that whole range (see `mcp-server/src/domain/layout-spec/projector.ts`, `Math.min(caps.totalCeiling, caps.maxTotalNodes * Math.max(1, Math.ceil(maxDepth / 4)))`) — measured, a 481-node DOM tree captured at budget 180 comes back as a 181-node snapshot and parses. It is a schema-level refusal held in reserve against a snapshot the documented budgets cannot produce, not a third cap on the capture. The two trimming caps are what bound a stdio capture; the upload caps below never enter that path |
| Snapshot upload: 2 MB **and** 20 snapshots per POST (HTTP deployments only — stdio has no upload path) | both caps answer `413`, so "split by size" is not the whole rule — a batch of 21 small snapshots is refused too. Split large captures across several POSTs to the same `upload_url` (both limits are per POST, not per session; each POST returns its own `snapshot_ref` with indices restarting from 0). Refs live 30 minutes on a SLIDING TTL under a non-extendable 2-hour ceiling from creation: reading a ref keeps it alive, but nothing keeps it past two hours |
| Radii Figma cannot express: per-corner, `%`, elliptical, browser-unresolved | Figma carries ONE px `cornerRadius`, so a per-corner Figma radius has no axis at all, and on the DOM side any radius that is not a single px number has nothing to be compared against: four differing corners, `border-radius: 50%`, an elliptical `8px / 4px`, or a value the browser leaves unresolved (`calc()`, `min()`, `max()`, `clamp()` carrying a percentage — all four survive computation verbatim, and all four paint a real corner). Every one of them produces a 👁 unchecked `corner-radius` row with a `resolve_skip` blocking item — never a pass, and never a fail either, because the diff cannot say which corner or which axis is off. Verify by eye. (Each was measured returning a green verdict first: `50%` on a 300×20 box shipped `50` and passed a Figma `cornerRadius` of 50 while the real corners are 150px and 10px; `clamp(4px, 10%, 12px)` emitted nothing at all and returned `verification.complete: true` with an empty `blocking` over a corner that is visibly rounded.) |
| `find_nodes` search coverage | `coverage.skipped ≠ []` means "not found ≠ doesn't exist" — follow up with scoped calls; absence is only trustworthy when `searched === total` |
| Nodes without auto-layout | no inter-element metrics exist — ⏭ skip (inapplicable), stated in the row |
| Scroll containers | frame height is uninformative — ⏭ skip with the reason |

## Reading the flags

- ❌ fail — a real measured delta above tolerance.
- ⚠️ warn — needs judgment (pair quality, heuristics, unmatched lists).
- ℹ️ info / `review` — diagnostic or semantic-confirmation rows (token provenance).
- 🟰 demoted — structurally explained non-defect (hug/fill, spacers), still visible.
- 👁 unchecked — NOT reached; verify by eye or fix the environment. Never counts as green.
- ⏭ skip — nothing to compare (inapplicable axis). Reads clean.

The single machine answer to "is it verified?" is `verification.complete` — see the
[agent skill](agents/design-qa-skill.md) for the full gate protocol.
