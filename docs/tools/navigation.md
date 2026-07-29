# Navigation & content tools

Orientation inside a Figma file: cheap maps, name/text search, ancestry, typography extraction,
screenshots, asset export, and the code-oriented node extraction (`get_design_context`).

Typical order: [`get_metadata`](#get_metadata) or [`find_nodes`](#find_nodes) to locate a node id,
then [`get_design_context`](#get_design_context) / [`get_text_styles`](#get_text_styles) /
[`get_screenshot`](#get_screenshot) on the chosen node.

---

### get_metadata

A sparse map of a Figma file: id/name/type/position/size per node, depth-limited. Cheap
navigation - call this first, then `get_design_context` on a chosen node_id. On large nodes the
depth degrades per-branch: light branches stay deep while heavy ones collapse; truncation reports
`effective_depth` (deepest shown) and `min_effective_depth` (shallowest branch), with
`truncated:true` + `childCount` on each cut node.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key |
| `node_id` | string | Scope the map to this node and its subtree; omit for the whole file |
| `depth` | integer 1–6 (default 2) | Tree depth. Higher = bigger map; start shallow then drill in. |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "node_id": "12:340",
  "depth": 3
}
```

---

### find_nodes

Find nodes by name OR text content (substring or fuzzy) inside a Figma file or a subtree, without
knowing node ids. Use this when node names are master-component placeholders rather than semantics
(e.g. the label "Cart" lives in a node named "All genres") - it also matches
the node's text (`characters`). Returns `node_id`, `name`, `type`, breadcrumb `path`, size, and
`matched_on` (`name`|`text`|`property`). Component-instance text set as a property override (e.g.
a DS section header) matches as `'property'`. Feed a `node_id` into `get_design_context` or
`get_text_styles`. Scope with `node_id` to search a single frame; omit it to search the whole file.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key |
| `query` | string | Name/text substring(s) to match; space-separated terms are AND-ed, case-insensitive. Omit to search by type alone (requires `type`). |
| `node_id` | string | Scope the search to this node's subtree; omit to search the whole file (slower, heavier). |
| `type` | string | Filter by node type, e.g. `FRAME`, `TEXT`, `INSTANCE`, `COMPONENT`. |
| `fuzzy` | boolean (default `false`) | Typo-tolerant fuzzy matching instead of substring. |
| `depth` | integer 1–10 (default 6) | How deep to fetch and search the subtree (keep modest on large files). |
| `limit` | integer 1–50 (default 20) | Max matches returned. |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "query": "add to cart",
  "node_id": "12:340",
  "type": "TEXT"
}
```

---

### get_node_ancestry

Breadcrumbs from a node UP to its page + direct children of every ancestor (siblings/neighbors).
Use when the node you need lies OUTSIDE the frame you know: call on a nearby known node and read
the ancestor children. bbox-guided, id-confirmed, <=12 light REST calls - never fetches the whole
file. `query` highlights matching names in scope.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key |
| `node_id` | string, **required** | A node you already know (anywhere in the file). Ancestry is resolved UP from it to the page. |
| `query` | string | Highlight ancestor children whose name contains this substring (case-insensitive) - surfaces neighbors even beyond the per-ancestor cap. |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "node_id": "12:341",
  "query": "footer"
}
```

---

### get_text_styles

Extract only the typography of a node's subtree (`fontFamily`, `fontWeight`, `fontSize`,
`lineHeightPx`, `letterSpacing`, `align`) without the full design tree - for fast spec
verification of a deep text node. Pass `dedupe=true` to group identical styles. Use `find_nodes`
first to get a node_id.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key |
| `node_id` | string, **required** | Root node - its text descendants' typography is returned (no full tree). |
| `include_color` | boolean (default `true`) | Join each text node's color (fill) - hex or token name. Text color lives on fill, not in textStyle. |
| `dedupe` | boolean (default `true`) | Group nodes that share an identical style into one entry. |
| `depth` | integer 1–10 (default 8) | How deep to fetch/walk the subtree. |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "node_id": "12:340",
  "dedupe": true
}
```

---

### compare_breakpoints

Compare one element's typography across several breakpoint frames in a single call. Pass the
breakpoint frame node_ids (one per width) and the element name (e.g. "tabs"); returns the
element's text-style per breakpoint with the frame name and width. Replaces opening each width
frame by hand.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key |
| `node_ids` | string[], **required** | Breakpoint frame node ids - one per width (e.g. desktop/laptop/tablet/mobile), 2 to 8 per call. Fetched in one call. |
| `name` | string, **required** | Element name/role to compare across breakpoints (e.g. "tabs"). |
| `fuzzy` | boolean (default `false`) | Typo-tolerant matching of the element name. |
| `include_color` | boolean (default `true`) | Include the element's text color per breakpoint. |
| `depth` | integer 1–10 (default 8) | Subtree depth fetched per frame. |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "node_ids": ["12:340", "12:400", "12:460"],
  "name": "title"
}
```

---

### get_screenshot

Render a Figma node to an image. Default `return=url` gives a short-lived signed URL plus pixel
dimensions and a curl hint (token-cheap - strongly preferred; avoids inlining megabytes of
base64). `return=inline` embeds the PNG/JPG as base64 or returns SVG markup directly, only for
agents that cannot fetch URLs. Use a lower `scale` for very large frames. `return=preview` gives a
one-step downscaled inline image plus the full-res URL.

Pass `focus={x,y}` (0..1, e.g. `target.atPercent` from `get_review_board`) to get a zoomed crop
centered on that point with a reticle marking it - ideal for seeing exactly what a review pin
points at; the crop is always PNG.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key |
| `node_id` | string, **required** | Node (frame/component/instance) to render |
| `format` | `"png"` \| `"svg"` \| `"jpg"` (default `"png"`) | Image format |
| `scale` | number 0.25–4 (default 2) | Raster scale (png/jpg); ignored for svg. Lower if the image is huge. |
| `return` | `"url"` \| `"inline"` \| `"preview"` (default `"url"`) | `url`: signed URL + dimensions + curl hint - token-cheap. `inline`: embed full PNG/JPG base64 or SVG markup. `preview`: ONE step - a downscaled inline image plus the full-res signed URL (cheap "what is this", with an escape hatch to full size). |
| `tiles` | boolean (default `false`) | For very large frames: also return a `children_map` (per-direct-child node_id, bounds, and a signed URL) so each part can be rendered legibly. Figma renders whole nodes, not regions, so tiling = per-child. |
| `focus` | object `{ x, y }` (0..1 each) | Point of interest within the node - e.g. `target.atPercent` from `get_review_board`. When set, returns a tight zoomed crop centered on this point (with a reticle marking it) instead of the whole node. |
| `focus_radius` | number 0.02–0.5 (default 0.12) | Focus-crop half-size as a fraction of node width (only used with `focus`). 0.12 gives a ~24%-wide window around the point. |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "node_id": "12:340",
  "return": "preview"
}
```

---

### export_assets

Export Figma nodes as rendered images (PNG/SVG/JPG) and return signed S3 URLs. Use `get_metadata`
first to find node IDs. Returns `url:null` for nodes Figma could not render. Set
`include_raw_images:true` to also return the ORIGINAL uploaded source images (IMAGE fills) per
node as `raw_images:[{imageRef,url}]`.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key |
| `node_ids` | string[], **required** | Node IDs to export (e.g. `["1:42", "1-43"]`). Up to 100 per call. |
| `format` | `"png"` \| `"svg"` \| `"jpg"` (default `"png"`) | Export format. `svg` omits the scale parameter. |
| `scale` | number 0.01–4 (default 2) | Export scale (png/jpg only). Ignored for svg. |
| `include_raw_images` | boolean (default `false`) | Also return the ORIGINAL uploaded source images (JPEG/PNG/GIF/WebP) used as IMAGE fills in the requested node subtrees. Adds up to 2 REST calls. |
| `image_depth` | integer 1–8 (default 4) | Subtree depth scanned for IMAGE fills when `include_raw_images=true`. |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "node_ids": ["12:350", "12:351"],
  "format": "svg"
}
```

---

### get_design_context

Extract a descriptive, code-oriented representation of a Figma node: layout (auto-layout), sizing,
fills/strokes/effects (deduplicated into `globalVars`), text + typography, and component
instances.

This is the flagship design->code extraction tool; in a design-QA flow it complements
[`compare_node_to_dom`](design-qa.md#compare_node_to_dom) - see the
[Design QA tutorial](../design-qa-tutorial.md).

Key behaviours (from the live tool description):

- A fill/stroke bound to a variable in a multi-mode collection (>1 mode) is resolved to an object
  in `globalVars`: `{ token, value (actual hex in the node's effective variable mode), mode,
  mode_dependent, mode_source }`. `mode_source:'node'` means the node's mode was confirmed via
  `explicitVariableModes`; `'default'` means the mode could not be determined and the default-mode
  value is shown - do not treat it as the on-screen color; such an object also carries a short
  `hint` pointing to `get_variables`' per-mode `modes` map for the actual value.
- When the value was decided by modes across MORE THAN ONE multi-mode collection (a
  cross-collection alias chain), the object also carries `modes_applied` - `{collection name:
  "mode name (node|default)"}` - every axis actually APPLIED to compute `value`. `modes_applied`
  explains the computation only - it makes NO on-screen claim (that is `mode_source`'s job).
- A top-level `mode_context` marker may be present: `"library_default_modes"` = this file is a
  registered component library rendered in its default variable modes - do NOT transfer these
  mode-dependent values to branded pages (the same tokens resolve differently there);
  `"default_modes"` = every shown mode-dependent value is its axis default. The marker appears
  only when the server has positive evidence; its absence claims nothing.
- A fill/stroke bound to a single-mode (non-mode-dependent) variable keeps its inline form: the
  local token name, or `var(--name, value)` for a cross-library variable.
- Human-authored component descriptions/documentation are returned as a deduped `components` map
  keyed by component id (disable with `include_component_docs:false`).
- Container nodes whose children were cut - by the requested depth, or by the size-budget
  auto-degrade when `degraded` is true - are marked `truncated:true` with `childCount`; request
  that node_id directly, raise `depth` (max 8, no effect when `degraded` is true), or use
  `get_metadata` to see them.
- The call runs under a server time budget: enrichment stages (variables resolution, ancestor-mode
  discovery, component docs, Code Connect, screenshot) that do not fit are skipped and listed in
  `degraded_stages [{stage, reason}]` - the core subtree is never time-degraded (the size budget's
  `degraded` flag is separate). If the subtree fetch itself exceeds the budget the call fails fast
  and suggests a lower depth.

Use `get_metadata` first to pick a `node_id`.

**Parameters**

| Parameter | Type | Description |
| --- | --- | --- |
| `file` | string, **required** | Figma file URL or raw key |
| `node_id` | string, **required** | The node to extract design context for (a frame/component/instance) |
| `depth` | integer 1–8 (default 4) | Subtree depth to extract. When the result exceeds the size budget the server auto-reduces depth (down to 1) instead of refusing; check `degraded`/`depth` in the response. |
| `include_component_docs` | boolean (default `true`) | Include human-authored component descriptions/documentation links as a deduped `components` map keyed by component id. Set `false` to shrink output. |
| `include_screenshot` | boolean (default `false`) | When `true`, also attach a short-lived signed PNG `screenshot` URL of the node for visual context (token-light - a URL string, never inline base64). Use `get_screenshot` for inline/SVG/scale control. |
| `screenshot_scale` | number 0.25–4 (default 2) | Raster scale for the `include_screenshot` PNG. |
| `figma_token` | string | Override Figma PAT |

**Example**

```json
{
  "file": "https://www.figma.com/design/AbCdEf012345/Product-Page",
  "node_id": "12:340",
  "depth": 4,
  "include_screenshot": true
}
```
