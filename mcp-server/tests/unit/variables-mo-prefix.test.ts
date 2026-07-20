import { describe, it, expect } from 'vitest';
import { listTokens } from '../../src/domain/variables.js';
import { extractLibraryKey } from '../../src/domain/variable-snapshot.js';
import type { RawVariablesResponse } from '../../src/domain/figma-raw.js';

const resp: RawVariablesResponse = { meta: {
  variableCollections: { 'VC': { id: 'VC', name: 'Motion', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] } } as any,
  variables: {
    'V1': { id: 'V1', name: '--mo-duration-fast', resolvedType: 'FLOAT', variableCollectionId: 'VC', valuesByMode: { m: 120 } } as any,
    'V2': { id: 'V2', name: '--mo-ease-standard', resolvedType: 'STRING', variableCollectionId: 'VC',
      valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 'VariableID:ABCDEF0123456789ABCDEF0123456789ABCDEF01/2:2' } } } as any,
  },
} } as any;

describe('--mo- variables are not dropped', () => {
  it('lists both --mo- tokens (literal + unresolved cross-library alias)', () => {
    const names = listTokens(resp).map((t) => t.name);
    expect(names).toContain('--mo-duration-fast');
    expect(names).toContain('--mo-ease-standard');
  });

  it('extractLibraryKey is case-insensitive and normalises to lower-hex', () => {
    expect(extractLibraryKey('VariableID:abcdef0123456789abcdef0123456789abcdef01/2:2')).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(extractLibraryKey('VariableID:ABCDEF0123456789ABCDEF0123456789ABCDEF01/2:2')).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(extractLibraryKey('not-a-variable-id')).toBeNull();
  });
});
