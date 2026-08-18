// mcp-server/src/domain/design-context/types.ts
import type { CodeConnectSnippet } from '../code-connect-enrich.js';

export interface SimplifiedNode {
  id: string;
  name: string;
  type: string;
  size?: { w: number; h: number };
  layout?: { mode: 'row' | 'col'; gap?: number; padding?: string; primaryAlign?: string; counterAlign?: string; minW?: number; maxW?: number; minH?: number; maxH?: number };
  fill?: string;        // ref into globalVars (may point at a ResolvedToken object) OR a token name
  stroke?: string;      // ref into globalVars (may point at a ResolvedToken object)
  strokeWeight?: number;
  cornerRadius?: number;
  opacity?: number;
  effects?: string;     // ref into globalVars
  text?: string;
  textStyle?: string;   // ref into globalVars
  component?: { id: string; props?: Record<string, unknown> };
  children?: SimplifiedNode[];
  truncated?: boolean; // children existed but were cut by auto-degrade depth
  childCount?: number; // direct (visible) child count of a truncated node — how many were cut
}

// Per-component documentation, deduped by component id (one entry per distinct component
// used in the subtree — instances reference it via SimplifiedNode.component.id).
export interface ComponentDoc {
  name?: string;
  description?: string;
  componentSet?: { name?: string; description?: string };
  docs?: string[]; // documentation link uris
}

export interface ConcreteComponentInstance {
  node_id: string;
  name: string;
  path: string[];
}

export interface ResolutionHints {
  reason: 'definition_has_no_rendered_children';
  next_call:
    | { tool: 'find_nodes'; arguments: { file: string; query: string; type: 'INSTANCE'; depth: 8; limit: 20 } }
    | { tool: 'get_design_context'; arguments: { file: string; node_id: string; depth: number } };
}

export interface DesignContext {
  file: string;
  node: SimplifiedNode;
  globalVars: Record<string, unknown>;
  codeConnect?: Record<string, CodeConnectSnippet>;
  components?: Record<string, ComponentDoc>;
  screenshot?: string; // short-lived signed PNG URL, only when include_screenshot=true
  /** Rendered instances discovered for an otherwise-empty component definition (at most five). */
  concrete_instances?: ConcreteComponentInstance[];
  /** One executable continuation for resolving an empty component definition to a rendered instance. */
  resolution_hints?: ResolutionHints;
  depth?: number;
  degraded?: boolean;
  hint?: string; // set when any node in `node` was cut by the depth limit (see SimplifiedNode.truncated)
  /** Positive-evidence context marker: every shown mode-dependent value is an axis default.
   * 'library_default_modes' additionally means the file is a registered component library —
   * do NOT transfer these values to branded pages. Absent = no claim. */
  mode_context?: 'library_default_modes' | 'default_modes';
  /** Enrichment stages skipped/failed under the per-call time budget. The core subtree is never
   * time-degraded (see `degraded` for the size budget). Reasons: time_budget (skipped to fit),
   * error (stage failed), cached_error (known-broken endpoint, negative-cached). */
  degraded_stages?: { stage: 'variables' | 'ancestor_discovery' | 'component_docs' | 'code_connect' | 'screenshot'; reason: 'time_budget' | 'error' | 'cached_error' }[];
}
