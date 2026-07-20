// mcp-server/src/infrastructure/cache-budget.ts
// Process-wide byte accountant shared by every read cache. Bounds AGGREGATE resident cache
// bytes at maxBytes via global LRU-by-bytes: when a store pushes the total over, the globally
// least-recently-used weighted entries are evicted (across caches) until it fits. Token-based so it is
// cache-agnostic — a cache calls add() when it stores a weighted entry, touch() on a hit, remove() on any
// removal, and hands the token back each time. Node is single-threaded and dedup gives one fetch per key,
// so no locks are needed. Only byteWeight > 0 entries are registered (the memory-dominant doc/nodes/
// variables responses); 0-byte/aggregated entries stay count-capped by their TtlCache.
import type { Logger } from './logger.js';

interface BudgetEntry { bytes: number; evict: () => void }

export class CacheBudget {
  private entries = new Map<number, BudgetEntry>(); // insertion order = LRU; first key = oldest
  private runningTotal = 0;
  private seq = 0;

  constructor(private readonly maxBytes: number, private readonly logger?: Logger) {}

  total(): number { return this.runningTotal; }

  add(bytes: number, evict: () => void): number {
    const token = ++this.seq;
    this.entries.set(token, { bytes, evict });
    this.runningTotal += bytes;
    this.evictToFit(token);
    return token;
  }

  touch(token: number): void {
    const e = this.entries.get(token);
    if (e === undefined) return;
    this.entries.delete(token);   // re-insert to move to most-recent (end)
    this.entries.set(token, e);
  }

  remove(token: number): void {
    const e = this.entries.get(token);
    if (e === undefined) return;  // idempotent: already evicted / never present
    this.entries.delete(token);
    this.runningTotal -= e.bytes;
  }

  // Evict globally-oldest entries until total <= maxBytes. Never evicts `protect` (the entry just added) —
  // a single entry larger than the whole budget must not self-evict (the oversized-skip already prevents
  // that upstream; this is a belt-and-suspenders honest-overshoot rather than an infinite loop).
  private evictToFit(protect: number): void {
    while (this.runningTotal > this.maxBytes) {
      const oldest = this.entries.keys().next().value as number | undefined;
      if (oldest === undefined || oldest === protect) break;
      const e = this.entries.get(oldest)!;
      this.entries.delete(oldest);
      this.runningTotal -= e.bytes;
      e.evict(); // owning cache drops the stored value; its own remove(token) is then an idempotent no-op
      this.logger?.info({ bytes: e.bytes, total: this.runningTotal, cap: this.maxBytes }, 'cache.evict_budget');
    }
  }
}
