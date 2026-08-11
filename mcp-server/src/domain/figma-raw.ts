// mcp-server/src/domain/figma-raw.ts
// Minimal structural types for the Figma REST shapes v0.5 consumes. Only fields
// we actually read are declared; everything is optional because Figma omits
// defaults (e.g. visible:true, opacity:1 are absent).

export interface RawColor { r: number; g: number; b: number; a?: number }

export interface RawVariableAlias { type: 'VARIABLE_ALIAS'; id: string }

export interface RawColorStop {
  position: number;
  color: RawColor;
  boundVariables?: { color?: RawVariableAlias };
}

export interface RawPaint {
  type: string; // SOLID | GRADIENT_LINEAR | IMAGE | ...
  imageRef?: string; // present on IMAGE fills — references the original uploaded source image
  visible?: boolean;
  opacity?: number;
  color?: RawColor;
  boundVariables?: Record<string, RawVariableAlias>;
  gradientStops?: RawColorStop[];
  gradientHandlePositions?: { x: number; y: number }[];
}

export interface RawEffect {
  type: string; // DROP_SHADOW | INNER_SHADOW | LAYER_BLUR | ...
  radius?: number;
  color?: RawColor;
  offset?: { x: number; y: number };
  spread?: number; // shadow: spread/choke; Figma omits it at 0 (default 0) — REST DOES return it (OpenAPI BaseShadowEffect.spread)
  visible?: boolean;
  // R2: widened from { color?: ... } — radius/spread/offset/offsetX/offsetY bindings render raw
  // too, so the mode_context scope scan must flag ANY effect binding key, not just color.
  boundVariables?: Record<string, RawVariableAlias>;
}

export interface RawTextStyle {
  styleName?: string; // applied text-style name, e.g. "body1/regular 16_24"
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  lineHeightPx?: number;
  lineHeightUnit?: string; // 'PIXELS' | 'FONT_SIZE_%' | 'INTRINSIC_%' — INTRINSIC_% ≈ browser 'normal'
  letterSpacing?: number;
  textAlignHorizontal?: string;
}

export interface RawSceneNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  opacity?: number;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  // Auto-layout child mode: 'ABSOLUTE' = out-of-flow (ignore in gap/padding math). Absent = in flow.
  layoutPositioning?: 'AUTO' | 'ABSOLUTE';
  layoutSizingHorizontal?: string; // FIXED | HUG | FILL (auto-layout children)
  // Radians in REST. Non-zero ⇒ absoluteBoundingBox is an AABB inflated by rotation — geometry unreliable.
  rotation?: number;
  children?: RawSceneNode[];
  // auto-layout
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL';
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  /** FIXED | AUTO. AUTO (the REST default) hugs the primary axis - there is no free space and
   *  the alignment keyword is inert; the layout-spec projector materializes primaryAlign only
   *  under FIXED for exactly that reason. */
  primaryAxisSizingMode?: string;
  minWidth?: number | null;
  maxWidth?: number | null;
  minHeight?: number | null;
  maxHeight?: number | null;
  // visual
  fills?: RawPaint[];
  strokes?: RawPaint[];
  strokeWeight?: number;
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  effects?: RawEffect[];
  // text
  characters?: string;
  textAutoResize?: string; // NONE | HEIGHT | WIDTH_AND_HEIGHT | TRUNCATE (TEXT nodes)
  style?: RawTextStyle;
  // instance
  componentId?: string;
  componentProperties?: Record<string, { type: string; value: unknown }>;
  // variable bindings: key = bound property (fills, cornerRadius, …)
  boundVariables?: Record<string, RawVariableAlias | RawVariableAlias[]>;
  // explicitly-set variable modes on THIS node (collectionId -> modeId); inherited by descendants
  explicitVariableModes?: Record<string, string>;
  // paint/text-style linkage: key = bound slot (fill, stroke, text, …) -> style id (e.g. "S:abc")
  styles?: Record<string, string>;
  // FigJam (board) fields — populated only on /board/ files
  authorVisible?: boolean;
  shapeType?: string;
  sectionContentsHidden?: boolean;
  connectorStart?: RawConnectorEndpoint;
  connectorEnd?: RawConnectorEndpoint;
  connectorStartStrokeCap?: string;
  connectorEndStrokeCap?: string;
}

// FigJam connector endpoint: which node an edge attaches to (or a free-floating position).
export interface RawConnectorEndpoint {
  endpointNodeId?: string;
  magnet?: string;
  position?: { x: number; y: number };
}

export interface RawFileResponse {
  name: string;
  lastModified: string;
  version: string;
  document: RawSceneNode;
  // Top-level component maps from GET /v1/files/:key — remote:true marks a component consumed from another library.
  components?: Record<string, ComponentRefMeta>;
  componentSets?: Record<string, ComponentRefMeta>;
}

// Per-node `components` map in /v1/files/:key/nodes — instance componentId → published ref.
// The Component object carries componentSetId (the set's node id) for variants, even for remote
// components — unlike GET /v1/components/:key which omits it.
export interface ComponentRefMeta { key: string; name?: string; remote?: boolean; componentSetId?: string }

// Style metadata for an entry's `styles` map — style id (e.g. "S:abc") -> this.
export interface RawStyleMeta { name: string; styleType: string }

export interface RawNodesResponse {
  nodes: Record<string, { document: RawSceneNode; components?: Record<string, ComponentRefMeta>; componentSets?: Record<string, ComponentRefMeta>; styles?: Record<string, RawStyleMeta> } | null>;
}

// GET /v1/components/:key → { meta: <this> }. Resolves a published component key
// to the library file_key + node_id where the component is defined.
export interface PublishedComponentMeta {
  key: string;
  file_key: string;
  node_id: string;
  name: string;
  // GET /v1/components/:key also returns these — optional so existing {key,file_key,node_id,name} mocks still compile.
  description?: string;
  componentSetId?: string;
  documentationLinks?: { uri: string }[];
  containing_frame?: { nodeId?: string; name?: string; pageName?: string };
}

export type RawVariableValue = number | string | boolean | RawColor | RawVariableAlias;

export interface RawVariable {
  id: string;
  name: string;
  resolvedType: 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN';
  valuesByMode: Record<string, RawVariableValue>;
  variableCollectionId: string;
  // The DS team's own authored name->code mapping (REQUIRED in the REST payload — the real
  // "no evidence" shape is codeSyntax:{} — but optional here: older fixtures/caches omit it).
  // Free text with no validation; extractCssName (variables.ts) is the only reader.
  codeSyntax?: { WEB?: string; ANDROID?: string; iOS?: string };
}

export interface RawVariableCollection {
  id: string;
  name: string;
  modes: { modeId: string; name: string }[];
  defaultModeId: string;
}

export interface RawVariablesResponse {
  status?: number;
  error?: boolean;
  meta?: {
    variables: Record<string, RawVariable>;
    variableCollections: Record<string, RawVariableCollection>;
  };
}

export interface ImageOptions {
  format: 'png' | 'svg' | 'jpg';
  scale?: number; // 0.01..4, default 2
}

export interface ImagesResult {
  images: Record<string, string | null>; // node_id → signed URL (null if Figma failed that node)
}

// GET /v1/files/:key/images — original image-fill source URLs keyed by imageRef.
export interface RawImageFillsResponse { error?: boolean; status?: number; meta?: { images?: Record<string, string> } }
export interface ImageFillsResult { images: Record<string, string> } // imageRef → temporary URL

export interface FileVersion {
  version: string;
  name: string;
  lastModified: string;
}

// ── Published library assets (GET /v1/teams/:id/components|component_sets|styles) ──

export interface FrameInfo {
  pageName: string;
  name?: string;
  containingComponentSet?: { nodeId: string; name: string } | null;
}

export interface PublishedComponent {
  key: string;
  file_key: string;
  node_id: string;
  name: string;
  description: string;
  thumbnail_url?: string;
  containing_frame?: FrameInfo;
}

// Component sets have the same published shape as components.
export type PublishedComponentSet = PublishedComponent;

export interface PublishedStyle {
  key: string;
  file_key: string;
  node_id: string;
  name: string;
  description: string;
  style_type: 'FILL' | 'TEXT' | 'EFFECT' | 'GRID';
}

export interface RawTeamLibrary {
  components: PublishedComponent[];
  componentSets: PublishedComponentSet[];
  styles: PublishedStyle[];
}

export interface PagedCursor {
  before?: number;
  after?: number;
}

// First bound-color alias for a paint key, BOTH binding forms. The paint-level binding of the
// first visible SOLID paint carrying a color wins - that is byte-for-byte the paint the hex is
// measured from (simplify.ts paintValue) - else the node-level boundVariables[key] (REST emits
// an alias or an array of aliases there; the first counts). No visible solid paint -> undefined:
// nothing was measured, so nothing is bound.
// The ONE lookup every diff-side consumer shares (projector *BoundVar, resolveColorToken, the
// variables demand gates, the snapshot-prefetch collector). It exists because a partial mirror -
// paint-level in the diff path, node-level-first in get_design_context - let a node-level-bound
// fill reach the verdict as a raw literal and FAIL over correct code (feedback 15.1). Lives in
// this leaf module because variables.ts imports mode-resolve.ts: any shared home higher up cycles.
export function colorAliasId(n: RawSceneNode, key: 'fills' | 'strokes'): string | undefined {
  const solid = n[key]?.find((p) => p.visible !== false && p.type === 'SOLID' && p.color);
  if (!solid) return undefined;
  const paintLevel = solid.boundVariables?.color?.id;
  if (paintLevel !== undefined) return paintLevel;
  const nodeLevel = n.boundVariables?.[key];
  const alias = Array.isArray(nodeLevel) ? nodeLevel[0] : nodeLevel;
  return alias?.id;
}
