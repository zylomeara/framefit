import { z } from 'zod';
import { NODE_ID_RE, normalizeNodeId } from '../../../domain/node-id.js';
import type { FilterCriteria } from '../../../domain/types.js';

// Reusable Zod shape for filter params (spread into each tool's input).
export const FilterSchema = {
  file: z.string().min(1).describe('Figma file URL or raw file key'),
  include_resolved: z.boolean().default(true).describe('Include resolved threads'),
  node_id: z
    .string()
    .regex(NODE_ID_RE, 'expected format like "1:42" or "1-42"')
    .optional()
    .describe('Filter threads anchored to this node (exact unless include_descendants=true)'),
  include_descendants: z
    .boolean()
    .default(false)
    .describe('With node_id, also include threads on descendant nodes (e.g. all threads on a page)'),
  node_type: z
    .enum(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP', 'SECTION', 'TEXT', 'CANVAS'])
    .optional()
    .describe('Only threads anchored to a node of this Figma type'),
  author_id: z.string().min(1).optional().describe('Filter by stable user.id (preferred)'),
  author_handle: z.string().min(1).optional().describe('Filter by display name (handles can change)'),
  message_contains: z.string().min(1).optional().describe('Case-insensitive substring filter on message (root + replies)'),
  since: z.string().datetime().optional().describe('Only threads where root.created_at >= this ISO8601 time'),
  until: z.string().datetime().optional().describe('Only threads where root.created_at <= this ISO8601 time'),
  min_replies: z.number().int().min(0).optional().describe('Only threads with at least N replies'),
  min_reactions: z.number().int().min(0).optional().describe('Only threads whose root has at least N reactions'),
  has_mentions: z.boolean().optional().describe('Only threads with @-mentions in root or any reply'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT; falls back to FIGMA_TOKEN env'),
};

// Build a normalized FilterCriteria from validated tool args.
export function toCriteria(args: {
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
}): FilterCriteria {
  return {
    include_resolved: args.include_resolved,
    node_id: args.node_id ? normalizeNodeId(args.node_id) : undefined,
    include_descendants: args.include_descendants,
    node_type: args.node_type,
    author_id: args.author_id,
    author_handle: args.author_handle,
    message_contains: args.message_contains,
    since: args.since,
    until: args.until,
    min_replies: args.min_replies,
    min_reactions: args.min_reactions,
    has_mentions: args.has_mentions,
  };
}
