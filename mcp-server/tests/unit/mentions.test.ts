import { describe, it, expect } from 'vitest';
import { extractMentions } from '../../src/domain/mentions.js';

describe('extractMentions', () => {
  it('returns [] when no @ present', () => {
    expect(extractMentions('plain text')).toEqual([]);
  });

  it('extracts a single handle', () => {
    expect(extractMentions('hey @anna please look')).toEqual(['anna']);
  });

  it('dedupes repeated handles and keeps distinct ones', () => {
    expect(extractMentions('@user1 and @user2 and @user1 again')).toEqual(['user1', 'user2']);
  });

  it('preserves dots, dashes, underscores in handle', () => {
    expect(extractMentions('@ignashkova.olga and @some-user_name')).toEqual([
      'ignashkova.olga',
      'some-user_name',
    ]);
  });
});
