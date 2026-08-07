import { describe, it, expect } from 'vitest';
import { simplify } from '../../src/domain/design-context/simplify.js';
import { styleForName } from '../../src/domain/text-styles.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';

// A frame whose target node's NAME is a placeholder but whose text is "Корзина".
const frame: RawSceneNode = {
  id: '1:0', name: 'desktop', type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 },
  children: [
    {
      id: '1:1', name: 'Все жанры', type: 'TEXT', characters: 'Корзина',
      style: { fontFamily: 'Inter', fontWeight: 700, fontSize: 24, lineHeightPx: 32, letterSpacing: 0, textAlignHorizontal: 'LEFT' },
    },
  ],
};

describe('compare_breakpoints text matching', () => {
  it('finds the element by text when the name is a placeholder', () => {
    const { node, globalVars } = simplify(frame);
    const hit = styleForName(node, globalVars, 'Корзина', { includeColor: false });
    expect(hit).not.toBeNull();
    expect(hit!.node_id).toBe('1:1');
    expect((hit!.textStyle as { fontSize?: number }).fontSize).toBe(24);
  });
});
