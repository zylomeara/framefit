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
| Shadows | the FIRST box-shadow: x/y/blur/spread/color/inset | spread is a regular axis (Figma REST provides it); >1 shadow → ⚠️ warn "matching not attempted" |
| Corner radius | uniform corner radius | all four CSS corners are read: equal → diffed as one number; different → the row is 👁 unchecked, never a pass (see limits) |
| Gradients | kind (linear/radial/conic), per-stop colors and positions (equal stop counts), linear angle (±3°), token provenance per stop and whole | radial/conic geometry is NOT measured — flagged 👁 unchecked (see below); unequal stop counts → ⚠️ warn, no guessed matching |
| Opacity | node opacity | delta-gated like other numeric axes |
| Component identity | DS component detection from class/data tokens vs Figma component-set name; explicit `expected_component` | **warn-only** — it is a heuristic, never a ❌ fail |
| Overlay width | fixed-width overlays via `expected_overlay_width` | ℹ️ info row (app vs overlay width), viewport guard decoupled |
| Between-children spacing audit | gaps inside containers that have no pair of their own | requires adjacent pairs from ONE snapshot batch; otherwise honestly `unchecked` |
| Verification receipt | `verification.complete` machine gate, frame coverage enumeration, blocking actions | `complete:true` is the only "verified" — everything else enumerates exactly what remains |

## Verify visually (the tool flags these, it does not measure them)

| Area | How it is flagged |
| --- | --- |
| Icon glyphs (WHICH icon is drawn; box size/position ARE measured) | listed in the report footer as not covered by the tool (`not_covered_by_tool: ['icons']`) |
| Radial/conic gradient geometry (center/radius/shape/rotation) | dedicated 👁 unchecked `gradient-geometry` row — counted as a coverage hole, blocks terminal green |
| Second and further background layers | only the first layer is compared; a `gradient-layers` ℹ️ info row surfaces both sides |
| Multi-shadow stacks (>1 shadow) | ⚠️ warn "shadow list matching not attempted" |
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
| Snapshot upload: 2 MB **and** 20 snapshots per POST | both caps answer `413`, so "split by size" is not the whole rule — a batch of 21 small snapshots is refused too. Split large captures across several POSTs to the same `upload_url` (both limits are per POST, not per session; each POST returns its own `snapshot_ref` with indices restarting from 0). Refs live 30 minutes on a SLIDING TTL under a non-extendable 2-hour ceiling from creation: reading a ref keeps it alive, but nothing keeps it past two hours |
| Per-corner asymmetric radii | the Figma side carries ONE `cornerRadius`, so a per-corner Figma radius has no axis at all. The DOM side reads all four CSS corners: when they differ there is no number to compare against, so the `corner-radius` row is 👁 unchecked with a `resolve_skip` blocking item — it can no longer pass, but the diff still cannot tell you which corner is wrong; verify by eye |
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
