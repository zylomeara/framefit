import { describe, it, expect } from 'vitest';
import { rowsToGraphInput } from '../../src/multi-tenant/library-graph-db.js';
import { buildGraphMaps } from '../../src/domain/variable-graph.js';

describe('rowsToGraphInput', () => {
  it('carries collection modes from the JSONB column into the buildGraphMaps input', () => {
    const varRows = [{ file_key: 'L1', library_key: 'k'.repeat(40), local_id: 'VariableID:1:1', collection_id: 'C',
      values_by_mode: { m1: { r: 1, g: 1, b: 1 } }, name: 'x' }];
    const collRows = [{ file_key: 'L1', collection_id: 'C', default_mode: 'm1',
      modes: [{ modeId: 'm1', name: 'Default' }, { modeId: 'm2', name: 'Dark' }], name: 'Theme', key: 'facade'.padEnd(40, '0') }];

    const { vars, colls } = rowsToGraphInput(varRows, collRows);

    expect(colls[0].modes).toEqual([{ modeId: 'm1', name: 'Default' }, { modeId: 'm2', name: 'Dark' }]);
    expect(colls[0]).toEqual({ collection_id: 'C', default_mode: 'm1', fileKey: 'L1',
      modes: [{ modeId: 'm1', name: 'Default' }, { modeId: 'm2', name: 'Dark' }], name: 'Theme', key: 'facade'.padEnd(40, '0') });
    expect(vars[0]).toEqual({ library_key: 'k'.repeat(40), local_id: 'VariableID:1:1', collection_id: 'C',
      values_by_mode: { m1: { r: 1, g: 1, b: 1 } }, name: 'x', fileKey: 'L1' });
  });

  it('defaults modes to [] when the DB row has no modes value', () => {
    const collRows = [{ file_key: 'L1', collection_id: 'C', default_mode: 'm1' }];

    const { colls } = rowsToGraphInput([], collRows);

    expect(colls[0].modes).toEqual([]);
  });

  it("defaults name to '' when the DB row predates the name column (pre-resync)", () => {
    const { colls } = rowsToGraphInput([], [{ file_key: 'L1', collection_id: 'C', default_mode: 'm1' }]);
    expect(colls[0].name).toBe('');
  });

  it("defaults key to '' when the DB row predates the key column", () => {
    const { colls } = rowsToGraphInput([], [{ file_key: 'L1', collection_id: 'C', default_mode: 'm1' }]);
    expect(colls[0].key).toBe('');
  });

  it('is a pure mapping — no DB, and its output feeds buildGraphMaps to populate collModes', () => {
    const varRows = [{ file_key: 'L1', library_key: 'k'.repeat(40), local_id: 'VariableID:1:1', collection_id: 'C',
      values_by_mode: { m1: '#fff', m2: '#000' }, name: 'bg' }];
    const collRows = [{ file_key: 'L1', collection_id: 'C', default_mode: 'm1',
      modes: [{ modeId: 'm1', name: 'Light' }, { modeId: 'm2', name: 'Dark' }] }];

    const { vars, colls } = rowsToGraphInput(varRows, collRows);
    const graph = buildGraphMaps(vars, colls);

    expect(graph.collModes.get('L1|C')).toEqual([{ modeId: 'm1', name: 'Light' }, { modeId: 'm2', name: 'Dark' }]);
  });
});
