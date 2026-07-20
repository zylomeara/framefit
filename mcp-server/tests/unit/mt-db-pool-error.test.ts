import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const fakePools: FakePool[] = [];
class FakePool extends EventEmitter {
  ended = false;
  constructor(public readonly opts: unknown) { super(); fakePools.push(this); }
  async end() { this.ended = true; }
  async query() { return { rows: [], rowCount: 0 }; }
}
vi.mock('pg', () => ({ default: { Pool: FakePool } }));

describe('initDb pool error handling', () => {
  afterEach(async () => { fakePools.length = 0; vi.resetModules(); });

  it('registers an error listener so an idle-client error does not crash the process', async () => {
    const { initDb } = await import('../../src/multi-tenant/db.js');
    const onError = vi.fn();
    initDb('postgres://x', onError);
    const pool = fakePools.at(-1)!;
    expect(pool.listenerCount('error')).toBe(1);
    expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0][0] as Error).message).toContain('terminating connection');
  });

  it('works without an onError callback (listener still present)', async () => {
    const { initDb } = await import('../../src/multi-tenant/db.js');
    initDb('postgres://x');
    const pool = fakePools.at(-1)!;
    expect(pool.listenerCount('error')).toBe(1);
    expect(() => pool.emit('error', new Error('boom'))).not.toThrow();
  });
});
