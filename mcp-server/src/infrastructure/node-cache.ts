// mcp-server/src/infrastructure/node-cache.ts
// Generic string-keyed TTL cache with an LRU size bound. Used for node trees /
// variables keyed by file version, so a published change (new version) naturally
// misses. The size bound prevents unbounded growth as versions/id-selections
// accumulate over a long-lived server (old-version keys are never re-read and
// would otherwise linger forever). Map preserves insertion order → oldest key is
// first; get() re-inserts to mark recency (LRU).
import type { Logger } from './logger.js';
import type { CacheBudget } from './cache-budget.js';

interface Entry<T> { value: T; expiresAt: number; token?: number }

export class TtlCache<T> {
  private store = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1000,
    // Opt-in per-entry byte ceiling. Default Infinity → no entry is ever skipped (behavior-preserving
    // for every existing caller). server.ts wires config.CACHE_MAX_ENTRY_BYTES into the read caches.
    private readonly maxEntryBytes = Infinity,
    private readonly logger?: Logger,
    // Optional process-wide byte budget. Absent → no aggregate accounting (behavior-preserving).
    // Every store mutation below syncs it (add/touch/remove) so budget.total() == sum of live weights.
    private readonly budget?: CacheBudget,
  ) {}

  get(key: string): T | null {
    const e = this.store.get(key);
    if (!e) return null;
    if (Date.now() >= e.expiresAt) {
      this.store.delete(key);
      if (e.token !== undefined) this.budget?.remove(e.token); // expiry is a real removal
      return null;
    }
    // refresh recency: delete + re-set moves key to the end (most-recent). Same entry persists → touch.
    this.store.delete(key);
    this.store.set(key, e);
    if (e.token !== undefined) this.budget?.touch(e.token);
    return e.value;
  }

  set(key: string, value: T, byteWeight = 0): void {
    // Release any prior entry's budget slot FIRST, then clear it — refreshes recency for a normal set, and
    // (for an oversized skip below) guarantees we never keep serving a stale smaller entry under this key.
    const prior = this.store.get(key);
    if (prior?.token !== undefined) this.budget?.remove(prior.token);
    this.store.delete(key);
    if (byteWeight > this.maxEntryBytes) {
      this.logger?.info({ key, bytes: byteWeight, cap: this.maxEntryBytes }, 'cache.skip_oversized');
      return; // deliver to caller (wrapper returns the value), but do not hold it in cache
    }
    const entry: Entry<T> = { value, expiresAt: Date.now() + this.ttlMs };
    // Register only weighted entries: 0-byte (untagged/aggregated) stay count-capped, never budget-evicted.
    // The evict callback drops just this value from the store (raw delete → no budget re-entry; the budget
    // has already decremented, so a later delete(key) → budget.remove(token) is an idempotent no-op).
    if (this.budget && byteWeight > 0) entry.token = this.budget.add(byteWeight, () => this.store.delete(key));
    this.store.set(key, entry);
    if (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = this.store.get(oldestKey);
        this.store.delete(oldestKey);
        if (oldest?.token !== undefined) this.budget?.remove(oldest.token); // count-cap removal
      }
    }
  }

  // Explicit invalidation — used e.g. when a sibling cache's SUCCESS is definitive contradicting
  // evidence for THIS key's prior entry (see getVariablesLocal's success path), so the stale
  // entry must not wait out its own TTL.
  delete(key: string): void {
    const e = this.store.get(key);
    this.store.delete(key);
    if (e?.token !== undefined) this.budget?.remove(e.token);
  }
}
