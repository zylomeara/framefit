import { describe, it, expect } from 'vitest';
import { collectTextStyles, dedupeTextStyles, styleForName } from '../../src/domain/text-styles.js';
import type { SimplifiedNode } from '../../src/domain/design-context/types.js';

const globalVars = {
  text_0: { fontFamily: 'Inter', fontWeight: 400, fontSize: 40, lineHeightPx: 42 },
  text_1: { fontFamily: 'Inter', fontWeight: 400, fontSize: 24, lineHeightPx: 28 },
  fill_0: '#111111',
};
const frame: SimplifiedNode = {
  id: '1:0', name: 'tabs', type: 'FRAME', size: { w: 1280, h: 40 }, children: [
    { id: '1:1', name: 'Tab one', type: 'TEXT', text: 'Books', textStyle: 'text_0', fill: 'fill_0' },
    { id: '1:2', name: 'Tab two', type: 'TEXT', text: 'Audio', textStyle: 'text_0', fill: 'fill_0' },
    { id: '1:3', name: 'Caption', type: 'TEXT', text: 'x', textStyle: 'text_1' },
  ],
};

describe('text-styles', () => {
  it('collects text styles with inlined object + path + color', () => {
    const hits = collectTextStyles(frame, globalVars, { includeColor: true });
    expect(hits).toHaveLength(3);
    const tab = hits.find((h) => h.node_id === '1:1')!;
    expect(tab.textStyle).toEqual({ fontFamily: 'Inter', fontWeight: 400, fontSize: 40, lineHeightPx: 42 });
    expect(tab.fill).toBe('#111111');
    expect(tab.path).toEqual(['tabs']);
  });

  it('omits color when includeColor is false', () => {
    const hits = collectTextStyles(frame, globalVars, { includeColor: false });
    expect(hits[0].fill).toBeUndefined();
  });

  it('dedupe groups identical styles', () => {
    const groups = dedupeTextStyles(collectTextStyles(frame, globalVars, { includeColor: true }));
    expect(groups).toHaveLength(2); // text_0+fill_0 (×2) and text_1
    const big = groups.find((g) => (g.textStyle as any).fontSize === 40)!;
    expect(big.nodes.map((n) => n.node_id)).toEqual(['1:1', '1:2']);
  });

  it('styleForName returns the matched node\'s style', () => {
    const hit = styleForName(frame, globalVars, 'Tab two', { includeColor: true });
    expect(hit?.node_id).toBe('1:2');
    expect((hit?.textStyle as any).fontSize).toBe(40);
  });
});
