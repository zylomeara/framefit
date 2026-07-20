import type { ThreadAnchor } from './types.js';

export function renderAnchorLabel(a: ThreadAnchor): string {
  switch (a.kind) {
    case 'canvas_point':
      return `pinned to canvas at (${a.x}, ${a.y})`;
    case 'canvas_region':
      return `region on canvas at (${a.x}, ${a.y}) ${a.width}×${a.height}`;
    case 'node': {
      const name = a.node_name ? `on ${a.node_name} · node: ${a.node_id}` : `on node ${a.node_id}`;
      const page = a.page_name ? ` · page: ${a.page_name}` : '';
      return `${name}${page}`;
    }
    case 'node_region': {
      const name = a.node_name
        ? `region on ${a.node_name} · node: ${a.node_id}`
        : `region on node ${a.node_id}`;
      const page = a.page_name ? ` · page: ${a.page_name}` : '';
      return `${name}${page}`;
    }
  }
}
