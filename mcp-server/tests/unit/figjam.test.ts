import { describe, it, expect } from 'vitest';
import { simplifyFigjam } from '../../src/domain/figjam.js';

const board = {
  id: '0:0', name: 'Page', type: 'CANVAS', children: [
    { id: '1:1', name: 'Note', type: 'STICKY', characters: 'Hello', authorVisible: true, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 0 } }] },
    { id: '1:2', name: 'Shape', type: 'SHAPE_WITH_TEXT', shapeType: 'ROUNDED_RECTANGLE', characters: 'Box' },
    { id: '1:3', name: 'Edge', type: 'CONNECTOR', characters: 'depends on', connectorStart: { endpointNodeId: '1:1' }, connectorEnd: { endpointNodeId: '1:2' } },
    { id: '1:4', name: 'Group', type: 'SECTION', sectionContentsHidden: false, children: [
      { id: '1:5', name: 'T', type: 'TABLE', children: [
        { id: '1:6', name: 'c', type: 'TABLE_CELL', characters: 'A' },
        { id: '1:7', name: 'c', type: 'TABLE_CELL', characters: 'B' },
      ] },
      { id: '1:8', name: 'Hidden', type: 'STICKY', characters: 'secret', visible: false },
    ] },
  ],
} as any;

describe('simplifyFigjam', () => {
  it('buckets stickies/shapes/connectors/sections/tables and resolves sticky color', () => {
    const out = simplifyFigjam(board, { file: 'F', depth: 6 });
    const note = out.stickies.find((s) => s.id === '1:1')!;
    expect(note).toMatchObject({ text: 'Hello', authorVisible: true });
    expect(note.color).toMatch(/^#/);
    expect(out.shapes[0]).toMatchObject({ shapeType: 'ROUNDED_RECTANGLE', text: 'Box' });
    expect(out.connectors[0]).toMatchObject({ from: '1:1', to: '1:2', label: 'depends on' });
    expect(out.sections[0]).toMatchObject({ name: 'Group', contentsHidden: false });
    expect(out.sections[0].childIds).toEqual(['1:5', '1:8']);
    expect(out.tables[0].cells).toEqual(['A', 'B']);
    expect(out.nodeNames['1:1']).toBe('Note');
  });

  it('excludes hidden nodes by default and includes them with includeHidden', () => {
    expect(simplifyFigjam(board, { file: 'F', depth: 6 }).stickies.some((s) => s.text === 'secret')).toBe(false);
    expect(simplifyFigjam(board, { file: 'F', depth: 6, includeHidden: true }).stickies.some((s) => s.text === 'secret')).toBe(true);
  });

  it('omits a connector label when there is no text', () => {
    const b = { id: '0:0', name: 'P', type: 'CANVAS', children: [{ id: '2:1', name: 'E', type: 'CONNECTOR', connectorStart: { endpointNodeId: 'a' }, connectorEnd: { endpointNodeId: 'b' } }] } as any;
    expect(simplifyFigjam(b, { file: 'F', depth: 4 }).connectors[0].label).toBeUndefined();
  });

  it('marks truncated when depth cuts children', () => {
    expect(simplifyFigjam(board, { file: 'F', depth: 1 }).truncated).toBe(true);
  });
});
