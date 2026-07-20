import type { Logger } from './logger.js';
import type { RawNodesResponse } from '../domain/figma-raw.js';

export interface HeldFrame { raw: RawNodesResponse; heldDepth: number }

interface FrameRecord {
  owner: string;
  raw: RawNodesResponse;
  heldDepth: number;
  residentBytes: number;
  expiresAt: number;
  lastAccess: number;
}

/**
 * ONE shared process-wide store for hydrated frame raws. Owner-keyed internally (by keycloak
 * user id); a per-owner handle (makeFrameHandle) is what readCachesFor(userId) hands out — never a
 * new store. Budget is measured in RESIDENT bytes (wire × multiplier, computed by the caller via
 * frame-budget.residentBytes). Two-stage owner→global LRU by lastAccess (DomSnapshotStore pattern):
 * stage 1 keeps a busy tenant from starving a quiet one; stage 2 bounds process-wide RAM and
 * reclaims the globally-oldest (typically an idle tenant) for free. Separate budget from the shared
 * read-cache CacheBudget — never merged.
 */
export class FrameHydrationStore {
  private readonly frames = new Map<string, FrameRecord>(); // key: `${owner} ${cacheKey}`

  constructor(
    private readonly globalBytes: number,
    private readonly perTenantBytes: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly logger?: Logger,
  ) {}

  private slot(owner: string, cacheKey: string): string { return `${owner} ${cacheKey}`; }

  /**
   * Held frame IF present, unexpired, and heldDepth >= wantDepth; else null. A held raw deeper than
   * wantDepth re-slices byte-identically (the m+1 depth-tolerance invariant). Too-shallow → null so
   * the caller deepens (never serve a raw shallower than wantDepth — that would drop the boundary
   * childrenTruncated peek = false-green).
   */
  get(owner: string, cacheKey: string, wantDepth: number): HeldFrame | null {
    const slot = this.slot(owner, cacheKey);
    const rec = this.frames.get(slot);
    if (!rec) return null;
    if (this.now() >= rec.expiresAt) { this.frames.delete(slot); return null; } // lazy TTL
    if (rec.heldDepth < wantDepth) return null;
    rec.lastAccess = this.now();
    return { raw: rec.raw, heldDepth: rec.heldDepth };
  }

  /**
   * Hold `raw` at `heldDepth` IFF strictly deeper than any live hold for this key (write-if-deeper
   * race guard: a concurrent shallower fetch never regresses a deeper hold), then two-stage
   * owner→global LRU eviction to fit the budgets.
   */
  setIfDeeper(owner: string, cacheKey: string, raw: RawNodesResponse, heldDepth: number, residentBytes: number): void {
    const slot = this.slot(owner, cacheKey);
    const existing = this.frames.get(slot);
    if (existing && this.now() < existing.expiresAt && existing.heldDepth >= heldDepth) return; // never regress
    const t = this.now();
    this.frames.set(slot, { owner, raw, heldDepth, residentBytes, expiresAt: t + this.ttlMs, lastAccess: t });
    this.evictOwner(owner);
    this.evictGlobal();
  }

  private ownerBytes(owner: string): number {
    let total = 0;
    for (const r of this.frames.values()) if (r.owner === owner) total += r.residentBytes;
    return total;
  }
  private totalBytes(): number {
    let total = 0;
    for (const r of this.frames.values()) total += r.residentBytes;
    return total;
  }
  private oldestKey(filter?: (r: FrameRecord) => boolean): string | undefined {
    let bestKey: string | undefined;
    let best: FrameRecord | undefined;
    for (const [k, r] of this.frames.entries()) {
      if (filter && !filter(r)) continue;
      if (!best || r.lastAccess < best.lastAccess) { best = r; bestKey = k; }
    }
    return bestKey;
  }
  private evictOwner(owner: string): void {
    while (this.ownerBytes(owner) > this.perTenantBytes) {
      const k = this.oldestKey((r) => r.owner === owner);
      if (k === undefined) break;
      this.frames.delete(k);
      this.logger?.info({ owner, total: this.totalBytes() }, 'frame_cache.evict_owner');
    }
  }
  private evictGlobal(): void {
    while (this.totalBytes() > this.globalBytes) {
      const k = this.oldestKey();
      if (k === undefined) break;
      this.frames.delete(k);
      this.logger?.info({ total: this.totalBytes(), cap: this.globalBytes }, 'frame_cache.evict_global');
    }
  }
}

/**
 * Owner-bound handle over the shared store. readCachesFor(userId) hands one of these, keeping the
 * caching adapter owner-agnostic while eviction stays owner-aware.
 */
export interface FrameHandle {
  get(cacheKey: string, wantDepth: number): HeldFrame | null;
  setIfDeeper(cacheKey: string, raw: RawNodesResponse, heldDepth: number, residentBytes: number): void;
}
export function makeFrameHandle(store: FrameHydrationStore, owner: string): FrameHandle {
  return {
    get: (k, d) => store.get(owner, k, d),
    setIfDeeper: (k, raw, d, b) => store.setIfDeeper(owner, k, raw, d, b),
  };
}
