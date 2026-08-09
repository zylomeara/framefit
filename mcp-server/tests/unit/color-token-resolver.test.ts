// The shared color-token resolver factory: the empty-name producers (panel-found — the graph and
// snapshot name columns are NOT NULL DEFAULT '', so `?? libKey` never fired and an EMPTY token
// name leaked into rows, degrading confirm_token grouping which keys on truthy r.token).
import { describe, it, expect } from 'vitest';
import { makeColorTokenResolver } from '../../src/adapters/driving/tools/color-token-resolver.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';

const LIBKEY = 'a'.repeat(40);
const boundNode = (aliasId: string): RawSceneNode => ({
  id: '1:1', name: 'n', type: 'FRAME',
  fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: aliasId } } }],
} as RawSceneNode);
const stacks = { stackFor: () => new Map<string, string>(), graphStackFor: () => new Map<string, string>(), coverageComplete: false };

describe('empty-name producers fall back to the library key', () => {
  it('snapshot tail: name "" (NOT NULL DEFAULT) → token is the libKey, never empty', () => {
    const resolve = makeColorTokenResolver({ ...stacks,
      snapHits: new Map([[LIBKEY, { value: '#123456', name: '' }]]) });
    const t = resolve(boundNode(`VariableID:${LIBKEY}/1:2`), 'fills');
    expect(t?.token).toBe(LIBKEY);
    expect(t?.snapshot_default).toBe(true);
  });
  it('graph tail: token "" → libKey', () => {
    const resolve = makeColorTokenResolver({ ...stacks,
      variableGraph: {
        resolve: () => undefined,
        resolveInMode: () => ({ token: '', value: '#123456', mode_dependent: false, mode_source: 'default' as const, pinned_axis_used: false, unconfirmed_default_used: false }),
      } });
    const t = resolve(boundNode(`VariableID:${LIBKEY}/1:2`), 'fills');
    expect(t?.token).toBe(LIBKEY);
  });
});
