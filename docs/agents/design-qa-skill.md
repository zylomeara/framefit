---
name: figma-design-qa
description: Deterministic metric verification of a rendered UI against its Figma design in one pass — invoke BEFORE declaring any UI task with a design reference "done", and whenever asked to "check against the design", "verify spacing/typography against Figma", or run a design review. Diffs numbers (gap/padding/sizes/typography/colors/component identity) via framefit compare_node_to_dom plus a browser DOM snapshot; replaces manual getComputedStyle measurement and comparing values "in your head".
---

# figma-design-qa: metric Figma ↔ DOM verification

> **Installation.** Copy this file to `.claude/skills/figma-design-qa/SKILL.md` in your project
> (Claude Code discovers skills there automatically), or paste the body into your agent's system
> instructions. Prerequisites: the framefit server connected over MCP, plus a browser-automation
> MCP — the workflow below uses chrome-devtools tool names (`evaluate_script`, `resize_page`,
> `emulate`, `wait_for`).

The tool compares NUMBERS, not screenshots: inter-element distances are computed from geometry
(bounding rects), so margin vs padding vs gap vs spacer elements make no difference — the rendered
result is what gets caught. Your single responsibility is correct PAIRS of node_id ↔ CSS selector.
Everything else is deterministic.

Text this page shows as a VERBATIM quote of what the server prints is written as a double-quoted
string inside a code span, with angle brackets marking an interpolated value — string-match on those.
Every one of them is checked against the string the code emits (`docs-complete-lists.test.ts`).

## Workflow (one pass, ~4–5 calls)

The cycle is stated once, in [`docs/tools/design-qa.md`](../tools/design-qa.md#the-cycle), and the
steps below are that cycle plus the branch cases you need while running it — that page is the
definition, this one is the operating detail. The mapping is exact: its step 1
(`find_breakpoint_variant`) is folded into Step 2 here, its step 2 (`get_layout_spec`) is Step 1
here, its step 3 (run the extractor in the browser) is Step 3, its step 4 (`suggest_pairs`) is the
first entry under [Finding pairs](#finding-pairs--when-you-dont-know-node_id) below — that is where
the code puts it, as the answer to an unknown node_id and never as a gate on the compare — and its
step 5 (`compare_node_to_dom`) is Step 4.

### Step 0 — bring the UI into the design's state
- Open the target screen/drawer/overlay (elements must be in the DOM and visible).
- Set component states to match the frame: checked/hover/disabled.
- Wait for readiness (`wait_for` on a key selector).

### Step 1 — Figma side: get_layout_spec
Pick the design frame for the current breakpoint (mobile frame for a mobile render).
Call `get_layout_spec` with the node_ids under check + the frame id, `include_extractor: true`:
- you get diff-ready specs (children structure — eyeball it: did you grab the right nodes?);
- the frame width (`specs[].spec.rect.w` on the frame);
- `extractor_js` — the canonical DOM extractor, schema-versioned with the server.

### Step 2 — viewport and stabilization
- `resize_page` to the frame width (otherwise geometry rows come back 👁 unchecked via the
  viewport guard). Chrome will not shrink the WINDOW below ~500px — for narrow frames use
  `emulate` (CDP).
- **Fixed-width overlays (drawers/modals)**: pass `expected_overlay_width:
  <content-frame width>` to compare — size.w stops false-failing (becomes info), the
  `overlay_width` row carries both widths and their Δ (app 390 vs overlay 400, Δ10 within
  tolerance) as a positive signal, and you can KEEP `frame_node_id` (the viewport guard is decoupled; preflight checks the
  frame against the overlay). The old workaround "omit frame_node_id" is no longer needed.
- **Not sure which variant frame matches your render** (dozens of same-named breakpoint
  variants)? One call `find_breakpoint_variant {file, query: "<screen name>", render_width:
  <render width>}` — returns candidates with CONTENT widths and the best match (a w1280 variant
  whose panel content is w400 matches a 400px render). No node_id needed; on giant files narrow
  the search with `parent_node_id`.
- Kill animations and reset scroll with ONE evaluate_script:
```js
() => {
  const s = document.createElement('style');
  s.textContent = '*{transition:none!important;animation:none!important}';
  document.head.appendChild(s);
  document.querySelectorAll('*').forEach((el) => { if (el.scrollTop) el.scrollTop = 0; if (el.scrollLeft) el.scrollLeft = 0; });
  return 'stabilized';
}
```

### Step 3 — DOM side: one evaluate_script

> **An HTTP deployment has two things stdio does not, and both come from the public base URL.**
> First, `extractor_js` comes back as a short LOADER (~8 lines) that fetches the canonical script
> from the server instead of inlining it. Second, `get_layout_spec` also returns an `upload_url`:
> the extractor POSTs the snapshots there straight from the browser and hands you a SHORT
> `{snapshot_ref, summaries}`, so the full JSON never enters your context. On the stdio server the
> [quickstart](../../README.md#quickstart) installs there is NEITHER — `extractor_js` is the whole
> inline script and the response carries no `upload_url`, so the snapshot comes back to you and you
> pass it inline as `pairs[].dom`. Step 1's response is what tells you which one you are on: an
> `upload_url` key, or none.

The thunk MUST be async/await either way (a sync paste is a silent failure). With an
`upload_url`, pass it as the second argument; on stdio, leave it off:
```js
async () => {
  const extract = <extractor_js VERBATIM>;
  return await extract(["<selector for pair 1>", "<selector for pair 2>"], "<upload_url>");
  // stdio: no second argument — `return await extract(["<selector for pair 1>", …]);`
}
```
On stdio the inline script is tens of kilobytes, which you do not want to repeat per capture:
paste it ONCE — inside a thunk, for the same reason the capture is one. `evaluate_script` CALLS what
you send with no arguments, so a bare `window.__extract = <extractor_js VERBATIM>;` is a SyntaxError
and the same text without the `;` is invoked with no selectors and throws:
```js
() => { window.__extract = <extractor_js VERBATIM>; return 'ok'; }
```
Then every later capture is the short
`async () => await window.__extract(["<selector for pair 1>", …])`. A reload drops the
handle; paste again. Every LATER `get_layout_spec` call in the session then takes
`include_extractor: false` — the script is already on the page, and re-requesting it is the largest
avoidable cost on this transport. The server says both of these back to you in `extractor_hint`,
returned beside `extractor_js` wherever there is no `upload_url`.
Only where there IS a loader: if it fails with 'extractor script blocked (CSP?)' the page restricts
script-src — re-request `get_layout_spec {include_extractor: true, extractor_mode: "inline"}` and
work with the full inline extractor (everything below stays the same). On stdio you already have it.
Selectors go in the same order as the pairs' node_ids; each must match EXACTLY one element
(`status:'multiple'` → scope it via `:has(...)`/data attributes).
**Validate the pairs BEFORE compare:** with an `upload_url` each selector comes back as a summary
(`rect {w,h}`, `tag.class0`, `childCount`); on stdio you read the same fields off the snapshot
itself. Is it the right element? (a product-card tile ≈ 360×280, expected 5 tiles — childCount 5).
Wrong one → fix the selector and re-run the extractor (the page is open — it's cheap).
`upload_url`, where there is one, is multi-use (30-minute sliding TTL): a multi-screen flow = 1
get_layout_spec → N evaluate_script → N snapshot_ref.

**Fallback when the result carries `upload_error`** (HTTP-only — it presupposes an upload path; the
browser POST did not go through on CSP/network, and the page is still open, so NO re-navigation):
1. Re-run evaluate_script with `filePath: "<local path>.json"` and WITHOUT uploadUrl — the full
   JSON goes to a file, bypassing your context (chrome-devtools only allows filePath into
   workspace roots — write to the repo root and delete afterwards);
2. Upload the file with curl. The endpoint expects a `{"snapshots": [...]}` body; the file saved
   without uploadUrl is a BARE ARRAY — wrap it:
   ```sh
   printf '{"snapshots":%s}' "$(cat snapshot.json)" > body.json
   curl -sS --fail-with-body -X POST "<upload_url>" \
     -H 'Content-Type: application/json' --data-binary @body.json
   ```
   The response `{"snapshot_ref": "...", "selectors": [...], "expires_at": "..."}` — carry
   `snapshot_ref` into compare. Any Content-Type is accepted; a batch over 2 MB **or over 20
   snapshots** is answered 413, so split into several POSTs to the same upload_url — both limits are
   per POST, not per session, and size alone is not the whole rule. Each POST mints its own
   `snapshot_ref`, and `dom_ref.index` restarts from 0 within that ref — track (ref, index) pairs
   per POST, never one ref with global indices. A ref lives 30 minutes on a SLIDING TTL under a
   non-extendable 2-hour ceiling from creation: re-reading it keeps it alive, nothing keeps it past
   two hours.
3. Inline (`dom:` as before) — the last resort where there IS an upload path, and the ONLY path on
   stdio. What is unavailable there is the REF path, not the tools: handed a `dom_ref`,
   `suggest_pairs` throws `"snapshot store unavailable on this server — pass dom_snapshot inline"` and
   `compare_node_to_dom` puts a `snapshot_ref` warn row plus a `re_extract_dom` blocker on that pair.
   Handed an inline snapshot, both run normally on stdio.

### Step 4 — one compare_node_to_dom
```
compare_node_to_dom({
  file: "<file key>",
  frame_node_id: "<frame from step 1>",   // enables the viewport guard
  expected_overlay_width: 400,            // fixed overlay (drawer/modal): see step 2
  pairs: [
    { node_id: "12:340", dom: <snapshot for selector 1>, label: "panel-body" },
    { node_id: "12:341", dom: <snapshot for selector 2>, label: "row-item",
      expected_component: "ds-list-item" },  // optional
  ],
  tolerance_px: 1,
})
```
`dom` is the snapshot OBJECT the extractor returned for that selector, in the order you handed the
selectors in. On stdio this is not a fallback, it is the only option — `dom_ref` needs the snapshot
store, which only the HTTP server paths construct.

**Where there IS an `upload_url`**, pass `dom_ref: { ref: <snapshot_ref>, index: 0 }` instead and
keep the whole snapshot out of your context. **`dom_ref.index` is the recommended key** there: the
selector's position in the array you handed the extractor (0-based; duplicates stay
distinguishable). The `selector: "<string>"` alternative works but must match BYTE-FOR-BYTE and
cannot distinguish duplicate selectors. A ref lives 30 minutes from last access (every compare
extends it) — "saw a ❌, re-read the spec, re-ran the pair" works without re-capturing. Expired →
the report says honestly "re-run the extractor", not a cryptic error.

### Step 5 — report
Paste `report_markdown` from the response INTO YOUR ANSWER AS IS (do not rebuild the table by
hand). Fix the ❌ rows and repeat steps 3–4 for the affected pairs.

### Step 6 — the readiness GATE (`verification`) — BEFORE you say "done"
The response carries a machine `verification { complete, scope, pairs, frame_coverage?, blocking }`.
It is a GATE, not a footnote — do not report "verified against the design / matches the design" until:
- `complete: true` — the check is complete WITHIN scope. Only then say "verified".
- `complete: false` — do NOT say "done". Work through `blocking` (exactly what remains; each item
  is `{ action, node_id|selector, detail }` — perform the `action`, re-run the affected steps).
  These THIRTEEN are every `action` the server can emit, so there is no default branch to write.
  `mcp-server/tests/unit/docs-complete-lists.test.ts` compares the TOKENS that open these bullets
  against the set read out of the server's own source, failing in either direction, and checks every
  `kind` a bullet names against the kinds the code pairs with that bullet's action. It does NOT check
  the prose after the token — that is a claim about meaning, and no cheap check reads meaning, so
  treat a description that contradicts your run as the thing that is wrong:
  <!-- blocking-actions:begin -->
  - `add_pair` / `add_container_pair` — a frame region/container WITHOUT a pair. `add_container_pair`
    arrives under TWO different `kind`s: `unchecked_spacing` (between-children spacing NOT verified —
    the older meaning) and `spacing_mismatch` (the gap WAS measured by the spacing audit and
    DIVERGED — a confirmed defect, not "unverified"; a container pair is needed for authoritative
    confirmation).
  - `add_pairs_on_children` — `structure_mismatch`: add pairs on the node's children (not the wrapper).
  - `raise_max_depth` — truncated / text below the cut: raise `max_depth` (up to 8), re-run steps 3–4.
    For frame ENUMERATION truncation this advice is no longer unconditional: it is emitted only when
    raising max_depth would actually deepen the enumeration (`enumeration: pair_fetch@<8`); on
    `deep@8` / budget/breadth cuts you get an honest caveat in `frame_coverage.enumeration_note`
    instead.
  - `re_extract_dom` / `update_extractor` / `fix_pair` — snapshot/version/node problems: fix the pair's input.
  - `resolve_skip` — environment (viewport/scroll/transform) or a node without auto-layout: fix it or verify by eye.
  - `add_text_pair` — text deeper than max_depth=8: add a pair on the nested TEXT node.
  - `confirm_token` — `unconfirmed_token`: confirm the Figma token in the app. The aggregated entry
    carries `places[]` (ALL nodes with this token/reason; `node_id` is just the first place,
    `places_capped` — how many were cut) — confirm EVERY place in `places`; the reasons in `detail`
    differ (e.g. `not-captured` = the DOM token was not read there).
  - `fix_viewport` — `kind: 'viewport'`: the window width you captured at and the `frame_node_id`
    frame's width disagree, so geometry was demoted to `unchecked` rather than reported as red.
    Resize to the frame's width (or pass `expected_overlay_width` for a fixed overlay) and re-capture
    — do NOT read the demoted rows as passes.
  - `fix_frame_id` — `kind: 'frame_missing'`: `frame_node_id` was given, but no such node exists in
    this file. `scope` still reads `"frame"` and there is NO `frame_coverage` key at all, while
    `complete` is forced `false` — the tool refuses to downgrade a missing frame into a green
    pairs-scope run. A coverage gate that did not run is worse than a red one: re-run step 1 and pass
    the id it returns.
  - `run_token_aware` — `kind: 'scope_incomplete'`: the run used `match_profile: 'layout'`, whose
    scope excludes typography/colors/styles/component. It is inserted as the FIRST blocking item and
    keeps `complete` at `false` by construction — finish with `token-aware` or `strict`. See
    "Strictness profiles" below.
  <!-- blocking-actions:end -->
- `blocking: []` with `complete:false` — only INHERENT items remain: hug/fill demotes, out-of-coverage,
  OR a clean spacing audit (`spacing_audit[].fully_clean` — between-children gaps verified and equal,
  only the container INSETS unverified): there is no automated action — verify those axes BY EYE
  (or add a container pair for a full green) — then you may proceed.
- `frame_coverage` carries enumeration provenance: `enumeration_source`/`enumeration_depth`
  (in the report: `"· enumeration: <source>@<depth>"`, e.g. `· enumeration: deep@8`). `deep` = coverage
  was enumerated from depth 8 regardless
  of your `max_depth` (a free re-slice from the frame cache) — raising `max_depth` for COVERAGE
  is no longer needed (only for the depth of the pairs/text themselves).
- `verification.spacing_audit[]` — between-children gap measurement WITHOUT a container pair: works
  only when the adjacent pairs came through `dom_ref` of ONE batch (one extractor POST = one layout
  state). Inline `dom` or mixed refs → the gap is honestly `unchecked`, so on stdio this channel
  never verifies a gap at all — add a container pair there instead of waiting for it. `gap.status:'fail'` =
  a real gap divergence (verdict: `"discrepancies found"`).
- `scope:"pairs"` (no `frame_node_id`) — ONLY the submitted pairs were checked, NOT the whole screen:
  even `complete:true` here ≠ "screen verified". To gate whole-frame coverage, pass `frame_node_id`.

## Strictness profiles (match_profile)

`compare_node_to_dom` accepts `match_profile: 'strict' | 'layout' | 'token-aware'`
(default `token-aware`) — a named strictness/scope preset for Step 4. A profile NEVER relaxes
verdicts: it either tightens measurement (`strict`), or honestly narrows scope with a MACHINE
honesty gate (`layout`), or names the current behavior (`token-aware`).

| Profile | What is measured | tolerance_px | When to use |
| --- | --- | --- | --- |
| `token-aware` (default) | everything: geometry + typography + colors/styles + component | omitted → 1, an explicit value is respected | the normal "is it done per the design?" check |
| `strict` | same, but tolerance 0 (equality after round1 ≈0.05px) | omitted → 0 WITHOUT error; explicit `>0` → ERROR (see below) | the final pass on pixel-critical screens before "done" |
| `layout` | ONLY visual-geometry axes: size/gap/padding/offset-cross/viewport/overlay_width. Typography/colors/styles/component are out of scope (collapsed into one `⏭` skip covering that family) | same as `token-aware` (omitted → 1, explicit respected) | "skeleton first" — a quick layout check BEFORE fonts/tokens/icons are ready |

**`strict` + `tolerance_px` conflict**: an explicit `tolerance_px > 0` together with
`match_profile: 'strict'` is a VALIDATION ERROR (`isError: true`; the message names the submitted
number and suggests dropping `tolerance_px` or using `token-aware`).
`tolerance_px: 0` with `strict` is NOT an error (an explicit zero does not contradict strict).

**The final-check rule is MACHINE-ENFORCED, not prose**: under `match_profile: 'layout'`
`verification.complete` NEVER becomes `true` — the tool itself inserts a sentinel blocker
`{kind: 'scope_incomplete', action: 'run_token_aware', ...}` as the first element of `blocking`.
This is the SAME Step 6 gate ("don't report done until `complete !== true`") — it keeps working
mechanically, with no separate reminder you could forget: `layout` is an intermediate skeleton
pass; the final "verified against the design" can only come from `token-aware` or `strict`.
`verification.match_profile` in the response is honest provenance for a post-hoc audit
("the final run was non-layout").

`report_markdown` carries the profile in its header (`…, tolerance Npx, profile <name>` — in ALL
modes including the default `token-aware`, not only when passed explicitly); `layout` additionally
prints a warning right under the title that typography/colors/styles are OUT of scope. Profile
skips (axes deliberately excluded by the profile) render as ONE summary `⏭` row
(`"⏭ outside profile scope: <dims> — verify with the token-aware/strict profile"`) — distinguishable
from a regular environmental `⏭` skip, which stays per-row with its own env reason (e.g.
`"scroll container: content height <N>px — comparing the frame height is uninformative"`) and never
carries the `"⏭ outside profile scope"` wording.

⚠️ **RECONNECT NOTE**: `match_profile` and the adjusted `tolerance_px` semantics (now `.optional()`
without a zod default — the default is applied in code AFTER profile parsing) become visible in the
tool's `inputSchema` ONLY after your client reconnects to the MCP server (new session/explicit
reconnect) — a known schema-visibility delay class. If you don't see `match_profile` in the tool
schema — reconnect; do not conclude the parameter is missing or unsupported.

## source → file and line in your repo

Compare pairs may carry `source` — code addresses parsed from CSS-modules class names (works in
PRODUCTION builds too: Turbopack/Webpack keep the module name in the class; no sourcemaps needed —
you do the resolution in your local repo).

**Routing by axis (do NOT take a gap fix to a child's file):**
- gap / offset-cross / spacing BETWEEN children / structure → `source.root` (the CONTAINER's module:
  look for gap/flex/margin);
- size / padding / font of a specific child → `source.children[i]` (i from the `gap[i]`/`offset-cross[i]` row);
- color / border / shadow / radius → `source.anchor` (the style carrier), otherwise root;
- color of nested text → `source.text[label]` (label from the `color[X→"…"]` row).

**Resolution (a candidate set, NOT uniqueness):** glob the module (`fd '<module>'`; a webpack hint
has no extension — try `<module>.module.*`; nothing → `<module>/` as the component directory) →
intersect with `grep -l '\.<local>\b'` → with >1 candidate use co-signals: descriptive
children/anchor modules of the same pair localize the directory (a generic styles.module.scss sits
next to them). The edit line: `.<local>` in the found .module.*; usage: `styles.<local>` in .tsx.
A BEM-modifier local (`preset--bold`) is usually written as NESTING in SCSS
(`.preset { &--bold { … } }`) — a direct grep for `.preset--bold` won't find it: search for the
base before `--` plus the `&--<mod>` suffix. The property may live in a @mixin (`@include link`) —
follow the include; the ABSENCE of the property in the chain is also a diagnosis (the value is
inherited; the fix is an addition). A resolution is NOT confirmed until the file is actually found
and the local exists in it — no "probably".

`source` missing + a `note` — the classes are minified: class-based navigation is unavailable,
search by text/structure. `unpaired` — WHERE an uncovered region lives (investigate), not a fix
address. With equal cardinality `children[]` is attributed POSITIONALLY-BY-GEOMETRY (no content
check) — on same-named repeats (cards) re-verify by rect/text.

A pair may carry a ready `fix_plan` (a markdown block `Edits:` under `code:`) — fail rows already
grouped by candidate file; don't assemble this by hand from fail rows.
`target` in `fix_plan` is the SAME SourceHint candidate as `source` above: the same resolution
procedure is mandatory — "not confirmed until the file is actually found" (a `≈` prefix = candidate,
not truth).
The same edit (prop/expected/actual) in K places of one target = probably ONE reused class
("×K places, check") — a hint, not server-side auto-dedup.
A `layout:` prefix (`kind:'layout'`, gap/size/offset-cross/padding) means "fix the layout RULE",
do NOT hardcode a px literal; `kind:'property'` (color/font/border/…) — set the value as given.

## Finding pairs — when you don't know node_id

0. **The whole frame at once** → `suggest_pairs {file, frame_node_id, dom_snapshot: <the frame-root
   snapshot from step 3>}` — it proposes `node_id` ↔ `dom_path` pairs with a confidence and an
   `ambiguous` flag, and lists `unmatched_figma` / `unmatched_dom` honestly. Confirm the confident
   ones, resolve the ambiguous ones by hand, and go to step 4 with the result. Confirm from the
   receipt on each row, not from the word: `score` below ~46 means no text matched on either side
   (on a frame of containers that is EVERY row — `low` there reports an absence of text, not weak
   geometry), `margin` is the lead over the runner-up, and `figma_rect` vs `dom_rect` + `dom_tag`
   reject a wrong proposal without a browser. `dom_selector` is pasteable into step 4 as it stands —
   against the capture it came from. An `nth-child` chain always resolves to something: navigate or
   re-render in between and it lands on a different element with `status: "ok"`, and step 4 reports
   two unrelated elements as a design defect. Re-capture, or check `dom_rect` against what you are
   about to compare.
   `children_skipped` means the pair was too close to call and its subtree was deliberately NOT
   matched under it — confirm that pair first, then re-run rooted on the element you confirmed.
   On stdio pass the
   snapshot INLINE — handed a `dom_ref` there it throws the snapshot-store refusal quoted in step 3.
   Skip this call entirely when you already know the node ids: it proposes pairs, it does not
   license the compare. The unmatched lists are the same regions the Step 6 receipt will hold you
   to, so reading them early is cheaper than meeting them as `add_pair` blockers.
1. **A node outside the known frame** (typical: a section header, a neighboring block) →
   FIRST `get_node_ancestry {file, node_id: <nearest KNOWN node>}` — returns breadcrumbs up to the
   page and the DIRECT children of every ancestor: the target is usually visible among the
   section's siblings (≤12 light calls, no whole-file fetch). `query` highlights name matches
   within that scope. `ambiguous: true` — the path is unconfirmed (overlays/budget): look at the
   last ancestor's children.
2. **Search by text/name across the whole file** → `find_nodes` without scope; read
   `coverage`: `skipped ≠ []` means "not found" ≠ "doesn't exist" — follow up with scoped calls
   on the skipped containers. `searched === total` — coverage is complete, absence can be trusted
   (within the search depth: nodes deeper than args.depth are unfindable — for very deep trees
   raise depth or narrow the scope).
3. Guessing neighboring ids via `get_metadata` is an anti-pattern — no longer needed.

## Pair quality — BEFORE reading the ❌

A raw ❌ count is meaningful only with correct pairs. First get a structurally clean run, then
read ❌ as defects:
1. `structure_mismatch` or a batch of ❌ on wrapper-level size/padding → the pair was chosen on a
   DOM wrapper (a drawer with its own padding/scroll) or on a bare Figma frame. Descend to the
   content node on both sides and repeat (+1 compare, snapshots are reused).
   **The diff auto-unwraps single wrappers** when child counts differ (an `unwrapped` row in the
   report — the matching became an interpretation, check the chain); if it could not unwrap, the
   structure_mismatch note says `unwrap attempted → rejected: <reason>` — then descend manually
   with a pair.
- a `passes_condensed` row among a pair's rows — bulk-pass rows were folded for the response
  budget: individual pass axes are NOT in rows, take the count from `summary.pass` (signal rows
  fail/warn/info/review/unchecked and meta style_anchor/unwrapped are always complete).
2. Known sources of false ❌ (before tool calibration): a wrapper with its own padding/scroll
   chrome vs the "padding-inner" Figma frame; a scrollbar (~11px in size.w); text node vs frame
   (false padding-end / offset-cross); an inset "baked" into a child's padding that the gap sees
   as 0 (border-box) — the diff SKIPS such deltas.
3. Typography: direct TEXT children are checked as usual, and containers with several texts get
   AUTO-DESCENT — rows like `font-size[chip→"Heading…"]` with a note `"auto-descent: by content"`
   or `"auto-descent: by order"` (content binding is the more reliable). A separate TEXT pair is
   needed ONLY when the descent honestly gave up: warn `typography_descent[...]`
   (`"TEXT descendants remained unpaired (content bijection and ordinal matching did not work)"`)
   OR 👁 unchecked `typography[...]` / `typography_descent[...]` (out of
   reach: text below the capture cut — raise `max_depth` to 8 OR aim a pair lower, e.g. at the
   chip instead of the card).

## How to read statuses
- ❌ fail — a real delta above tolerance. Fix it.
- ⚠️ warn — needs your judgment: `structure_mismatch` (child counts differ — most likely the pair
  is imprecise: take a narrower node/selector), `component` (DS-detection heuristic),
  `snapshot`/`snapshot_schema`.
  **A color with a "do not port the hex" note** — the design color is bound to a token
  (library default mode): a hex mismatch ≠ defect; verify the SEMANTIC token in the app (which
  CSS var/token is applied), not the value.
- ℹ️ info — a reference/diagnostic row, not a defect (`overlay_width` on a fixed overlay carries
  both widths and their Δ — a positive signal).
- 🟰 demoted — would be ❌ but is structurally EXPLAINED (the number is visible, not hidden): a
  `justify-content` spacer distributes free space (the padding edge is informative, not a defect);
  hug-width text (`size.w`/`padding-end` = the text's natural width); fixed-overlay `size.w`.
  NOT a defect on that axis — but not "verified blindly" either. (For FIXED-width text set by the
  designer, width stays an honest ❌, not demoted.)
- 👁 unchecked — there IS something to check but it was NOT REACHED: typography below the capture
  cut (raise `max_depth` to 8 OR add a pair on the nested TEXT) or the environment is not ready
  (viewport≠frame / transform≠none / rotated → fix the window / wait out the animation). NOT
  "all good" — verify by eye. In the summary verdict this counts as `"<N> not verified (out of reach)"`.
- ⏭ skip — there is physically NOTHING to compare (inapplicable): a scroll container (frame
  height uninformative) / a node without auto-layout (no inter-element metrics). Not a defect and
  not "unverified" — reads clean.

**"Is the pair fully verified?"** = `fail===0 && demoted===0 && unchecked===0`. `skip>0` (only
inapplicable axes) does NOT block it. The summary is honest: `🟰N`/`👁N` in the header, and the
verdict line carries `"<N> not verified (demoted)"` / `"<N> not verified (out of reach)"`
⇒ green ≠ everything-visible-verified.
**The machine readiness gate is `verification.complete` (Step 6):** it aggregates this across ALL
pairs AND frame coverage (uncovered regions / unverified between-children spacing / truncation).
Do not report "verified" until `complete !== true` is resolved; on `false` work the `blocking`
list. The summary verdict line degrades too (`CHECK INCOMPLETE…`) — the
terminal `no discrepancies above tolerance` is the green.

## Failure modes
- `not_found`/`multiple`/`hidden` in the snapshot → a bad selector, or the UI state is wrong
  (step 0). Don't invent selectors — take them from the component sources.
- ALL geometry rows 👁 unchecked → almost always viewport ≠ frame width (step 2).
- `structure_mismatch` on wrapper divs → descend the pair one level (the content node, not the
  wrapper).
- A clean number diff (0 ❌) does NOT cancel visual screenshot review where your process requires
  it. The diff covers `border-color`/`border-width` (border color+width, root node), `box-shadow`
  (the first shadow: x/y/blur/spread/color/inset — spread is a regular axis, Figma REST provides
  it), and gradients (kind, per-stop colors/positions, linear angle, token provenance). The diff
  does NOT cover: icon GLYPHS (icon size/position are measured as geometry — but which glyph is
  drawn is not; verify by eye / get_screenshot focus crop), radial/conic gradient GEOMETRY
  (center/radius/shape — flagged 👁 unchecked), second-and-further background layers (only the
  first layer is compared; a `gradient-layers` info row flags the rest), and multi-shadow stacks
  (>1 shadow → `⚠️ box-shadow` `"the shadow list was not matched (single-shadow-first) — verify visually"`).
- offset-cross is measured on the child's BOX edges: internal cross-axis alignment of CONTENT
  inside the child (e.g. text pushed down by the child's own padding) is invisible to the pair's
  diff — check it with a separate pair on that child.
- Children capture is limited to `max_depth` levels below the pair (default 4, cap 8): text below
  the cut signals 👁 unchecked (`typography[...]`/`typography_descent[...]`) — raise `max_depth`
  OR add a deeper pair. If typography is silent AND there is no 👁 row — all visible text within
  the cut was verified.
