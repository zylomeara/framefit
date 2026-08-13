# Changelog

This file starts at 0.13.0. Versions are the `framefit` package version, which is also what the MCP
handshake reports as `serverInfo.version` and what `framefit status` prints in its header.

## 0.28.0

Two threads. First, a live re-check of 0.27.0's alignment work found the one interplay it had
missed: the justify-content demote's free-space evidence did not see the spacer folds shipped in
the same release, so a spacer-encoded inset could read as distributable slack and mask a real
alignment defect behind an encoding demote - fixed, with the fold now carried into the evidence
and named in the row's caveat. Second, the cross-axis ceiling documented in 0.27.0 ("cross-axis
alignment is not compared") is replaced by a measured comparison: a design that encodes a cross
inset by centering a content-height child no longer goes red against a DOM that encodes the same
inset as a stretched wrapper - and proving that honestly required the DOM snapshot to stop
conflating "paints nothing" with "paints something the extractor cannot read", which is a wire
format change.

**Snapshot schema v7 - re-capture required.** A v6 (or older) snapshot is rejected with an
actionable remedy: the compare tools return a `snapshot_schema` warning row, while `suggest_pairs`
returns an actionable error. On the loader path an open page keeps serving its cached old extractor,
so use `get_layout_spec {include_extractor:true, extractor_mode:"inline"}`, or reload the page
before requesting the loader again. The v7 DOM-snapshot contract enforced by three tools changed
with it (`compare_node_to_dom`, `compare_dom_to_dom`, `suggest_pairs`); `get_layout_spec` is the
surface that supplies the extractor. A client that never re-lists tools keeps reading the 0.27.0
entries; reconnect after upgrading.

### Added

**Cross-axis encoding demote (`offset-cross`).** The design centers a content-height child to
encode a cross inset; the DOM stretches an unpainted wrapper and places the content one level
deeper. The boxes genuinely differ, the render matches, and the row was a standing false red on
real design systems. The fail now demotes ONLY on measured reconciliation, fail-closed on every
term: the design child symmetric in the design content box; the DOM child stretching the
container's cross content box; visually inert (no background/gradient/image/borders/shadow, full
opacity, no `paintUnknown`); a wrapper whose captured children are not truncated and have no
out-of-flow or translucent band member; and the interior band symmetric AND re-creating the design inset measured BOX EDGE to BOX EDGE - the interior's absolute lead and
trail from the DOM root box must equal the child's from the design root box, so root cross
padding/border is part of the measurement and tolerance budgets cannot stack. The demoted row
keeps both numbers, prints the number it MEASURED one level down, and is excluded from
`fix_plan`. Everything else stays a hard fail: full-bleed children, lost or chrome-shifted
insets, pinned or off-inset interiors. A chrome-encoded pixel-perfect render (root padding plus
interior placement summing to the design position) demotes instead of staying red. The pair's
own `size.h` stays red by design - a box-height demote would delete the only witness of real
height defects; the note names the deeper check (pair the design node against the inner DOM
element). docs/coverage.md carries the exact contract and the remaining ceilings
(`visibility:hidden` is not on the wire).

**`styles.paintUnknown` (v7): a declared paint the snapshot cannot classify.** CSS Color 4
backgrounds (`oklch()`/`lab()`/`color()`/`color-mix()` serialize outside the extractor's rgb()
grammar), a visibly-colored outline, generated `::before`/`::after` content with a classified
background, image, shadow, or border, or a filter on the element now sets a flag instead of arriving
byte-identical to transparent. Color tests are alpha-aware end to end: `outline: 2px solid transparent` (the
`.outline-none` / forced-colors idiom), transparent pseudo-element borders and shadows, and the
no-op `blur(0px)` do NOT flag. Consumed in three places: the cross-axis demote and the
style-anchor descent refuse to treat a flagged box as invisible, and the fig-dom `fill` row
stops asserting "the DOM element has no background" over a paint the server now knows exists -
that row is a gating `review` ("color equality was not checked on either side; verify
visually"), the same status the dom-dom side already used for this asymmetry.

**`outOfFlow` preserves heuristic evidence of rendered descendants (v7).** An empty zero-area
out-of-flow leaf is a plain skip - but a zero-area host whose visible, non-zero-area or
content-bearing descendants may render keeps the count. At the capture depth cut, a box with a
direct out-of-flow child now carries the counter instead of reading as a bare leaf.

### Fixed

**Folded spacer insets no longer read as distributable slack.** 0.27.0 shipped two alignment
features whose interplay had a blind spot: the free-space evidence behind the justify-content
demote did not subtract folded spacer extents and their item-spacing, so a design edge encoded
as a spacer could look like slack and let a DOM distributing onto a pinned edge demote. The
evidence now sees the folds (extents AND gaps); a folded GROW spacer - whose extent IS the
distributed space - is excluded from the inset side via the projected `grow` field;
the `justify-content: space-between` end-edge allowance is held to the degenerate
single-child case measured on the PRE-fold population; and when a demote survives over a folded edge, the fold is named in
the row's `caveat` with the numbers it explains.

**A demoted row no longer carries an edit warning.** The gutter-residual pass plants a `caveat`
("this delta is real layout") on a failing row; when a later pass demotes that row as an
encoding difference, the caveat now leaves with the fix_plan channel - a soft row carries
neither an edit address nor an edit warning, and its note is built fresh instead of
concatenating the two contradicting sentences.

**Schema-mismatch remedies name a road that works.** The snapshot-version rows previously said
"re-run the extractor", which on the loader path re-serves the cached old script forever.

### Changed

- The alignment row in docs/coverage.md replaces its cross-axis ceiling sentence with the
  demote contract above; the spacer-inset row's slack interaction is restated.
- The inline extractor script grew with the v7 capture work; the loader thunk is unchanged and
  stays the recommended path (the live size is stated where it matters: the README cost sentence
  and the get_layout_spec response fence).

## 0.27.0

Nine lines from one long feedback pass: a second live design-QA run (three full cycles on a
large production design system) filed six pain points, and three verdict-honesty debts came
due alongside them. Every piece of advice in that feedback was re-measured before shipping,
and twice the measurement overturned the ask itself - the shipped fix was smaller and
different both times (see the find_nodes and confirm_token notes below). Schemas moved in this release: six node-id parameters widened to the compound form, `find_nodes`
got a rewritten description (the coverage-ledger rule, and "a page is CANVAS") and the failed-
snapshot shape gained an optional `hint` field - a client that never re-lists tools keeps reading
the 0.26.0 entries, so reconnect after upgrading. The new RESPONSE fields - the `find_nodes`
coverage ledger and `type_note` included - arrive either way.

### Added

**Selector hints for CSS-modules pages.** A `not_found` whose own selector carries the CSS-module
local convention - a fragment like `panel-header_root`, with a kebab-cased or 8+ char stem - now
probes the live page for that stem, and when the page carries a `__`-mangled class containing it,
names it: the failed snapshot carries a `hint` with the REAL mangled class and a two-fragment
`class*=` recipe (a plain `.card` miss stays a bare `not_found` - the probe fires only on module-
shaped selectors). The hint rides every surface that shows the failure - the
snapshot, the extractor `summaries`, the compare warn, the `suggest_pairs` error and the
`compare_dom_to_dom` gate - and the blocking item for a hint-carrying `not_found` routes to
`fix_pair`, not `re_extract_dom`: re-running the same selector reproduces the same miss
forever.

**Spacer layers fold into insets before pairing.** Design systems commonly encode padding as
literal spacer children (a `Padding horizontal` layer: a full-height RECTANGLE) while the DOM uses
real padding - the positional pairing then matched a spacer against a real child and shipped false
`gap`/`padding`/`offset-cross` fails over layouts whose numbers actually agree. Edge-adjacent,
content-less RECTANGLEs at full cross extent whose name STARTS with
`Padding`/`spacer`/`inset`/`gap` now fold into the pair's insets before children are paired (a
keyword in a later token and short, non-full-cross spacers still do not convert - see
docs/coverage.md); padding rows read the border edge on folded edges; the fold is named in a
`spacer_inset` service row on the pair. A real shift still goes red with the honest delta.

**Alignment mismatches stop hiding behind the justify demote.** When the design container pins its
children to an edge (`primaryAxisAlignItems` under FIXED sizing) while the CSS distributes free
space onto that edge (`justify-content: center`/`space-*`/`flex-end`), the pair used to ship a
silent demoted row ("justify-content spacer - not a padding defect") over what is the page's main
layout bug. The demote now survives only when the design's own number on that edge is slack too;
on an intent edge the row keeps its fail and carries the alignment attribution, and the caveat
rides `fix_plan` so the machine surface names the alignment, not a padding edit. (The mirror case
- the design centers, the DOM pins to an edge - distributes nothing on the DOM side, so there is
no two-sided evidence to attribute; it is unchanged.)

**`children_truncated` blocking items become addressable.** For a cut DESCENDANT, the item's
detail names up to three cut-node addresses per side - design-side ids are directly pairable (re-
rooting a pair at the cut node restarts the depth budget; the recipe is in the detail), DOM paths
are navigation from the pair's selector (a cut at the pair's own root has no address worth
printing and keeps the generic wording). The narrow fully-evidenced tail - the capture ceiling
(`max_depth` 8) was requested or reached, every design-side cut carries an explicit depth cause,
the DOM side is untruncated, the children fully zipped and the pair not unwrap-repaired - trades
its permanently-unexecutable blocking item for one receipt note naming the pairs (the row stays,
`complete` stays `false`; the flag is the structural `depthCeilingTail` on the row).

**Scoped `find_nodes` gets the coverage ledger it never had.** A scoped (`node_id`) search
returned `total: 0` with no coverage at all - an absence claim ("this state does not exist in
the design") stood on nothing. The scoped response now ships the same ledger shape as the
file-level one, plus what the fetch did NOT search: `depth_cut` (containers at the fetch
boundary, counted from the walk depth - never guessed from the wire), `hidden_cut` (hidden
subtrees are excluded from matching at ANY depth - a hidden root or container is ledgered,
not silently skipped), `depth_cut_nodes` (up to 20 addresses, so re-scoping names its
target) and `limit_reached` (`total` is capped by `limit`, not a match count). The
file-level branch accumulates the same walk. Absence is trustworthy only when the ledger shows
`searched === total` and no cut (stated in full on the coverage and skill pages; the tool
description carries the short form - an empty result claims absence only when the ledger shows no
cut). The feedback's own framing here ("find_nodes cannot find a page by name") was
refuted by measurement: the skeleton pass finds pages at full score under the same budget
cut, and the live `total: 0` reproduced exactly with `type: "PAGE"` - Figma pages are type
CANVAS, and the free-form `type` filter silently matches nothing on an unknown value. An
unknown `type` now gets a `type_note` naming the mistake (matching stays literal - no
aliasing).

**`get_screenshot` grows a bounded transport ladder.** A transient socket drop on the render
no longer surfaces raw: the main render retries once at the same parameters (invisible on
success), and after a double transient failure - raster formats above scale 1, in `url`/`inline` mode
(focus, preview and tiles are excluded: their extra renders still read the requested scale) - one
fallback render at half the requested scale, never below 1, ships with the degradation fully
visible: `scale` reports the DELIVERED scale, `requested_scale` and a
factual `scale_note` ride along, inline mode gains a second text content item only when
degraded. Timeouts and queued bailouts never retry (a ~90s hang must not double); a retry
failing in a DIFFERENT class (a 429 with its backoff, an upstream render reason) surfaces
that error, never a false "failed the same way".

**Nested-instance ids stop being second-class.** The `node_id` parameter of
`get_screenshot`, `get_metadata`, `get_design_context`, `find_nodes`, `get_text_styles`
and `get_variables` accepts the compound form
(`I12:345;67:890`), and `export_assets` accepts it in its body validation - a screenshot of
an instance sub-node was previously impossible to take at all. The images endpoint's acceptance was measured live before shipping. `get_design_context` accepts
the form too, but its ancestor-mode walk usually cannot locate instance internals, so modes
resolve at their honest defaults with `coverage_complete: false`. An `export_assets` id absent
from the render response now carries a note naming it instead of a bare `url: null`.

**The dead-resolve `confirm_token` blocker names the road that closes it.** When the variables
fetch degrades in a class a larger budget can retry (a timeout-shaped failure or the too-large 400
- the two the negative cache caches cap-aware), the unresolved-token aggregate's detail names the
escalation: run `get_variables` with `timeout_ms` 120000 on the file, then re-run the compare -
and names its own ceiling (a failed 120s call is itself cached: ~60 seconds for the too-large
class, up to ~10 minutes for a timeout).
The feedback asked to collapse these blockers into an info-note; measurement refuted that:
the suppressed rows would have been exactly the ones whose two colors DIFFER - a possible
real defect released under the inherent-only reading. Blocking stays; only the wording changed. A 403, a queued bailout or a non-timeout transport drop
keeps the plain wording - no marker exists to bypass there.

### Changed

**A budget-dropped FAILing pair now leaves a trace - superseding the silent half of the 0.24.0
known limitation.** When the response budget drops whole pairs, a `verification.notes[]` line says
so and the structural `omitted_pair_ids` sibling names them; a dropped pair carrying fails turns
the report verdict red instead of reading as clean, and the "only inherent items remain" sentence
is replaced by the re-run advice on that shape. (The receipt is still built before the drop, so
`blocking` can still name a label absent from `pairs` - `omitted_pair_ids` is now the key that
reconciles the two.) `compare_dom_to_dom` gains
the condense tier before dropping whole pairs, so the drop shape itself became rarer.

**The done-gate contract now states its escape hatch in every channel.** `complete: false`
with an EMPTY `blocking[]` and ZERO fail rows means only inherent caveats remain (demotes,
out-of-reach axes, a depth-ceiling tail) - verify those by eye, then proceed; fail rows or
`omitted_pair_ids` are discrepancies to fix first, whatever `blocking[]` says. The server
instructions, the tools page, the skill page and the pasted report all say the same thing;
the report's "do NOT say done" imperative now keys on that predicate instead of firing
unconditionally.

**Icon-color rows stop guessing under caps.** Two icon inventories clamped to the same scan
cap are equal by construction, not by alignment - they are never index-zipped anymore (one
honest unchecked row instead, with the cap named); a zip that does run REFUSES when the geometry contradicts the order - where the
geometry gives no axis evidence (ties, sub-tolerance spacing) the zip proceeds as before and
nothing reads as order-verified; the DOM carrier element is named in the row note when the per-
child scan found it below the paired child; pairs with zero icons on both sides stop minting icon
rows at all.

**The variables negative cache stops outliving its own advice.** A cached too-large 400 (one whose
upstream reason names the size limit) now soft-expires after 60 seconds - a retry at the same
budget as the failed cap becomes real again instead of being served the stale failure for the full
TTL, which matters most at the 120s schema max where no larger budget exists - and for that reader
the cached text names the time until the window opens. A request that never reached the network (a
queued bailout) is never cached as if the endpoint had failed.

## 0.26.0

Both lines of one story: a real design-QA run once compared a rendered page against the
SKELETON design frame and reported false defects - the placeholder frame's sizes were
conditional, and nothing said so. This release makes the design side say when it is a
skeleton, at both ends of the cycle: the frame SELECTION (find_breakpoint_variant) and the
comparison itself (compare_node_to_dom). `find_breakpoint_variant` changed its delivered
tools/list entry (description); the compare tools' entries are unchanged - responses carry the
new fields either way, but a client that never re-lists keeps the 0.25.0 description:
reconnect after upgrading.

### Added

**The placeholder-frame signal in `compare_node_to_dom`.** One walk over each pair's RAW
design tree (plus one memoized walk of the frame) detects placeholder (skeleton) components - node names carrying the token, and
componentProperties whose key carries it (an explicit negative value like "no" never fires).
The signal is frame-scoped when `frame_node_id` is given (the hazard is frame-wide: an
ordinary DS button inside a skeleton frame is just as conditional as the placeholder
instances) and pair-scoped with scope-honest wording otherwise. The protection is deliberately
NOT a gate - the verdict is already held by the fails such a compare produces; the cost of the
original incident was those fails being TRUSTED and edit-prescribed. Three carriers instead:
an advisory `placeholder_frame` service row, a caveat on every extent FAIL that does not
already carry a more specific one (an earlier caveat - a page-gutter or encoding note - is
never overwritten), travelling into `fix_plan`'s edits so the machine surface stops
prescribing unqualified edits over placeholder-conditional deltas, and a `verification.notes[]` line that renders in both
verdict branches and survives the response-budget clamp. An all-pass pair with the signal
stays `complete:true` WITH the visible note: a skeleton RENDER against a skeleton frame is a
legitimate, productive flow. The count is a stated lower bound ("at least N ... within the
fetched slice") - the frame walk and the pair walk see different cuts, and the wording never
attributes the number to a named tree.

**`find_breakpoint_variant` surfaces skeleton-ness - the selection stops being a coin flip.**
Insertion order used to break exact width ties between a skeleton variant and its loaded
sibling, and a skeleton variant could win outright, silently. Now every content candidate
(and the variant row, as a max) may carry `placeholders`; `match.placeholders` marks a
matched skeleton candidate, and `match.variant_placeholders` marks a CLEAN matched candidate
sitting inside a placeholder-bearing FRAME variant - the frame-wide hazard reaches the one
object a "take the best match" reader touches. A COMPONENT_SET never taints its clean
children: a set is a grouping, and its clean direct child is the correct choice. One presence-triggered note leads the response
note and fires in every returning branch, naming at most two nodes: the matched candidate's
variant and the closest clean alternative when the match is flagged, or the closest
skeleton-bearing candidate when the match is clean or absent. The alternative never comes
from inside a flagged FRAME variant (a COMPONENT_SET's direct children stay eligible - a set
is a grouping, not a composition; a grandchild under the flagged component is never
offered). The match is never re-ranked and no input was added: a
consumer verifying the skeleton render legitimately wants the skeleton frame. Hidden wrappers
neither race widths nor get scanned. Zero extra REST - every scanned tree was already in
memory at ranking time.

**The shared placeholder detector understands Figma's variant-name assignments.** Figma
encodes variant property values in node names ("State=Loaded, Breakpoint=Desktop"). The rule
is negative suppression: a token-bearing name segment counts UNLESS it is a skeleton-KEYED
assignment with an explicit negative value - so a "Skeleton=False" loaded sibling never
fires, while the idiomatic value-side "State=Skeleton", key-side "Skeleton=Card" and
free-text names containing "=" keep firing (unless the token-bearing segment is itself such a
negative assignment). componentProperties mirror the rule, and the
value-side channel reads the property's declared type: a VARIANT prop set to "Skeleton"
counts, a TEXT prop whose copy happens to read "Skeleton" is content and does not.

### For agents

If `match` carries `placeholders` or `variant_placeholders` - or a compare pair shows the
`placeholder_frame` row - you are measuring against (or beside) a skeleton frame: its sizes
may be placeholder-conditional, extent fails carry a caveat saying so unless a more specific
caveat already claimed the row (either way the caveat rides into `fix_plan`), and if a
loaded-state frame of the same breakpoint exists, it is the geometry reference. To verify a skeleton RENDER, capture both DOM states and use `compare_dom_to_dom`.
The skill page and the tutorial carry the selection-time half of this rule at the step where
the frame is chosen; the verdict-time half lives in the row, the caveat and the receipt note
themselves.

## 0.25.0

Four merged lines, all born from one live design-QA run's feedback: a rewritten
`find_breakpoint_variant` that can actually reach deep variants and says exactly what it did
not search, overlap-aware structure unwrapping, a demote that stops content-box math from
fabricating size deltas over structurally-encoded insets, and a new icon-color axis - the diff
was blind to icon COLOR by design, and a glyph in the wrong color could only be caught by eye.
Existing tools changed their delivered `tools/list` entries: `find_breakpoint_variant` changed
its description and schema; `suggest_pairs`, `compare_node_to_dom` and `compare_dom_to_dom`
changed their snapshot schema (the four optional icon fields). Responses carry the new fields
either way, but a client that never re-lists tools keeps reading the 0.24.0 schemas and
descriptions - reconnect after upgrading. (`get_layout_spec`'s listed entry is byte-unchanged;
what it returns gained the new extractor, which needs no re-list.)

### Added

**Icon color is measured (`icon-color` rows in `compare_node_to_dom`).** Both sides must
independently detect an icon: on the Figma side a subtree whose leaves bottom out in at least
one DRAWN vector shape (rect/ellipse/line boxes are style carriers - parts of an icon, never
what makes one), on the DOM side an `<svg>` (the element itself, or the only svg spanning at
least half of each dimension of its wrapper). The extractor surveys ALL path-like parts - fill,
or stroke when fill is none (outline icons) - folds alpha through fill/stroke-opacity and the
element opacity chain, and classifies the color's authored binding with the cascade winning
over a presentation attribute (`fill="currentColor"` is a deferral, never a hardcoded literal).
The pair goes through the same verdict ladder as text color: hex divergence fails with both
values, a token-vs-hardcoded-literal fails even on matching hexes, token-vs-token asks for a
semantic confirm. What the axis cannot measure says so: unequal icon inventories refuse the
index guess with an unchecked that HOLDS the done-gate (pair the icon nodes directly), a
subtree cut before its vectors is an unchecked routed to `raise_max_depth`, and a snapshot
taken by a pre-0.25.0 extractor shows a bare `svg` with no icon fields - that shape is an
unchecked routed to `re_extract_dom` wherever that svg node survives into the capture (an
out-of-flow svg the extractor drops is counted in `outOfFlow`, not silently green). Multi-color
glyphs and unreadable paints (gradients, `url()` references) are deliberately advisory:
verify-visually info rows - the color is real but plural or unreadable, a human call, not a
coverage hole. A toolbar of icons is a GROUP, not one icon (disjoint icon-bearing containers
stay separate pairs).
`not_covered_by_tool` narrows accordingly: the blanket `icons` entry becomes the two real
residuals - `icon-glyph` shape geometry, and icon-font/mask-image icons (color visible, not
compared). The four snapshot fields are additive with NO schema bump, and the direction is the
safe one: an old capture still validates and never GAINS a green - where it hides an icon the
receipt now says re-extract instead of staying silent.

### Changed

**`find_breakpoint_variant` reaches deep variants and accounts for its coverage.** The old
single fetch at a fixed depth missed variants nested behind sections and returned "not found"
it could not stand behind. The rewrite walks a depth-2 skeleton of the page, then fetches each
candidate container separately under one deadline (20s per-container sub-cap): name matches
rank above container matches BEFORE the result cap, component sets are searched (a matched
set surfaces its variants as its ranked content), and an anchored search (`anchor_node_id`) is
ONE depth-4 fetch. The response now carries a
coverage ledger - `searched`/`total`, the skipped containers by id and name, and a `depth_cut`
flag - and the tool claims a variant is ABSENT only when `searched === total` and nothing was
depth-cut; anything less is honestly "not found within what was searched". Rate limiting
during the container sweep stops the sweep and skips forward (the ledger records what was
skipped); a rate-limited content fetch, like an auth error, still fails the call.

**Overlapping children unwrap instead of poisoning structure.** The single-wrapper unwrap now
accepts overlapping IN-FLOW boxes (negative margins, transforms pulling a child over its
sibling), so that shape no longer collapses the pair into `structure_mismatch`; out-of-flow
children (`position: absolute/fixed`) are counted in `outOfFlow` on both sides, as before.
Where geometry genuinely cannot answer, the rows say so per neighbor: two overlapped children
stacked on the SAME axis make the inter-child gap inapplicable (a visible skip naming "pair
the wrapper directly"), and a one-sided overlap is a named per-neighbor skip - no number is
invented for a distance that does not exist on both sides. When an overlap unwrap re-orders anchor candidates, the tie is
resolved by the nested-text anchor map, and slots that stay ambiguous are skipped honestly -
never guessed. Effective padding under overlap reads the by-physical extremes with tolerance
clustering, and the children-reorder detector is filtered where an unwrap makes order
unprovable.

**Structurally-encoded insets stop failing as size deltas (the encoding demote).** A design
that POSITIVELY declares zero padding while the DOM declares one (the inset lives in spacer
children or a nested component) used to fabricate `size.w`/`size.h` fails of exactly the DOM
padding. Content-box math is byte-unchanged; when a size row fails but the two RAW boxes agree,
the fail is re-labeled an encoding artifact - a demoted row carrying both numbers, still
holding `complete:false`, never a silent green. When the raw boxes also differ, the fail stands
and the note carries the honest raw magnitude. The same dual-convention check demotes
padding-start/end and cross-offset rows that agree at the border edge. A flush design against a
DOM-only padding stays red - that difference has exactly one witness, and the demote never
touches it.

### Fixed

- `npm publish` can no longer ship orphaned compiled files: `prepublishOnly` now clears `dist`
  before the build (`tsc` does not delete removed modules' output).

### For agents

The report footer's icon line now states color IS measured in the Figma comparator - and
explicitly does NOT claim it in `compare_dom_to_dom`, where the axis is off (two captures have
no token side; its own not-covered list stands). The coverage doc gains the icon-color row;
the design-QA skill page documents the new rows and their blocking routes.

## 0.24.0

One new tool, and it is the first one with no Figma side at all: `compare_dom_to_dom` measures
TWO DOM states of one screen against each other - the skeleton against the loaded page, a layout
before an edit against after, one breakpoint capture against another, hover against default. The
tools you already use are byte-unchanged (their schemas and descriptions did not move), so
nothing breaks without a reconnect - but a client that never re-lists tools will not SEE the new
tool until it reconnects. The server INSTRUCTIONS text did change (it now names
`compare_dom_to_dom` beside the five-step cycle), so a never-reconnecting client keeps reading
the 0.23.0 wording - nothing depends on it.

### Added

**`compare_dom_to_dom` - two states of one screen, measured.** The reference state (what
geometry SHOULD hold - for a skeleton check that is the loaded page, not the skeleton frame in
the design file) is compared against the candidate state through the same row machinery the
Figma comparator uses: sizes, inter-child gaps, effective paddings, cross-axis offsets,
typography, colors, shadows. The tool takes `pairs` of `{ label, reference, candidate }` - the
label is the pair's identity everywhere (there are no Figma node ids - the serialized `node_id`
field carries your label), each side is an extractor
snapshot passed inline as `dom` or by reference as `dom_ref` (same store and TTLs as
`compare_node_to_dom`). No `file`, no `figma_token`: the tool makes zero Figma calls.

What the dom-dom mode does differently, because two browser captures are not a design and a
render:

- the layout axis is INFERRED from the reference children's geometry (snapshots do not declare
  flex direction); when the children do not progress in one clear direction - grids, overlays -
  the inter-child AND per-child-extent rows are skipped with a visible note and the receipt
  stays incomplete with a verify-visually (resolve-skip) blocking item: geometry the tool
  cannot measure is never silently waved through - a grid whose cards all shrank in place is
  held by that gate, not by numbers;
- when the axis IS inferred, each index-paired child gets `child-size.w`/`child-size.h` rows:
  gaps and cross-offsets are blind to a child whose extent changed in place, and skeleton
  placeholders are exactly boxes with the right position and the wrong extent;
- presence asymmetries GATE the verdict: a background, border or text the candidate declares
  and the reference does not is a `review` row, and the receipt stays incomplete until it is
  confirmed. The reverse text direction - the reference has text where the candidate has none -
  is a visible `info` row instead, because for the skeleton use case that is the expected shape
  and an uncloseable gate would make the tool's primary purpose unreachable;
- a fill token-provenance drift row: a ROOT background that is `var()`-anchored in one state
  and a literal (or a different variable) in the other is a `review` even when the rendered
  hexes match - the tokenization changed between states, and that is worth confirming (two
  literals, or a provenance either capture did not record, stay silent);
- axes neither side can prove are `unchecked`, never green: a partial, non-uniform, or
  non-hex-parseable reference border, or a reference background in a color space the extractor
  cannot read (`oklch()`, `color()`), keep `verification.complete` false with the honest note
  that the axis was not compared;
- a reference captured under a CSS transform, scrolled, with a degenerate rect, or by an
  outdated extractor is REFUSED as a baseline: no numbers are produced over a corrupt baseline,
  and the pair blocks the receipt with a re-capture action naming WHICH side to re-capture
  (unloaded reference fonts are an advisory info row instead - geometry still compares);
- the report speaks reference/candidate throughout ("Verified reference vs candidate"); the
  serialized row field names stay `figma`/`dom` as a wire contract shared with the Figma
  comparator - read `figma` as the reference value and `dom` as the candidate value.

The receipt is aggregate: `verification.complete` covers ALL submitted pairs - three defects in
three pairs are one incomplete verdict, not three calls. Blocking items reuse the existing
action vocabulary; in this tool `confirm_token` means "confirm the flagged change between the
two captures" and each such item carries `places[]` naming the exact row (`fill`,
`border-color`, `typography`, `fill-token-drift`), so two asymmetries on one pair are
machine-distinguishable.

What it deliberately does not cover, named in `not_covered_by_tool`: content correctness (two
captures of the same wrong text agree with each other), per-child paint (a child's own
background/radius/shadow - compare that child as its own pair), and icons.

### Known limitation

When a response outgrows the transport budget, whole pairs are dropped (the `omitted_pairs`
counter and a report line say so). The receipt is built BEFORE the drop, so
`verification.complete` still covers the dropped pairs - and `blocking` still names them by
label for their skips, unchecked rows and reviews, which means blocking can point at a label
absent from `pairs`. A dropped pair whose only defect is a plain fail leaves no blocking trace
at all (fails never enter `blocking` in either comparator); the omitted-pairs counter is then
the only pointer. Shared machinery with `compare_node_to_dom`.

### For agents

The five-step design-QA cycle is unchanged - this tool is not a step of it. Reach for it when
both sides of your question are the SAME screen: skeleton-vs-loaded (capture both states with
the same extractor and selectors; freeze the skeleton by delaying its data requests), before
and after an edit, breakpoint against breakpoint (unequal capture widths become one loud
viewport row instead of thirty confident deltas). The done-gate discipline is the same as
everywhere: never claim the states match while `verification.complete` is false or `blocking`
is non-empty.

## 0.23.0

One line, and it finishes what 0.22.0 started: the codeSyntax evidence gate now reaches
CROSS-LIBRARY bindings - the design-system layer itself. No input schema moved and no snapshot
schema bumped, so nothing breaks without a reconnect - but the compare_node_to_dom DESCRIPTION
changed (the evidence scope it names), and a client that never re-lists tools keeps reading the
0.22.0 wording. The gate itself works either way. One deployment note at the end matters if you
run the server yourself.

### Changed

**The authored codeSyntax mapping survives the library sync.** 0.22.0 read the evidence only
from the compared file's own variables - and a cross-library binding's variable lives in the
library, not the file, so the gate was structurally dark for exactly the tokens a design
system serves. The sync used to fetch `codeSyntax` on every library variable and narrow it
away one line later; it now carries the RAW authored string into the variable graph, and the
compare's evidence facade merges the local index with a graph view SCOPED to the libraries
the compared subtrees actually reference through their fill and stroke bindings - directly or
through alias chains - and never the compared file's own graph twin: the fresher local index
is the authority for it. The facade still REQUIRES the local variables index: when that fetch
degrades, there is no evidence at all - uniqueness over a partial population is not
uniqueness. (Shadow-color bindings do not pull their library into scope - the shadow token
axis is deferred as before.)

**The gate quantifies over ALL minters of the DOM name, relative to the bound variable, with
a TRI-STATE relatedness - never a unique-count, never a boolean.** Measured live before
building: design systems re-export each other's tokens as alias twins under the SAME authored
name, so 0.22.0's "exactly one minter" rule would have silenced the evidence on the
highest-traffic names. The obvious fix - collapse alias-related minters and keep a
representative - was built and killed by its own adversarial review with a reproduced verdict
flip: pairwise alias-relatedness is not transitive, so any representative makes the verdict
depend on library sync order. And the next draft's boolean relatedness fell to the release
verification itself: it conflated "proven related" with "cannot exclude", turning an
unwalkable co-minter into a green pass. What ships: a row PASSES when the bound variable
mints the DOM name itself and every co-minter is PROVABLY alias-related to it; it becomes
"semantic-diverged" - the one review row that blocks even on matched hexes - only when the
bound side carries its own authored mapping, does not mint the DOM name, and is PROVABLY
unrelated to every variable that does. "Unknown" - a hole in the published-only graph, an
exhausted walk budget, a missing graph half - is neither: it always falls back to the 0.22.0
advisory rule, in both directions.

**Some 0.22.0 gates become advisory, deliberately.** The relatedness engine is shared now:
the walk reaches deeper than 0.22.0's local-only cap, and a chain it cannot finish walking -
including a local alias pointing at a published variable the local index cannot see - reads
"cannot exclude" instead of "unrelated". Rows that gated on such half-walked chains were
false reds, and they now stay on the advisory rule. A row whose name is minted once and whose
chain walks clean keeps its 0.22.0 verdict.

**The multi-tenant graph port is a unit-tested factory now.** The review wave caught the
feature wired everywhere except the multi-tenant branch - green types, green tests, dead
feature on the hosted deployment - because the port object was assembled inline where no test
could reach it. It is a factory with its own lock, plus a tool-level compare test through the
multi-tenant-shaped port.

### Deployment

The variable graph gains a `code_syntax_web` column (idempotent ALTER, applied on the
multi-tenant server's boot and by the operator CLI - no manual migration). Rows synced before
this release read as evidence-free until their library is re-synced: multi-tenant syncs on
demand (portal or CLI - trigger one after deploying if you want the evidence live
immediately); single-tenant holds no rows at all - it rebuilds its graph from a fresh fetch,
so a restarted process has the evidence on its first compare.

## 0.22.0

Two verification lines with one subject - what a color row can honestly claim about tokens - plus
a repository-hardening line. No input schema moved and no snapshot schema bumped: **no reconnect
is needed, and the extractor you have keeps working.** But reread any report's color rows - both
verification lines change what they say, and one adds a red that was not there before.

### Changed

**get_layout_spec names the variable a bound color is wired to.** Until now the tool returned
`fillHex` - the RAW paint value, which for a variable-bound fill is a stale snapshot in the
library's default mode - plus a `fillBoundVar` alias id nobody can write into code. Measured live:
wrong-mode hexes were ported into production CSS from exactly this output. The tool now runs the
SAME resolver `compare_node_to_dom` uses and returns `fillToken` / `strokeToken` / a text
`colorToken` beside the raw values: the variable NAME, its mode-resolved hex, and an honest
`mode_source` ("default" whenever the pin sits above the fetched subtree - this tool deliberately
does not pay for whole-file ancestor discovery; the name is the portable artifact). The variables
fetch is demand-gated (a batch binding no colour pays nothing), always capped, and a failed fetch
is a `degraded_stages` receipt - an absent token is never ambiguous between "not bound" and "the
fetch broke". `fillHex` stays raw and is documented as raw.

**Two false-fail classes are gone from the color verdict.** A fill bound at the NODE level
(`boundVariables.fills`) was invisible to the whole diff side, reached the verdict as a raw
literal, and FAILED over correct code; one shared lookup now reads both binding forms everywhere
(projector, resolver, demand gates, snapshot prefetch). And paint opacity was multiplied into the
raw hex but not into the resolved token hex, so a bound fill at opacity 0.5 diverged from the DOM
computed rgba - also a fail over correct code; the multiplication now happens at every meet point,
`all_modes` included. Both were found by an adversarial panel with red-first fixtures.

**A color FAIL whose hex diverged under a resolved token now carries the token name**
(tokenReason "color-diverged") - the diverged-hex branch is where a developer acts by name, and it
dropped it. (The tokenize-it fail - token on the Figma side, hardcoded literal in the DOM - still
names the token in its note only.)

**A measured token divergence stops hiding behind a hex match.** The "both from a token - confirm
the semantics" row is reachable only after the hexes matched, so the advisory rule demoted it even
when both token names were known and DIFFERENT. Now, when the file's variables carry the DS team's
own authored `codeSyntax.WEB` mapping, the wiring is checked against it: a DOM custom property
that exactly matches the bound variable's authored name (uniquely minted) passes outright, and one
that is the authored name of a DIFFERENT, non-alias-related variable - provided the bound side
carries its own authored mapping too - becomes "semantic-diverged": the one review row that blocks
even on matched hexes. Both names ride the row and the blocking detail (a new structural
`domToken` field on the row carries the DOM var), and the tool description tells the agent what
clears it: align the code with the authored var, or fix the mapping in Figma. Everything without
such evidence - no codeSyntax, ambiguous names, alias tiers, cross-library bindings, case typos -
keeps the old value-based rule byte-for-byte. Absence of evidence never gates. Three adversarial
rounds shaped this rule: a lexical name-matcher and a bare authored-mismatch gate were both built
and both killed before shipping (each one false-reds on mainstream conventions); what survived is
the positive collision only.

**get_view's branch view names shared styles** - it projected a nameless "(paint)" sentinel where
`get_layout_spec` names the style; the compare-compatible claim now holds at the style-name level.

Reach, stated plainly: the codeSyntax evidence lives in the same variables payload the token
enrichment does and dies with the same fetch; cross-library bindings resolved through the synced
graph or the snapshot store carry no evidence yet. And two deliberate asymmetries between the
tools' token objects: `get_layout_spec` omits `all_modes` (that is compare's confirm payload),
and a `rate_limited` from the variables fetch now makes `get_layout_spec` return an error instead
of silently dropping enrichment - the agent must back off either way.

### Fixed

Both empty-name resolver tails (graph and snapshot) fall back to the library key: their name
columns default to an empty string, the null-coalescing fallback never fired, and an empty-named
token degraded confirm_token grouping.

### Repository

The secret scan became one entry point - a single script under `scripts/` that CI and a
maintainer's shell both run: it pins and asserts the gitleaks version (an older binary silently ignores every
allowlist and floods a clean history with false leaks - measured), refuses shallow checkouts,
asserts the scanned commit count against the range, and adds a staged mode wired as a pre-commit
hook. The fixture allowlists pin exact synthetic VALUES instead of exempting test files by path -
a real credential pasted into a test now reports. Proven red on purpose: a planted canary in a
throwaway PR failed CI before this merged.

## 0.21.0

One change, and it moves what your typography rows say. No schema bump, no extractor change, no new
parameter: **no reconnect is needed, and the extractor you have keeps working.** But reread any
report whose text pairs sit on wrapper elements - those rows are the point of this release.

### Changed

**Typography is compared with the text CARRIER, never with a wrapper.**

Measured live: a Button pair read font-size 17/13.3 and weight 550/400, and both were fake -
13.33px is the browser default of the button element itself, while the real text sits deeper in a
typography span computing exactly the design's 17/550. Four of eight fails in that run were
artifacts of reading the wrapper - worse than a missed defect, because the reader goes off to fix
working code and stops trusting the reds that are real.

When the paired element owns its text (or is the text node itself), nothing changes - the compare
is byte-for-byte the old one. When it does not, the styles come from the unique nested carrier and
the row says so ("DOM styles read from the nested text carrier"); a carrier found under a truncated
subtree carries the uniqueness caveat instead of false confidence. When no carrier can be named -
several of them, none in a truncated subtree, or none at all - the row is unchecked with the action
that actually works (a pair on the text node; a deeper capture only where deeper exists; fix the
pair or verify by eye), and `verification.complete` stays false. Never a wrapper compare, in any
branch: inheritance does not guarantee the carrier's rendering in either direction, and the live
run proved both directions.

`fix_plan` edits for carrier rows route to the carrier's own class instead of the wrapper's; a
root-level carrier row carries no edit address at all - an unresolved edit is honest, a wrong file
is not.

An adversarial pass over this change caught two of its own holes before they shipped: the
no-carrier notes originally could not hold the verdict red, and the unique-under-truncation case
read confident. Both are why the paragraph above reads the way it does.

The tutorial's printed snapshots gained the text children the real extractor always captures - the
hand-trimmed examples had dropped exactly the nodes this change reads.

### Repository

The identifier gate's header stops spelling the markers it cannot machine-check, and its stale
sibling claims are corrected; the literal list lives at a private enforcement point now. A denylist
rule inside the public gate was drafted and withdrawn the same day: a gate that carries what it
guards is the leak it warns about.

## 0.20.0

One addition, and it exists because the gate was right in a way nobody could act on. On a page that
carries someone else's chrome - a global footer, navigation tabs owned by another team - the
uncovered regions were real, the coverage arithmetic was honest, and `verification.complete` was
unreachable in principle: the regions were not this task's to fix. A forever-red gate teaches its
reader to explain red away, which is the erosion it exists to prevent. This release makes the red
that belongs to someone else nameable - out loud, on the record - instead of explainable-away.

**Reconnect your client**: the input schema of `compare_node_to_dom` gained a parameter, and a
cached session does not see it. Nothing else moved - no snapshot-schema bump, no extractor change,
so do not re-request the extractor.

### Added

**`exclude_regions` on `compare_node_to_dom`** - up to 50 frame-region ids (compound ids accepted),
meaningful only together with `frame_node_id`. The governing rule, which survived an adversarial
panel and a post-implementation review: **an exclusion removes a coverage DEMAND, never a
MEASUREMENT.**

- An excluded region leaves the `worthy` denominator honestly and produces no uncovered or blocking
  items. The trace is the contract: the receipt lists every exclusion under
  `frame_coverage.excluded`, and the report prints "excluded by the caller" on the green branch
  too - a green that hid what the caller excluded would be the machine gate laundering its own
  scope.
- The partial gates and the spacing audit cannot be disarmed by an exclusion, by construction:
  paired-ness inside excluded branches still counts, so a measured gap fail between siblings
  survives any exclusion, and a pair submitted inside an excluded region keeps its rows, its fails,
  and keeps covering its parent. What an exclusion does renounce is the excluded container's own
  derived between-children audit - its internal spacing question leaves with the rest of its scope.
- The edges answer instead of surprising: an unknown id comes back loud in
  `frame_coverage.excluded_not_found`, whose note names the three possible causes (beyond the
  enumeration slice, a decorative leaf carrying no demand, a typo); the frame root is not a legal
  exclusion, because honoring it would kill the frame-as-container spacing gate; excluding every
  worthy region leaves `complete` to the submitted pairs and says so in the receipt's `notes`;
  exclusions passed without a frame are noted there too, never silently ignored.

The agent protocol gained the matching step: an `uncovered_region` that is outside YOUR task is a
candidate for `exclude_regions`, and excluding a region you were asked to verify makes the verdict
lie for you, not for the tool.

## 0.19.0

Three fixes, each born the same way - by running the documented cycle against a real page and
reading what came back - and each one moves what your reports say. No snapshot-schema bump, no new
tool, no extractor change - the spec response gains one additive optional field (`outOfFlow`, item
2): **you do not need to reconnect your client or re-request the extractor.** But two verdict
behaviours changed, so reread items 1 and 2 before trusting an old mental model of a report.

### Changed

**1. A review row whose two values already matched byte-for-byte no longer blocks.**

A live run held a badge at `complete: false` after 11 passes and 0 fails - the only blocker was
`confirm_token` on a color where both sides read the same hex. "The node's mode is not confirmed"
is a property of the design file, not of the code under review, and a perpetually red gate teaches
the reader to explain red away - the erosion the gate exists to prevent. Such a row is now
advisory: it stays visible (the pencil counter and the row itself), but it neither enters
`blocking` nor holds `verification.complete` at `false`, and the report verdict follows the same
rule, so the verdict line stays equivalent to `verification.complete`. The rule is per row and per
the values the row itself carries: a row whose values diverged, or where a side carries no value,
blocks exactly as before - which means a solid-color row (it carries the two hexes) is silenced by
a hex match even when the DOM token was not read, while a gradient provenance row (it carries the
two token names) still blocks on an unread side. If your agent gates on `complete`, expect `true`
on token-heavy pages where it previously never arrived.

The adversarial pass over this change caught its own hole before it shipped. The gradient
provenance rows (`gradient-token`, `gradient-stop-N-token`) used to carry the literal placeholders
`whole`/`stop` in `figma`/`dom` - values the new rule would have read as "matched" on every
gradient, silently disabling that gate over gradients wired to different tokens. Those rows now
carry the compared token names themselves, null for a side that has none. If you parsed the
literals `whole`/`stop` out of those two rows, parse the token names instead - every other consumer
gains a more readable row. The remaining output deltas are textual or additive: the
structure-mismatch note extended by item 2, the no-address source note now pointing at a doc (item
3), and the `outOfFlow` field itself.

**2. Absolutely positioned children are counted, not vanished.**

`get_layout_spec` on a frame whose direct children include overlays, modals or pins
(`layoutPositioning: ABSOLUTE`) used to drop them without a trace, while the truncation note said
"cut by DEPTH" - a knob that cannot reveal them. Measured twice on live pages: a frame lost its
overlay and three modals, and a week later another frame lost the sticky widget it was opened for.
Every projected level, the depth-terminal one included, now carries `outOfFlow: N` - the mirror of
the DOM snapshot's field of the same name - and the structure-mismatch note names the Figma side
symmetrically. The action that works is stated in both places: raising `max_depth` will NOT reveal
such a child; request its node id directly, or give it its own pair.

**3. Turbopack hashes with underscores parse, and the no-address note carries its own fix.**

The base64url alphabet includes the underscore; the CSS-modules parser's hash group did not - so on
builds emitting 6-char hashes like `pQ_r7S` the source-hint bridge answered "none was recognized as
a CSS module" precisely on the code under review, and `source`/`fix_plan` stayed empty where they
were needed most. Those classes parse now. When no class parses at all, the note points at the new
page that fixes it: [docs/named-classes.md](docs/named-classes.md) - the per-bundler setting
(webpack `localIdentName`, Vite `generateScopedName`, the Turbopack long form that needs nothing)
plus a tier table of what each class shape buys.

### Repository

`pnpm dev` no longer depends on `.env` existing before the first run. On the Node 22 line as
measured in early August, the `--env-file-if-exists` + `--watch` pair with a missing file exited
with ENOENT (the missing path landed in the watch set); the newest 22.x patches no longer
reproduce it, so the upstream regression appears fixed. The ensure-guard stays regardless - it
creates an empty `.env` first, making the run order-independent on every Node rather than betting
on patch levels. The guard is tested as shipped - extracted from `package.json`, not copied.

## 0.18.0

The first release since the package went public, and nothing in the tool surface moved. All 26 tools
behave exactly as they did in 0.17.0: no schema change, no new field, no changed verdict. **You do not
need to reconnect your client or re-request the extractor.**

What changed is what you receive and what it depends on.

### Changed

**1. The published package now carries its own front page and its licence.**

`npm pack` produced 265 files of `dist` and nothing else: no README, no LICENSE. npm adds both
automatically, but only from the *package* root, and in this repository both live one level up. So the
npm page rendered blank and MIT-licensed code shipped with no licence text inside it. Two tests
covered the area and neither could fail for that reason - one pinned the file list and was titled
"ships only dist", the other proved the licence exists "with the repo", which was never in question.
The tarball is what ships.

**2. Every runtime dependency advisory is patched.**

Fourteen advisories across five packages, all transitive and all reached through
`@modelcontextprotocol/sdk`: `hono` and `@hono/node-server` directly, `fast-uri` through `ajv`,
`ip-address` through `express-rate-limit`, `body-parser` through the SDK's own express 5. Each was
moved past its advisory's first patched version rather than merely made newer - `hono` to 4.13.1,
`@hono/node-server` across a major to 2.1.0, `fast-uri` to 3.1.5, `ip-address` to 10.4.0,
`body-parser` to 2.3.0.

The declared floor for the SDK moved with them, `^1.0.0` to `^1.30.0`, because it is the parent of
every one of those chains and the old range permitted the entire vulnerable history. No other declared
range was tightened: those are what your resolver has to satisfy, and narrowing them to whatever this
project happens to have installed would hand you a conflict and buy nothing.

**3. `npx` is the quickstart.**

`npx -y framefit status` needs no clone, no build and no token, and answers in about ten seconds from
an empty npm cache. Registration is one line with no absolute path. The checkout is still documented,
for reading or changing the code, and is now the only place `pnpm` is named as a prerequisite.

### Repository

Not shipped in the package, but visible to anyone who reads it: a machine gate that keeps real
customer identifiers out of the tree, with each of its rules proven by a fixture taken from a file
this repository actually writes; a security policy with a private reporting channel, naming two
deliberate auth properties rather than leaving them to be rediscovered; a secret scan that reads every
commit instead of the first thirty; and every third-party action pinned to a commit rather than a
movable tag.

## 0.17.0

Two places the tool was wrong about a page it had never seen. Both were found the same way - by
running the documented cycle against a real page and reading what came back - and one of them changes
what your reports say.

**Re-request the extractor** (`get_layout_spec` with `include_extractor: true`) **and reconnect your
client.** The extractor grew a field and the snapshot schema gained two; a cached script and an old
session both keep the old behaviour.

### Changed

**1. A page scrollbar gutter that is reserved and never painted is now recognised. Some failures will
disappear, and not because the CSS was fixed.**

`scrollbar-gutter: stable` takes the bar's width from the layout whether or not a bar is painted. On
a page that does not scroll nothing is painted, and the browser measurement this tool used to detect
a gutter reports zero - so a full-bleed box came back short by exactly the gutter, as a hard `size.w`
failure carrying an edit against a working CSS rule. That was the most expensive thing this tool
could do, and it is the second mechanism by which it did it.

Such a row is now demoted and named. The delta is still printed, the verdict is still not complete -
a demote is not a pass - but the edit is gone from the plan, because there is nothing to edit.

**The detector is deliberately narrow, and you should know where it declines.** A reserve is only
read when the page declares a gutter; the root element's own margins are subtracted; the pair root
must be anchored where the gutter was taken from; an inset must be symmetric; and each edge is
bounded by what a scrollbar can be. A reading too wide for a scrollbar is dropped rather than
trimmed - a page that narrows its own root with a width or a max-width keeps its failure and its
edit, which is the answer we want when the tool cannot tell whose space it was.

**2. A blocking item at the maximum capture depth now names something you can do.**

A pair whose children were cut asked you to raise the capture depth - unconditionally, including when
you were already at the maximum, where there is nothing to raise it to. The item could never clear,
so the done-gate could never close on a frame deep enough to reach it. At the ceiling it now asks for
a pair on the nested node instead, which starts its own depth budget. The item stays blocking and the
verdict stays incomplete: the hole is real, only the advice changed.

### Added

Two optional snapshot fields carrying the reserved gutter and how much of it sits on the leading
edge. They are present only when the page declares a gutter. No schema bump: a snapshot captured
before this release omits them and gets exactly the verdict it gets today - it can lose an
explanation it never had, it can never gain one nobody measured.

## 0.16.0

A latency release, and a correction. `compare_node_to_dom` used to fetch your file's variables on
every call; it now fetches them only when a pair actually needs them. Nothing about a verdict
changes, and no capture has to be re-taken - but the tool description changed, so reconnect your
client to see it.

### Changed

**The variables index is fetched on demand.**

Two things read that index, and neither touches it unless a paint is bound to a variable. A compare
whose pairs bind no colour never read it - and waited for it anyway, on the single-tenant and stdio
paths for as long as the Figma variables endpoint took, which on a large file is the dominant cost of
the call.

Such a call now skips the fetch. The response is byte-identical to one where the fetch succeeded:
there is no `degraded_stages` entry, because nothing degraded. If any pair does bind a colour, nothing
is faster - the index is still needed, still fetched, and still waited for.

**A remembered failure is no longer reported as a wait you just paid.**

When the variables endpoint times out, the failure is cached for a few minutes per file, so the next
call answers immediately instead of blocking again. The report line printed for that cached answer
still said the wait was inside the current call. It now says what is true and what to do: the failure
is remembered, this call did not wait for it, the next one will not retry it, and `get_variables` with
a larger `timeout_ms` is what gets past the marker.

### Added

**`degraded_stages` is documented where it is read.**

It was in the response and in no guidance. Both the tool description and the agent skill now say what
it means: an enrichment that did not arrive, with the milliseconds it cost, the rows it feeds reading
unresolved rather than verified, and the verdict staying incomplete. Its *absence* on a compare with
no bound colour means the stage was not needed, not that it silently passed.

### Considered and not done

Capping the variables request on the stdio path, which would have cut the worst case by about seventy
seconds. It was rejected on measurement: because a cached timeout can only be bypassed by a request
with a larger budget than the cap that produced it, a cap below a file's real latency is permanent
rather than transient. On a file whose variables endpoint answers a little slower than the cap, that
would permanently remove the tool's ability to tell a wrong colour from an unconfirmed one - a live
divergence would stop being reported as a failure at all. Seventy seconds is not worth that.

## 0.15.0

Three measurements this release, each one a case where the tool stopped measuring and explained
itself with the wrong reason. None of them looked like a defect from inside the code; all three were
found by running the cycle against a real page and reading what came back.

**Re-run `get_layout_spec` with `include_extractor: true` and reconnect your client.** The extractor
changed and so did a tool description; an old cached script and an old session both keep the old
behaviour.

### Changed

**1. A transform that moves nothing no longer disables the geometry gate.**

The gate read the transform as a string: anything other than `none` meant "this box is not where its
layout puts it", and every geometric row on that pair went unmeasured with the note *wait for the
animation to finish*.

A computed transform is always a matrix, and an identity matrix puts the box exactly where `none`
would. Promoting a fixed header with `translateZ(0)` is the ordinary idiom, so on such a page nothing
geometric was ever measured and the verdict blamed an animation that was not running - an instruction
nobody could carry out. Measured on a live page: a site header carrying an identity matrix, with no
transition and no animation, hiding a real 6px height difference against its design frame.

The matrix is now compared to identity in both its 2D and 3D forms. Anything unparseable still gates:
over-gating costs a measurement, under-gating would report a moved box as a design defect.

**If you have pages with a promoted header or sticky bar, expect rows you have never seen before, and
some of them may fail.** That is the tool measuring what it previously skipped.

**2. Children excluded for being out of flow are counted, and the advice about them is now correct.**

`position: absolute` and `position: fixed` children are not part of their parent's layout, and the
extractor excludes them on purpose. It used to drop them without a trace, so a box whose children are
all out of flow was indistinguishable from a true leaf: the diff reported a child-count mismatch and
advised capturing deeper, which can never return a child that was never a candidate. Measured live, a
fixed site header - the entire navigation - disappeared exactly this way.

The snapshot now carries `outOfFlow` on any box that skipped some, absent when none were skipped. The
`structure_mismatch` note says how many there were, that a deeper capture will not reveal them, and
what does work: pair such an element directly by its own selector.

**3. A wrapper that carries layout of its own is no longer unwrapped away. This changes pairings.**

"Has one child" was the entire test for a pass-through wrapper, and such a box was replaced by its
child before scoring. But a box whose single child is hundreds of pixels narrower than itself is not
passing anything through - it is centring, and that centring is layout being compared against the
design.

A single-child box is now a pass-through only when its own box is its child's box, within 1px.
Measured on a live frame: a design node that spans a page region moved off a 1280x877 inner container
(score 25.93) and onto the `main` that actually spans it (score 36.19), and the address in the receipt
became the element a person would have paired by hand.

**Expect different proposals from `suggest_pairs` on pages that centre their content in a wrapper**,
and a different structural reading in `compare_node_to_dom` where such a wrapper sits between the pair
root and its content. The pairings get better; they do not stay the same.

### Unchanged, deliberately

The position of a box is still not used for ranking. `scorePair` reads width and height and never x or
y, and a proposal to break score ties by relative vertical position was built, measured on two real
pages, and rejected: it is blind in half the contests it would be consulted on, it costs a real pair
where it interacts with the match floor, and the contest it does fix is already decidable from the
receipt - the tag and the two rects are on the row.

## 0.14.0

`suggest_pairs` used to hand back a row you could not act on. This release makes the row decidable
and stops it inventing pairs under an unresolved parent. Nothing was removed, but one behaviour
changed: you will get fewer proposals on container-heavy frames, and that is the point.

### Changed

**A pair whose identity is unresolved no longer gets its subtree matched.**

When the winning candidate's lead over the runner-up falls inside the ambiguity band, the pair is a
coin flip, and children matched underneath it inherit that coin flip. Measured against a real page,
one such commit manufactured four further wrong proposals by recursing a design footer into the
cards of an unrelated content grid. Those children are no longer proposed. The pair carries
`children_skipped`, and the count of such pairs appears in the summary.

A withheld subtree is deliberately in NEITHER `unmatched_figma` nor `unmatched_dom`: those lists
assert "no counterpart here", and we did not look. Confirm or retarget the pair, then call again
rooted on the element you confirmed. The descent still happens when text on both sides below could
resolve the parent, so a pair with a real text anchor under it is unaffected.

**The tool description changed, so reconnect the client** to see it. It previously told you to paste
the proposed address into `compare_node_to_dom`; that tool takes a node id and a snapshot or a
snapshot ref, and has no selector input at all.

### Added

**Every proposal ships the numbers it was ranked by.** `score`, `margin` over the runner-up,
`figma_rect`, `dom_rect` and `dom_tag`. An exact text match is worth +100 of a roughly 145-point
scale, so on a frame made of containers no proposal can pass 46 and every row reads `low`: that is
a report of absent text, not of bad geometry, and the score is how you tell. The two rects are how
you reject a wrong proposal without opening a browser. `unmatched_figma` and `unmatched_dom` rows
carry rects too.

**A pasteable address: `dom_selector`.** The capture-root selector, which the extractor already
refused to accept unless it matched exactly one element, scoped over the nth-child path. Use it as
the extractor's root selector to re-capture that one element. It is absent when the snapshot carries
no root selector - an address is never synthesized - in which case `dom_path` is still there,
relative to your own root.

It is only as fresh as the capture it came from. An nth-child chain always resolves to something, so
after a navigation the same address lands on a different element, the extractor answers `ok`, and
the comparison reports two unrelated elements as a design defect. Check `dom_rect` against what you
are about to compare, or re-capture.

**The runner-up carries the winner's identity.** Each entry of `candidates[]` now has `dom_tag` and
`dom_rect`. Two near-tied candidates print the same rounded `score` and the tie falls to document
order, so those fields are what actually decide it. A `children_skipped` row carries the list too,
even when the runner-up was too weak to be called an alternative: if it was decisive enough to
withdraw a subtree, it is named.

### Unchanged, deliberately

The `confidence` banding. It is not a display field - an internal pass gates on it - and every
re-banding variant that was built and measured promoted a known-wrong pair. `low` on a
container-only frame is correct; the receipt above is what makes it readable.

## 0.13.0

This release closes a set of defects that made the server unsafe or dishonest to run outside the
machine that built it. Several of them change behaviour you may be relying on.

Read the Breaking section in order. It is arranged the way you will meet it: the server has to be
reachable before a client can connect, a client has to connect before it can call a tool, and a
tool has to run before its output matters.

### Breaking

**1. The HTTP transport binds `127.0.0.1` by default. New setting: `BIND_HOST`.**

It previously bound every interface. The single-tenant server has no authentication of its own and
wires your `FIGMA_TOKEN` into every call, so an unset value must not mean "reachable from the
network".

- Running under Docker or compose: nothing to do. The image sets `BIND_HOST=0.0.0.0`, and the
  compose port mapping is what keeps it on the host's loopback.
- Running `node dist/index.js` or `npx framefit` on a box you reach from another host: set
  `BIND_HOST` explicitly, and put authentication in front of it.
- Loopback here is IPv4-only. A client configured with `http://localhost:PORT` may resolve `::1`
  first and fail to connect. Point the client at `127.0.0.1`. Setting `BIND_HOST=::1` is not the
  same fix - one listen cannot be both loopback-only and dual-stack, so it only swaps which clients
  break, and inside the container it produces a permanently unhealthy box (see item 2).
- `BIND_HOST` is validated at startup: an IP literal or `localhost`. It is the interface to bind,
  not the public hostname you advertise - that is `MCP_HOST`, and passing one for the other used to
  surface as an `EADDRNOTAVAIL` restart loop.

**2. `GET /health` gained a `bind` block, and the image healthcheck now requires it.**

The payload is now `{"status":"ok","bind":{"address":"<canonical>","loopback":<bool>}}` on both the
single-tenant and multi-tenant servers. The container healthcheck reads it and passes only on
`"loopback":false`, because a container bound to its own loopback has a dead published port and
nothing inside the container can observe host-side port publication.

- If you set `BIND_HOST` to a loopback address for the container (including through a copied
  `mcp-server/.env`, whose `env_file` beats the image's own `ENV`), the container is now
  permanently unhealthy instead of quietly serving nothing. The shipped `.env.example` keeps the
  line commented out for exactly this reason.
- The check is fail-closed: a server that does not report the field is unhealthy, not healthy.
- If you parse `/health` strictly, it has one more key than before.
- Known false alarm, accepted: under `network_mode: host` a loopback bind is correct and reachable,
  and this check still fails it. Neither compose profile here uses host networking.

**3. `Caddyfile.example` now requires a credential.**

The shipped example had no `basic_auth` at all, so an operator who followed the "front it with
Caddy" instructions got an open proxy to their Figma account. If you re-copy the example you must
create a credential (`caddy hash-password`) or every request, including a `/health` monitor, gets
401.

- `/api/dom-snapshots/*` is the one route deliberately left anonymous. The page being measured
  loads the extractor cross-origin and cannot carry basic-auth credentials; its credential is the
  per-call capability token in the URL path. That route is also excluded from the access log, since
  Caddy logs `request.uri` verbatim and the token lives in the path.
- `encode gzip` is gone: the MCP route answers `text/event-stream` and gzip buffers it.
- The body cap on the exempted route is `2MiB`, not `2MB`. Caddy reads `2MB` as 2,000,000 bytes
  while the server's limit is 2,097,152, and an upload between the two returned an opaque 413 with
  no CORS header at the edge.
- That exempted prefix has no rate limit and cannot get one in this file: rate limiting is a
  third-party Caddy plugin, not part of the official build. Use an xcaddy rebuild or a firewall
  rule if you need one.

**4. `/mcp` refuses a request carrying an unrecognised browser `Origin`. New setting:
`ALLOWED_ORIGINS`.**

A loopback bind is exactly the deployment DNS rebinding targets: a page on any domain that resolves
to 127.0.0.1 reached the socket same-origin and could call tools under your `FIGMA_TOKEN`. Requests
with no `Origin` header - every ordinary, non-browser MCP client - are unaffected.

The server always admits its own advertised origins: the bind host at the bound port,
`PUBLIC_BASE_URL`, `https://MCP_HOST` in multi-tenant, and `localhost` at that port - but the
`localhost` alias only when the bind is IPv4 loopback or a wildcard, since that is when the two
name the same endpoint. Bind a LAN address or `::1` and `http://localhost:PORT` is foreign like
any other origin.

`ALLOWED_ORIGINS` is a comma-separated escape hatch so the gate can never become an unopenable
door. Read its name narrowly: it stops this guard from refusing an origin and does nothing else.
Cross-origin browser use of `/mcp` still does not work whatever you list, because nothing sets
CORS response headers on `/mcp` and the transport answers `OPTIONS` with 405.

**5. `resolve_comment` is now `delete_comment`.**

Figma exposes no endpoint that marks a comment thread resolved. The call has always issued
`DELETE /v1/files/:key/comments/:id`, while the description an agent read said it "marks it
resolved; it stays visible in the file". Update any agent prompt, skill or client config that names
the old tool - there is no deprecated alias, because a second name for a permanently destructive
operation doubles the ways an agent can reach it while halving the chance it reads the honest
description.

The new description says what the call does: the deletion is permanent and is not undone by file
version history, it is not a way to resolve a thread, and only the comment's author may delete one.
It deliberately says nothing about what deleting a thread root does to its replies: Figma's
reference documents the author-only rule and no cascade, and the only experiment that would settle
it destroys real comments.

**6. The structured log surface changed: one field's value changed, one field added, five new
events.**

`use_case.start` and `tool.error` lines now carry `tool: "delete_comment"`. A log query, alert or
dashboard pinned to `resolve_comment` matches nothing.

Two more things an operator parsing these lines will see. `server.listening` gained `bind_host`,
carrying the address the socket actually bound (see item 1). And five events are new. Three of them
are `info`, one per tool that now degrades instead of failing when a render is unavailable:
`review_board.screenshots_unavailable`, `get_screenshot.tiles_unavailable` and
`get_pin_detail.full_res_unavailable`. They fire on calls that used to either fail outright or succeed
silently.

The other two are refusals, one for each refusal this release adds. `mcp.origin_rejected` (`warn`,
item 4) is one line per request turned away for its `Origin`, carrying that origin truncated to 64
characters plus `origin_truncated`. `dom_snapshot.upload_rejected` (`info`, item 8) is one line per
404 on an unknown or expired capability token, carrying `capTokenPrefix` and the client's declared
`content-length` - which is a claim rather than a measurement, since that path deliberately never
reads the body. Both fire on paths that logged nothing at all before.

**7. `FRAMEFIT_READ_ONLY` now actually refuses writes on the single-tenant and stdio paths.**

The flag, and the "Disabled in read-only mode" sentence in three tool descriptions, were previously
false outside multi-tenant: nothing wired a gate, so every write went through. If you set this
variable and observed writes working, they will now be refused.

- Only the exact value `true` (any case) enables it. Unset or unrecognised leaves writes enabled,
  which is the previous behaviour for everyone else. A typo does not crash the server.
- The refusal now names the remediation for the mode you are in: multi-tenant points at the portal,
  single-tenant names the environment variable. Multi-tenant is unchanged - there read-only is
  per-user and lives in the database, and this variable is ignored.
- The compose local profile forwards the variable; the multi-tenant service does not.

**8. `POST /api/dom-snapshots/:capToken` answers 404 for an unknown or expired token before it
reads the body.**

The token check moved above the body parser. A request against a bad token that also had a
malformed body, a schema-invalid body, or a body over the 2mb limit previously won with 400, 422 or
413; it is now 404 in every case. The limit itself is unchanged for anyone holding a live token.

Two smaller changes on the same endpoint, for anyone matching on its responses. Under a LIVE token,
a body that is both over the per-POST snapshot count and schema-invalid now answers **413, where it
used to answer 422**: the count cap moved ahead of the per-element validation, so the array is
refused by count rather than by 50,000 schema failures. And the 404 body text is now
`upload token expired or unknown - re-run get_layout_spec`, with an ASCII hyphen where it used to
carry an em dash.

It is also a large latency and memory saving on a rejected upload. A 400KB body of 50,000 objects
against a bad token used to cost about 0.55s over HTTP and answer with a 2.1MB array of per-element
complaints. A 2MB probe now costs about 1.4ms and 68 bytes, flat in body size.

**9. Every Figma error message was rewritten to quote the reason Figma gave.**

Errors are now classified from the response body rather than from the status code, and Figma's own
`err`/`message` string is quoted back, bounded to 120 characters and stripped of anything outside
printable ASCII. If you match on the text of these messages, all of them changed.

The behaviour change under it: a dead token is no longer diagnosed as a plan or permission problem.
`get_variables` used to answer every 403 with "The Variables REST API requires an Enterprise plan"
and every 400 with advice to split the design-system file; both are now gated on what Figma
actually said. `search_design_system` carried the same defect and carries the same reason now.

**10. One error CLASS moved, which changes the `[kind]` prefix and the `error_kind` log field.**

Separate from item 9, and easier to miss because it is not text: every tool result for a failed
Figma call is prefixed `[<kind>]`, and every `tool.error` log line carries the same value as
`error_kind`. One class of 403 changed which kind it gets.

A 403 is now classified from Figma's own parsed reason. Previously the word "scope" appearing
ANYWHERE in the response body - including in an HTML error page this server did not write, or in a
field next to a reason that names something else - produced kind `auth`. It now produces
`forbidden`, the frozen default for a 403, unless the reason Figma actually gave names a scope.
The same applies to a reason naming both an account-type limit and a scope: plan outranks scope,
so that is `forbidden` too.

Nothing Figma really sends moved: measured over a 476-case matrix - 17 bodies x 7 statuses x 4 call
shapes - the 16 cases that changed are all bodies Figma does not produce. But if you alert on
`error_kind: "auth"`, or branch on the `[auth]` prefix, those cases now arrive as `forbidden`. The
point of the change is that an intermediary can no longer choose the kind by writing one word into
a body.

**11. `framefit status` reports and checks the bind interface, and its skipped Figma check no
longer reads as a pass.**

- The report JSON gained `mode.bind_host` and `mode.bind_host_source`; the human header prints
  `bind: 127.0.0.1 (default)`; the single-tenant `config` line carries the bind too.
- The `config` check now fails on a `BIND_HOST` that is not an IP literal or `localhost` (it runs
  the real config loader, so it fails wherever the server would fail to boot).
- The `figma` check's skipped text changed. It used to read as reassurance in a run that exits 0.
  It now says it is not a verdict about the token, and that on stdio the token lives in your MCP
  host's env block rather than your shell.
- A failing token probe prints Figma's own reason next to the HTTP status, per user in
  multi-tenant.

**12. Every tool description was rewritten to ASCII.**

`tools/list` delivers all of it to every client and a model reads it. 17 of the 26 descriptions and
38 input-schema field descriptions carried non-ASCII characters. Typographic characters were
substituted, not deleted. Two tools carried Russian example values and now carry English ones that
teach the same thing: `find_nodes` and `get_review_board`. `compare_node_to_dom` no longer carries
an emoji in instructions an agent acts on. Five field descriptions that quoted the Cyrillic halves
of the default review-board and `find_threads` name patterns now describe the default instead - the
patterns themselves are behaviour, are correct, and are unchanged.

**13. The DOM snapshot schema is v6. Snapshots captured with an older extractor are refused.**

Re-fetch the script (`get_layout_spec {include_extractor:true}`) and re-capture. A `schema: 5`
snapshot now gets a `snapshot_schema` warn row and a `re_extract_dom` blocking item from
`compare_node_to_dom`, and a hard error from `suggest_pairs`. Cached `snapshot_ref`s taken before
the upgrade are equally stale.

The version had to move because the change is not additive - it redefines an existing field.
`styles.borderRadius` now means "all four CSS corners are this ONE px number", which is the only
shape Figma's single px `cornerRadius` can be compared against. Any other radius omits the field and
sets `styles.borderRadiusUncomparable: true` instead: corners that differ, a percentage, or an
elliptical `8px / 4px`.

Older extractors emitted a plain number for all of them - `borderRadius: 8` for
`border-radius: 8px 0 0 0`, `50` for `border-radius: 50%` - with no flag at all, so on the wire their
output is indistinguishable from a genuinely uniform 8px or 50px and the server has no way to tell
the two apart. Each of those passed a matching Figma `cornerRadius`. Without the version bump the
`corner-radius` row would have kept passing over an unmeasured difference on every stale capture -
the same defect this release removes from the code, displaced onto the wire. Same reasoning as the
v4 bump, where old extractors truncated text without flagging it.

### Added

- **MCP tool annotations on all 26 registrations.** `readOnlyHint` on the 23 reads;
  `readOnlyHint: false, destructiveHint: false` on `post_comment` and `reply_to_comment`;
  `readOnlyHint: false, destructiveHint: true` on `delete_comment`. These are disclosures for hosts
  that surface them. The spec tells clients to treat annotations as untrusted, nothing in this
  server reads them, and the only enforcement here is the read-only gate above.
- **The image declares how it is invoked** (`FRAMEFIT_INVOCATION=docker`), so a diagnosis printed
  from inside a container names the `docker compose exec` form a reader on the host can paste, not
  only the in-container path. Outside the image the command is derived from `argv[1]`.
- **`ENFORCE_AUDIENCE` is documented for what it is** (multi-tenant only): off by default, and off
  in the shipped examples, because hard enforcement needs a Keycloak audience mapper that stamps a
  framefit-scoped `aud` on portal tokens. Until that mapper exists, any valid token from the same
  realm is accepted on `/accounts` - the API that manages Figma PATs, CI keys and bridge tokens.
  `/mcp` stays soft regardless, because dynamic-client tokens carry an `azp` this server cannot
  predict.

### Fixed

- **`get_screenshot` and `export_assets` surface render failures.** `GET /v1/images` reports them
  inside a 200 body, and that field was dropped, so the tools returned an empty image set with no
  reason at all. Where the render is only an enrichment of an otherwise complete answer
  (`get_review_board`, `get_screenshot` with tiles, `get_pin_detail`'s full-resolution URL), the
  answer still arrives and carries the reason instead of failing the call. Those three results
  gained a key to carry it: `warnings` (already present, now also fed by render failures),
  `children_map_note` and `full_res_url_note`.
- **`search_design_system`'s `skipped_teams` is ordered by input, not by completion.** The team
  requests run concurrently and the array used to be appended in whatever order they settled, so a
  positional join against your own team list was unreliable - and silently so, since with one slow
  team it was usually right. Each failure is now recorded at its own index and the array is
  compacted before it is returned, so it carries only the teams that failed, in the order the
  teams were searched. That list is not your array: `team_id` takes one team, and the multi-tenant
  fallback that accepts none searches your registered teams, deduplicated and capped at the first
  5. So a positional join still does not work - the entry at position `n` is the `n`th team that
  FAILED. Read `team_id` off each entry.
- **A repeated failure is no longer diagnosed differently from the first one.** The negative cache
  dropped the upstream reason on the way in and out, so a cached 400 lost the quote and fell back
  to generic advice.
- **A 429 with no `Retry-After` header** rendered as "Retry-After: unknowns." and would have told
  you to wait an unknown amount of time.
- **The extractor loader and upload URL follow the bind.** With `BIND_HOST` set to a LAN address,
  the browser-facing base is that address rather than the browser machine's own loopback. A
  wildcard bind still advertises loopback, which is the only dialable thing it means.
- **Both documented `npx -y framefit` one-liners now set `MCP_TRANSPORT=stdio`.** The server
  defaults to the HTTP transport, so the documented line used to boot an HTTP server the MCP host
  never spoke to.
- **`get_variables` and `search_design_system` now end a refusal at a command you can actually
  run.** Every branch of their 403 diagnosis used to end in Figma's web UI and at nothing runnable
  against this instance. Both now append a `framefit status` line derived from how this process was
  started - a source checkout, an installed bin, or a container - together with the caveat that
  makes it answerable in the mode you are in: which credential that run would probe, and whether it
  would probe one at all. This is a change to those two tool errors only; what `status` itself
  prints changed for its own reasons, in item 11 above.
