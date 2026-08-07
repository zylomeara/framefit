import { describe, it, expect } from 'vitest';
import { normalizeEntries, extractLibraryKey } from '../../src/domain/variable-snapshot.js';

describe('normalizeEntries', () => {
  it('keeps well-formed entries, coerces value to string, drops malformed', () => {
    const raw = [
      { key: '282909df', value: '#f6f6f9', resolved_type: 'COLOR', name: 'bg/level -1' },
      { key: 'b2b2c4d6', value: 16, resolved_type: 'FLOAT', name: 'space/md' },
      { key: '', value: '#fff', resolved_type: 'COLOR', name: 'x' },  // no key → drop
      { value: '#fff', resolved_type: 'COLOR' },                       // no key → drop
      'garbage',                                                       // not object → drop
    ];
    const out = normalizeEntries(raw as unknown[]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ key: '282909df', value: '#f6f6f9', resolved_type: 'COLOR', name: 'bg/level -1' });
    expect(out[1]).toEqual({ key: 'b2b2c4d6', value: '16', resolved_type: 'FLOAT', name: 'space/md' });
  });

  it('lowercases the stored key so snapshot lookup (which uses extractLibraryKey) always matches', () => {
    const raw = [
      { key: '282909DF', value: '#f6f6f9', resolved_type: 'COLOR', name: 'bg/level -1' },  // uppercase
      { key: 'B2B2C4D6', value: 16, resolved_type: 'FLOAT', name: 'space/md' },              // uppercase
    ];
    const out = normalizeEntries(raw as unknown[]);
    expect(out[0].key).toBe('282909df');
    expect(out[1].key).toBe('b2b2c4d6');
  });

  it('extractLibraryKey pulls the 40-hex key out of a subscribed alias id', () => {
    expect(extractLibraryKey('VariableID:b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2/45:67')).toBe('b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2');
    expect(extractLibraryKey('V:1')).toBeNull();
    expect(extractLibraryKey('VariableID:nothex!/1:2')).toBeNull();
    // exactly 40 hex required: 41+ or 39 fails closed (→ null), not a wrong key
    expect(extractLibraryKey('VariableID:' + 'a'.repeat(41) + '/1:1')).toBeNull();
    expect(extractLibraryKey('VariableID:' + 'a'.repeat(39) + '/1:1')).toBeNull();
    expect(extractLibraryKey('VariableID:' + 'a'.repeat(40) + '/1:1')).toBe('a'.repeat(40));
  });
});
