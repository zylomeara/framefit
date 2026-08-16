# Tool reference

The server exposes **26 tools** over MCP. Every description below is taken from the live
`tools/list` output - the same text an MCP client sees. Tools are grouped into four pages:

- [Design QA](design-qa.md) - deterministic Figma <-> DOM verification
- [Navigation & content](navigation.md) - maps, search, typography, screenshots, code-oriented extraction
- [Comments & review](comments-review.md) - comment threads and design-review boards
- [Design system](design-system.md) - tokens, libraries, Code Connect, FigJam

For an end-to-end walkthrough of the design-QA cycle (pairs → compare → verification receipt →
fix plan), see the [Design QA tutorial](../design-qa-tutorial.md).

## Design QA

| Tool | Summary |
| --- | --- |
| [`get_layout_spec`](design-qa.md#get_layout_spec) | Diff-ready layout spec of nodes: rect, auto-layout axis/gap/padding, in-flow children geometry, typography, fill hex, component identity. Also ships the canonical DOM extractor. |
| [`suggest_pairs`](design-qa.md#suggest_pairs) | Propose Figma-node <-> DOM-element pairs (by text/size/order/role) with confidence, ambiguous flags and honest unmatched lists. |
| [`compare_node_to_dom`](design-qa.md#compare_node_to_dom) | Deterministic metric diff between Figma nodes and DOM computed snapshots: sizes, gaps, paddings, cross-axis offsets, typography, colors, component identity. |
| [`compare_dom_to_dom`](design-qa.md#compare_dom_to_dom) | Deterministic metric diff between TWO DOM states of one screen (reference vs candidate): skeleton-vs-loaded, before/after an edit, breakpoint-vs-breakpoint. Zero Figma calls. |
| [`find_breakpoint_variant`](design-qa.md#find_breakpoint_variant) | Resolve which breakpoint variant frame matches your rendered width, ranked by content-frame width. |
| [`get_view`](design-qa.md#get_view) | Five pure lenses over one held frame (skeleton / branch / coverage / typography / spacing) sliced from a single deep fetch. |

## Navigation & content

| Tool | Summary |
| --- | --- |
| [`get_metadata`](navigation.md#get_metadata) | A sparse map of a Figma file: id/name/type/position/size per node, depth-limited - cheap navigation, call it first. |
| [`find_nodes`](navigation.md#find_nodes) | Find nodes by name or text content (substring or fuzzy) inside a file or subtree, without knowing node ids. |
| [`get_node_ancestry`](navigation.md#get_node_ancestry) | Breadcrumbs from a node up to its page, plus the direct children of every ancestor. |
| [`get_text_styles`](navigation.md#get_text_styles) | Extract only the typography of a node's subtree - fast spec verification without the full design tree. |
| [`compare_breakpoints`](navigation.md#compare_breakpoints) | Compare one element's typography across several breakpoint frames in a single call. |
| [`get_screenshot`](navigation.md#get_screenshot) | Render a Figma node to an image: signed URL, inline, preview, or a zoomed focus crop with a reticle. |
| [`export_assets`](navigation.md#export_assets) | Export Figma nodes as rendered images (PNG/SVG/JPG) and return signed URLs, optionally with original source images. |
| [`get_design_context`](navigation.md#get_design_context) | Descriptive, code-oriented representation of a node: auto-layout, sizing, fills/strokes/effects, text + typography, component instances. |

## Comments & review

| Tool | Summary |
| --- | --- |
| [`get_comments`](comments-review.md#get_comments) | Fetch review comments from a file as threads, with rich filtering (author, message, dates, node, mentions) and pagination. |
| [`summarize_comments`](comments-review.md#summarize_comments) | Aggregate statistics for a file's comments - a compact ~1-2KB summary to scope large files first. |
| [`find_threads`](comments-review.md#find_threads) | Search comment threads by text, ranked by relevance, with optional fuzzy matching. |
| [`post_comment`](comments-review.md#post_comment) | Post a new root-level comment on a file. |
| [`reply_to_comment`](comments-review.md#reply_to_comment) | Reply to an existing comment thread. |
| [`delete_comment`](comments-review.md#delete_comment) | Permanently delete a Figma comment. There is no undo: Figma does not restore deleted comments and file version history does not bring them back. This is NOT a way to resolve a thread. |
| [`get_review_board`](comments-review.md#get_review_board) | Extract a design-review board in one call: pins <-> notes <-> targets, grouped by lane, with resolved reference nodes. |
| [`get_pin_detail`](comments-review.md#get_pin_detail) | Inspect one review-board pin: a zoomed reticle-marked crop plus its resolved reference node - in a single call. |

## Design system

| Tool | Summary |
| --- | --- |
| [`get_variables`](design-system.md#get_variables) | List design tokens (Figma variables): name, type, value, collection - whole-file catalog or only the tokens a node references. |
| [`search_design_system`](design-system.md#search_design_system) | Search published design-system libraries (components, component sets, styles) by name/description. |
| [`get_libraries`](design-system.md#get_libraries) | List the design-system libraries a file publishes or consumes. |
| [`get_code_connect_map`](design-system.md#get_code_connect_map) | Map Figma instance nodes to their Code Connect code snippets from CI-uploaded mappings. |
| [`get_figjam`](design-system.md#get_figjam) | Structured content of a FigJam board: sticky notes, shapes-with-text, sections, connectors, tables. |

## Conventions

- `file` accepts a full Figma URL (`https://www.figma.com/design/<key>/...`) or the raw file key.
- Node ids use Figma's `12:345` form. Fourteen parameters also accept the compound nested-instance
  form `I12:345;67:890`: `get_layout_spec.node_ids[]`, `get_view.node_id`,
  `suggest_pairs.frame_node_id`, `compare_node_to_dom.pairs[].node_id`,
  `compare_node_to_dom.frame_node_id`, `compare_node_to_dom.exclude_regions[]`,
  `get_node_ancestry.node_id`, `get_code_connect_map.node_ids[]`,
  `get_screenshot.node_id`, `get_metadata.node_id`, `get_design_context.node_id`,
  `find_nodes.node_id`, `get_text_styles.node_id` and
  `get_variables.node_id`. Every other node-id parameter is pinned to `^\d+[:\-]\d+$`
  and rejects the compound form with MCP error `-32602`.
- One node-id parameter is exempt from both rules: `export_assets.node_ids[]` declares no pattern
  at all. The tool body refuses a malformed id with the server's own message (before any Figma
  call); the nested-instance form is accepted there too.
- `figma_token` overrides the Figma personal access token for a single call; otherwise the
  server-configured token is used. It is declared by 23 of the 27 tools -- every read tool except
  `compare_dom_to_dom`, which makes zero Figma calls and takes no token at all -- and by none of
  the three write tools (`post_comment`, `reply_to_comment`, `delete_comment`). All 27 declare
  `additionalProperties: false`, so passing it to a tool that does not take it is a schema error,
  not a silent no-op.
- Code fences: a request example is tagged `json` and a response example `jsonc`, which is what
  lets a response body carry comments and elisions.
- The configurable `MAX_RESULT_CHARS` budget is measured against the exact delivered envelope for
  `compare_node_to_dom`, `compare_dom_to_dom`, `find_nodes`, `get_comments`, `get_metadata`,
  `get_review_board`, `get_text_styles` and `get_variables`. Ordinary comparator pair omissions use
  `omitted_pair_indices`; when the prefix-preserving clamp retains no complete pair detail,
  `code:"response_budget"` with `pairs: []` is always incomplete; a later pair may still fit unchanged
  when replayed alone, so replay every listed position or use smaller DOM roots. The other six tools
  return a static `isError:true` `response_too_large` result with `action:"narrow_request"` and no
  cursor when no atomic result fits. `get_layout_spec` and `get_view` use a separate fixed 1 MiB
  ceiling, measured as UTF-8 bytes against the exact delivered `content[0].text`. Layout-spec
  truncation keeps the largest ordered whole-entry prefix and reports the positional suffix in
  `omitted_node_ids` (duplicate ids stay duplicated); `get_view` is atomic. The layout first-prefix
  probe includes required omission metadata, so `first_item_oversize` does not prove that entry will
  fail when replayed alone. `envelope_oversize` means fixed response metadata cannot fit without an
  atomic item. For layout spec, retry without `include_extractor` or with fewer `node_ids`; a view
  envelope includes depth-dependent hydration, so retry lower `max_depth` before correcting `file`
  or `node_id`. These contracts do not make response size a server-wide guarantee.
