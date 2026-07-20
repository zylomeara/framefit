// mcp-server/tests/unit/mt-nightly.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { startNightlyValidation } from '../../src/multi-tenant/nightly-validation.js';
import { encrypt } from '../../src/multi-tenant/crypto.js';
import { createLogger } from '../../src/infrastructure/logger.js';

const KEY = 'a'.repeat(64);
const logger = createLogger({ level: 'silent' });

afterEach(() => vi.useRealTimers());

describe('nightly validation', () => {
  it('decrypts each PAT, validates, persists status; stop() halts the loop', async () => {
    vi.useFakeTimers();
    const updates: [number, string][] = [];
    const stop = startNightlyValidation({
      encryptionKey: KEY,
      logger,
      intervalMs: 1000,
      listAll: async () => [
        { id: 1, keycloak_user_id: 'u1', encrypted_pat: encrypt('figd_good', KEY, 'u1') },
        { id: 2, keycloak_user_id: 'u2', encrypted_pat: encrypt('figd_bad', KEY, 'u2') },
      ],
      validate: async (pat) => (pat === 'figd_good' ? { ok: true, handle: 'a' } : { ok: false, status: 403 }),
      update: async (id, status) => { updates.push([id, status]); },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(updates).toEqual([[1, 'active'], [2, 'invalid']]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(updates).toHaveLength(4);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(updates).toHaveLength(4);
  });

  it('a corrupt row does not kill the whole pass', async () => {
    vi.useFakeTimers();
    const updates: [number, string][] = [];
    const stop = startNightlyValidation({
      encryptionKey: KEY,
      logger,
      intervalMs: 60_000,
      listAll: async () => [
        { id: 1, keycloak_user_id: 'u1', encrypted_pat: 'not-base64-garbage' },
        { id: 2, keycloak_user_id: 'u2', encrypted_pat: encrypt('figd_ok', KEY, 'u2') },
      ],
      validate: async () => ({ ok: true, handle: 'a' }),
      update: async (id, status) => { updates.push([id, status]); },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(updates).toEqual([[2, 'active']]);
    stop();
  });
});
