// Wire shape from Figma REST. Four forms, distinguished structurally
// (no `kind` discriminator on the wire — `decodeAnchor` infers it).
export type ClientMetaVector = {
  x: number;
  y: number;
};

export type ClientMetaFrameOffset = {
  node_id: string;
  node_offset: { x: number; y: number };
};

export type ClientMetaRegion = {
  x: number;
  y: number;
  region_height: number;
  region_width: number;
};

export type ClientMetaFrameOffsetRegion = {
  node_id: string;
  region_offset: { x: number; y: number };
  region_height: number;
  region_width: number;
};

export type ClientMeta =
  | ClientMetaVector
  | ClientMetaFrameOffset
  | ClientMetaRegion
  | ClientMetaFrameOffsetRegion;

// Raw shape from Figma REST /v1/files/:key/comments — matches
// figma/rest-api-spec openapi.yaml Comment schema.
export type RawComment = {
  id: string;
  // empty string (or absent) = root; otherwise id of the root being replied to.
  parent_id?: string;
  message: string;
  user: { id: string; handle: string; img_url: string };
  created_at: string; // ISO
  resolved_at?: string | null;
  client_meta: ClientMeta;
  order_id?: string | null; // numeric string for roots; null for replies
  reactions?: Array<{
    user: { id: string; handle: string; img_url: string };
    emoji: string; // shortcode like ":heart:"
    created_at: string;
  }>;
};

// Decoded comment for use case output.
export type CommentInThread = {
  id: string;
  author: { id: string; handle: string };
  created_at: string;
  message: string;
  mentions: string[];
  reactions_count: number;
};

export type ThreadAnchor =
  | { kind: 'canvas_point'; x: number; y: number; page_name?: string }
  | { kind: 'canvas_region'; x: number; y: number; width: number; height: number; page_name?: string }
  | { kind: 'node'; node_id: string; node_name: string; page_name: string; offset: { x: number; y: number } }
  | { kind: 'node_region'; node_id: string; node_name: string; page_name: string; offset: { x: number; y: number }; width: number; height: number };

export type Thread = {
  id: string; // root comment id
  kind: 'single' | 'thread'; // single = no replies
  resolved: boolean;
  anchor: ThreadAnchor;
  root: CommentInThread;
  replies: CommentInThread[];
};

// Map node_id (REST format, e.g. "1:42") → { name, page_name }.
export type NodeRefMap = Map<string, { name: string; page_name: string }>;

// Result helper for parsing.
export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// Filter criteria shared by all three tools (node_id already normalized to "1:42").
export type FilterCriteria = {
  include_resolved: boolean;
  node_id?: string;
  include_descendants: boolean;
  node_type?: string;
  author_id?: string;
  author_handle?: string;
  message_contains?: string;
  since?: string;
  until?: string;
  min_replies?: number;
  min_reactions?: number;
  has_mentions?: boolean;
};

// summarize_comments output
export type AuthorStat = {
  author_id: string;
  author_handle: string;
  total: number;
  open: number;
  resolved: number;
};
export type NodeStat = { node_id: string; node_name: string; page_name: string; count: number };
export type TopThread = {
  thread_id: string;
  root_author: string;
  root_excerpt: string;
  replies_count: number;
  anchor_label: string;
};
export type DateStat = { week: string; count: number };
export type SummarizeOutput = {
  total: number;
  open: number;
  resolved: number;
  by_author: AuthorStat[];
  by_anchor: { canvas_point: number; canvas_region: number; node: number; node_region: number };
  by_top_nodes: NodeStat[];
  top_threads_by_replies: TopThread[];
  by_date: DateStat[];
  with_mentions: number;
};

// find_threads output
export type MatchedThread = {
  thread_id: string;
  score: number;
  matched_in: 'root' | 'reply';
  anchor_label: string;
  root_author: string;
  root_excerpt: string;
  highlight: string;
};
