// Headless FigJam (board) simplifier. The official get_figjam generates UI code; this
// returns a structured representation of board content reachable via the same REST node
// tree: sticky notes, shapes-with-text, sections, connectors (edges), and tables.
import type { RawSceneNode } from './figma-raw.js';
import { rgbaToHex } from './design-context/color.js';

export interface FigjamSticky { id: string; text?: string; color?: string; authorVisible?: boolean }
export interface FigjamShape { id: string; shapeType?: string; text?: string; color?: string }
export interface FigjamSection { id: string; name: string; contentsHidden?: boolean; childIds: string[] }
export interface FigjamConnector { id: string; from?: string; to?: string; label?: string; startCap?: string; endCap?: string }
export interface FigjamTable { id: string; name?: string; cells: string[] }

export interface FigjamBoard {
  file: string;
  stickies: FigjamSticky[];
  shapes: FigjamShape[];
  sections: FigjamSection[];
  connectors: FigjamConnector[];
  tables: FigjamTable[];
  nodeNames: Record<string, string>; // id → name, so connector from/to ids can be labelled
  truncated?: boolean;               // children existed but were cut by the depth limit
}

function dominantColor(node: RawSceneNode): string | undefined {
  for (const p of node.fills ?? []) {
    if (p.visible === false) continue;
    if (p.type === 'SOLID' && p.color) return rgbaToHex(p.color);
  }
  return undefined;
}

// REST does not expose table rowIndex/columnIndex, so cells degrade to an ordered flat list.
function tableCells(node: RawSceneNode): string[] {
  const cells: string[] = [];
  const walk = (n: RawSceneNode): void => {
    for (const c of n.children ?? []) {
      if (c.type === 'TABLE_CELL') { if (c.characters) cells.push(c.characters); }
      else walk(c);
    }
  };
  walk(node);
  return cells;
}

export function simplifyFigjam(root: RawSceneNode, opts: { file: string; depth: number; includeHidden?: boolean }): FigjamBoard {
  const board: FigjamBoard = { file: opts.file, stickies: [], shapes: [], sections: [], connectors: [], tables: [], nodeNames: {} };
  let truncated = false;

  const walk = (n: RawSceneNode, depth: number): void => {
    if (n.visible === false && !opts.includeHidden) return;
    board.nodeNames[n.id] = n.name;

    switch (n.type) {
      case 'STICKY': {
        const color = dominantColor(n);
        board.stickies.push({
          id: n.id,
          ...(n.characters ? { text: n.characters } : {}),
          ...(color ? { color } : {}),
          ...(n.authorVisible !== undefined ? { authorVisible: n.authorVisible } : {}),
        });
        break;
      }
      case 'SHAPE_WITH_TEXT': {
        const color = dominantColor(n);
        board.shapes.push({
          id: n.id,
          ...(n.shapeType ? { shapeType: n.shapeType } : {}),
          ...(n.characters ? { text: n.characters } : {}),
          ...(color ? { color } : {}),
        });
        break;
      }
      case 'CONNECTOR':
        board.connectors.push({
          id: n.id,
          ...(n.connectorStart?.endpointNodeId ? { from: n.connectorStart.endpointNodeId } : {}),
          ...(n.connectorEnd?.endpointNodeId ? { to: n.connectorEnd.endpointNodeId } : {}),
          ...(n.characters ? { label: n.characters } : {}),
          ...(n.connectorStartStrokeCap ? { startCap: n.connectorStartStrokeCap } : {}),
          ...(n.connectorEndStrokeCap ? { endCap: n.connectorEndStrokeCap } : {}),
        });
        break;
      case 'SECTION':
        board.sections.push({
          id: n.id,
          name: n.name,
          ...(n.sectionContentsHidden !== undefined ? { contentsHidden: n.sectionContentsHidden } : {}),
          childIds: (n.children ?? []).map((c) => c.id),
        });
        break;
      case 'TABLE':
        board.tables.push({ id: n.id, name: n.name, cells: tableCells(n) });
        break;
    }

    if (depth <= 1) {
      if (n.children && n.children.length) truncated = true;
      return;
    }
    for (const c of n.children ?? []) walk(c, depth - 1);
  };

  walk(root, opts.depth);
  if (truncated) board.truncated = true;
  return board;
}
