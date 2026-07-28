import type { RawComment, NodeRefMap } from '../domain/types.js';
import type { FileStructure } from '../domain/file-structure.js';
import type {
  RawFileResponse, RawNodesResponse, ImagesResult, ImageOptions, ImageFillsResult,
  RawVariablesResponse, FileVersion,
  RawTeamLibrary, PublishedComponent, PublishedComponentSet, PublishedComponentMeta,
} from '../domain/figma-raw.js';

export interface FrameRawResult {
  raw: RawNodesResponse;
  /** Depth the returned raw was fetched/held at. */
  heldDepth: number;
  /** True if held in the FrameHydrationStore (within parse cap); false if over cap (delivered
   *  once, not held — every drill re-fetches). Never claim held when it isn't. */
  hydrated: boolean;
  /** max_depth the caller should PROJECT at: min(requested, heldDepth-1). On a deep-fetch abort
   *  with a shallower held raw, this clamps the projection so the boundary childrenTruncated peek
   *  never reads an absent raw level (backoff-clamp). Equals requested when nothing was clamped. */
  effectiveMaxDepth: number;
}

export interface FigmaApi {
  /**
   * GET /v1/files/:key/comments?as_md=true.
   * Throws FigmaApiError on non-2xx or network failure.
   */
  getComments(fileKey: string): Promise<RawComment[]>;

  /**
   * GET /v1/files/:key/nodes?ids=…&depth=N
   * Returns a map from node_id (REST format "1:42") to { name, page_name }.
   * Used as a fallback for nodes deeper than the file-structure depth.
   * If `ids` is empty, returns an empty map without calling the API.
   */
  resolveNodes(fileKey: string, ids: string[], options?: { depth?: number }): Promise<NodeRefMap>;

  /**
   * GET /v1/files/:key?depth=N — the document skeleton.
   * Used to resolve page names and descendant nodes. Throws FigmaApiError on failure.
   */
  getFileStructure(fileKey: string): Promise<FileStructure>;

  /** GET /v1/files/:key?depth=N — full document with version/lastModified. Tier 1. */
  getDocumentRaw(fileKey: string, depth?: number): Promise<RawFileResponse>;

  /** GET /v1/files/:key/nodes?ids=…&depth=N — raw subtree per id. Tier 1. */
  getNodesRaw(fileKey: string, ids: string[], depth?: number): Promise<RawNodesResponse>;

  /** Frame-hydration fetch: holds the DEEPEST raw per frame id-set, re-slices ≤ heldDepth for
   *  free. `requestedMaxDepth` is the caller's max_depth (NOT the fetch depth); the adapter
   *  fetches at requestedMaxDepth+1 to honor the m+1 boundary-peek invariant. Bypasses nodeCache. */
  getFrameRaw(fileKey: string, ids: string[], requestedMaxDepth: number): Promise<FrameRawResult>;

  /** GET /v1/images/:key?ids=…&format=…&scale=… — rendered node images (signed URLs). Tier 1. */
  getImages(fileKey: string, ids: string[], opts: ImageOptions): Promise<ImagesResult>;
  /** GET /v1/files/:key/images — original uploaded image-fill source URLs keyed by imageRef. One call per file, cacheable by file+version. */
  getImageFills(fileKey: string): Promise<ImageFillsResult>;

  /** GET /v1/files/:key/variables/local — variables + collections. Tier 2, Enterprise only. */
  getVariablesLocal(fileKey: string): Promise<RawVariablesResponse>;

  /** GET /v1/files/:key?depth=1 — cheap version probe for cache keys. */
  getFileVersion(fileKey: string): Promise<FileVersion>;

  /** GET /v1/teams/:id/{components,component_sets,styles} — paginated, fully fetched. Tier 3. */
  getTeamLibrary(teamId: string): Promise<RawTeamLibrary>;

  /** GET /v1/teams/:id/projects — list projects in a team. */
  getTeamProjects(teamId: string): Promise<{ id: string; name: string }[]>;

  /** GET /v1/projects/:id/files — list files in a project. */
  getProjectFiles(projectId: string): Promise<{ key: string; name: string }[]>;

  /** GET /v1/files/:key/components — published components of a file library (for get_libraries). Tier 3. */
  getFileComponents(fileKey: string): Promise<PublishedComponent[]>;
  /** GET /v1/files/:key/component_sets — the file library's published component SETS (key/file_key/node_id/name/description). Resolves a variant's set-level description. */
  getFileComponentSets(fileKey: string): Promise<PublishedComponentSet[]>;

  /** GET /v1/components/:key — resolve a published component key to its library file_key/node_id. Tier 3. */
  getComponent(key: string): Promise<PublishedComponentMeta>;

  /** POST /v1/files/:key/comments — create a root comment. Throws FigmaApiError on non-2xx. */
  postComment(fileKey: string, input: { message: string }): Promise<RawComment>;
  /** POST /v1/files/:key/comments with comment_id — reply under an existing thread. */
  replyComment(fileKey: string, commentId: string, input: { message: string }): Promise<RawComment>;
  /**
   * DELETE /v1/files/:key/comments/:id - permanently delete a comment. Figma has no endpoint that
   * marks a thread resolved, so there is no "resolve" here to name; only the comment's author may
   * delete it, and nothing restores it. Resolves on 2xx.
   */
  deleteComment(fileKey: string, commentId: string): Promise<void>;
}
