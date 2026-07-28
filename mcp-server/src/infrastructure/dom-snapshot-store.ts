// mcp-server/src/infrastructure/dom-snapshot-store.ts
// In-memory store for browser-uploaded DOM snapshots (dom-diff-dx browser-direct
// upload flow). Foundation module: the
// upload HTTP endpoint and metric-diff consumers build on
// top of this. Deliberately dependency-free: crypto.randomBytes for opaque
// tokens/refs, and an injectable clock (`now`) so tests are deterministic under
// a fake clock instead of real timers.
//
// Two kinds of records:
//  - Token (capToken): minted per upload session; gates `upload()`.
//  - Ref: one per POST batch of snapshots; what `resolve()` looks up.
// Both use the SAME expiry formula, independently, on their own createdAt/
// lastAccess: `lastAccess + SNAPSHOT_TTL_MS < now || createdAt + SNAPSHOT_HARD_CAP_MS < now`
// (sliding TTL, non-extendable hard cap). `resolve()` extends both the ref's and
// its parent token's lastAccess on an authenticated touch (ref found, not
// expired, owner matches) — this is what lets a caller keep uploading fresh
// snapshots under the same long-lived capToken while actively resolving pins.
//
// sweep() only reclaims TOKEN records; it never touches refs. An expired ref is
// detected by resolve() itself ("resolve rejects the stale ones anyway"): the FIRST
// post-expiry touch reports 'expired' and deletes the record right there, so
// 'expired' is one-shot — subsequent resolves of the same ref see unknown_ref.
// Expired refs that are never touched again are reclaimed by the LRU/byte-budget
// eviction inside upload() ("the LRU cleans up the rest"), which is what actually
// bounds memory (MAX_STORE_BYTES). This split matters for correctness: sweep()
// runs lazily at the START of resolve(), before the unknown_ref/expired checks —
// if it deleted expired refs too, a genuinely-expired ref would look identical
// to one that never existed, and resolve() could never report the distinct
// 'expired' reason even once.
//
// No Zod here — validating snapshot *content* (schema/shape beyond `.selector`)
// is the router's job (the upload router), not the store's.

import { randomBytes } from 'node:crypto';

export const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
export const SNAPSHOT_HARD_CAP_MS = 2 * 60 * 60 * 1000;
export const MAX_POST_BYTES = 2 * 1024 * 1024;
export const MAX_SNAPSHOTS_PER_POST = 20;
export const MAX_STORE_BYTES = 40 * 1024 * 1024;
export const MAX_OWNER_BYTES = MAX_STORE_BYTES / 4;
// Fixed accounting surcharge added to every stored ref on top of its JSON
// payload length. A RefRecord costs real heap far beyond its payload string:
// two 32-char hex ids, the selectors array, the bySelector Map (hash buckets +
// per-entry overhead), the record object itself and its Map entry — roughly
// ~800B measured, rounded up to 1KB as a conservative structural estimate (the
// slack also partially compensates for `JSON.stringify(...).length` counting
// UTF-16 code units, not bytes, for non-ASCII payloads). Without this, a
// tiny-POST flood (a few accounted bytes per ref) would stay "within quota"
// while accumulating hundreds of MB of real heap — an OOM vector on the
// no-swap prod host. With it, per-owner refs are hard-bounded at
// MAX_OWNER_BYTES / PER_REF_OVERHEAD_BYTES (= 10240) regardless of payload size.
export const PER_REF_OVERHEAD_BYTES = 1024;

export type StoreErrorCode = 'unknown_token' | 'too_many' | 'store_full' | 'missing_selector';

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'StoreError';
    this.code = code;
  }
}

export interface SnapshotStoreEntry {
  ref: string;
  selectors: string[];
  expiresAt: number;
}

export type SnapshotResolveResult =
  | { ok: true; snapshot: unknown }
  | { ok: false; reason: 'unknown_ref' | 'expired' | 'owner_mismatch' }
  | { ok: false; reason: 'unknown_selector'; selectors: string[] };

interface TokenRecord {
  owner: string;
  createdAt: number;
  lastAccess: number;
  // (a') viewport preflight: optional widths get_layout_spec's mint()
  // caller expects the browser's innerWidth to match at upload time — consumed by getMeta() /
  // dom-snapshot-routes.ts's handleUpload to emit an honest viewport_warning. Undefined for
  // pre-existing mint(owner) single-arg callers — a meta-less token behaves byte-for-byte as before.
  meta?: { expectedWidths?: number[] };
}

interface RefRecord {
  ref: string;
  owner: string;
  capToken: string;
  selectors: string[];
  bySelector: Map<string, unknown>;
  // Positional, NOT deduplicated — parallel to `selectors` (pushed together in upload()).
  // resolve() intentionally uses `bySelector` ("first occurrence wins" on duplicate
  // selectors); resolveByIndex() intentionally uses THIS array instead, reading
  // `snapshots[index]` directly — going through bySelector for the index path would
  // silently return the first occurrence's payload for any later duplicate, defeating
  // the exact footgun index exists to bypass.
  snapshots: unknown[];
  bytes: number;
  createdAt: number;
  lastAccess: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export class DomSnapshotStore {
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly refs = new Map<string, RefRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  mint(owner: string, meta?: { expectedWidths?: number[] }): string {
    this.sweepTokens();
    const capToken = randomBytes(16).toString('hex');
    const t = this.now();
    this.tokens.set(capToken, { owner, createdAt: t, lastAccess: t, ...(meta ? { meta } : {}) });
    return capToken;
  }

  // (a') viewport preflight: returns the meta stashed at mint() time, or undefined for an
  // unknown/expired/meta-less token — never throws (mirrors resolve()'s honest-undefined style
  // rather than StoreError, since a missing warning-hint is not a failure of the upload itself).
  getMeta(capToken: string): { expectedWidths?: number[] } | undefined {
    this.sweepTokens();
    return this.tokens.get(capToken)?.meta;
  }

  /**
   * Existence probe used by the upload router BEFORE it parses the body. The capToken is the ONLY
   * credential on that route, so an anonymous caller must cost a Map lookup, not a JSON.parse of
   * up to 2MB plus N schema validations. `upload` re-checks and stays the authority; this is the
   * cheap gate in front of it, never a replacement for it.
   *
   * Sweeps first, like getMeta/upload/touchRecord: an expired token must answer false, so that the
   * router cannot hand a caller an expired-vs-never-existed distinction the 404 does not admit.
   */
  hasToken(capToken: string): boolean {
    this.sweepTokens();
    return this.tokens.has(capToken);
  }

  upload(capToken: string, snapshots: unknown[]): SnapshotStoreEntry {
    this.sweepTokens();
    const token = this.tokens.get(capToken);
    if (!token) throw new StoreError('unknown_token', 'unknown or expired cap token');

    if (snapshots.length > MAX_SNAPSHOTS_PER_POST) {
      throw new StoreError('too_many', `at most ${MAX_SNAPSHOTS_PER_POST} snapshots per POST`);
    }
    // POST-size gate is on the raw payload length (the wire-contract budget);
    // the *stored* accounting below adds PER_REF_OVERHEAD_BYTES on top so that
    // quota/LRU eviction tracks real heap cost, not just payload size.
    const postBytes = JSON.stringify(snapshots).length;
    if (postBytes > MAX_POST_BYTES) {
      throw new StoreError('store_full',
        `POST body exceeds ${MAX_POST_BYTES} bytes — send fewer snapshots per POST; ` +
        'the store accepts multiple POSTs under ONE capToken (the limit is per batch, not per session)');
    }
    const bytes = postBytes + PER_REF_OVERHEAD_BYTES;

    // Validate every snapshot has a byte-for-byte string `.selector` BEFORE
    // touching store state (mutation-free rejection — a bad batch never
    // evicts anyone else's live refs).
    const selectors: string[] = [];
    const bySelector = new Map<string, unknown>();
    const snapshotsPositional: unknown[] = [];
    for (const snapshot of snapshots) {
      const selector = isRecord(snapshot) ? snapshot.selector : undefined;
      if (typeof selector !== 'string') {
        throw new StoreError('missing_selector', 'snapshot is missing a string .selector');
      }
      selectors.push(selector);
      snapshotsPositional.push(snapshot);
      // Duplicate selectors within one batch: first occurrence wins for resolve().
      if (!bySelector.has(selector)) bySelector.set(selector, snapshot);
    }

    const t = this.now();
    const ref = randomBytes(16).toString('hex');
    const record: RefRecord = {
      ref,
      owner: token.owner,
      capToken,
      selectors,
      bySelector,
      snapshots: snapshotsPositional,
      bytes,
      createdAt: t,
      lastAccess: t,
    };
    this.refs.set(ref, record);

    this.evictOwner(token.owner);
    this.evictGlobal();

    token.lastAccess = t;

    return { ref, selectors, expiresAt: t + SNAPSHOT_TTL_MS };
  }

  resolve(ref: string, selector: string, owner: string): SnapshotResolveResult {
    const touched = this.touchRecord(ref, owner);
    if (!touched.ok) return touched.error;

    const snapshot = touched.record.bySelector.get(selector);
    if (snapshot === undefined) {
      return { ok: false, reason: 'unknown_selector', selectors: touched.record.selectors };
    }
    return { ok: true, snapshot };
  }

  // Positional counterpart to resolve(): reads `record.snapshots[index]` directly, NEVER
  // through `bySelector` — see the comment on RefRecord.snapshots for why that distinction
  // is load-bearing on duplicate selectors. Same honest error ladder as resolve() (shared
  // via touchRecord); an out-of-range/non-integer index is reported the same way an unknown
  // selector would be — 'unknown_selector' with the full selector list, so a caller can see
  // what indices/selectors ARE available.
  resolveByIndex(ref: string, index: number, owner: string): SnapshotResolveResult {
    const touched = this.touchRecord(ref, owner);
    if (!touched.ok) return touched.error;

    if (!Number.isInteger(index) || index < 0 || index >= touched.record.selectors.length) {
      return { ok: false, reason: 'unknown_selector', selectors: touched.record.selectors };
    }
    return { ok: true, snapshot: touched.record.snapshots[index] };
  }

  sweep(): void {
    this.sweepTokens();
  }

  // Shared by resolve()/resolveByIndex(): sweep -> unknown_ref -> expired -> owner_mismatch,
  // then an authenticated touch (extends the sliding TTL for both the ref and its parent
  // capToken) before handing back the live record for the caller's own selector/index lookup.
  private touchRecord(ref: string, owner: string): { ok: true; record: RefRecord } | { ok: false; error: SnapshotResolveResult } {
    this.sweepTokens();
    const record = this.refs.get(ref);
    if (!record) return { ok: false, error: { ok: false, reason: 'unknown_ref' } };

    if (this.isExpired(record)) {
      this.refs.delete(ref);
      return { ok: false, error: { ok: false, reason: 'expired' } };
    }

    if (record.owner !== owner) return { ok: false, error: { ok: false, reason: 'owner_mismatch' } };

    const t = this.now();
    record.lastAccess = t;
    const token = this.tokens.get(record.capToken);
    if (token) token.lastAccess = t;

    return { ok: true, record };
  }

  private sweepTokens(): void {
    const t = this.now();
    for (const [capToken, record] of this.tokens) {
      if (this.isExpired(record, t)) this.tokens.delete(capToken);
    }
  }

  private isExpired(record: { createdAt: number; lastAccess: number }, t = this.now()): boolean {
    return record.lastAccess + SNAPSHOT_TTL_MS < t || record.createdAt + SNAPSHOT_HARD_CAP_MS < t;
  }

  private ownerBytes(owner: string): number {
    let total = 0;
    for (const record of this.refs.values()) {
      if (record.owner === owner) total += record.bytes;
    }
    return total;
  }

  private totalBytes(): number {
    let total = 0;
    for (const record of this.refs.values()) total += record.bytes;
    return total;
  }

  // Stage 1: same-owner LRU. A neighbor never evicts another owner's live refs —
  // re-shooting a snapshot just means re-navigating, so only the flooding
  // owner's own oldest refs pay for it.
  private evictOwner(owner: string): void {
    while (this.ownerBytes(owner) > MAX_OWNER_BYTES) {
      const oldest = this.oldest((r) => r.owner === owner);
      if (!oldest) break;
      this.refs.delete(oldest.ref);
    }
  }

  // Stage 2: global LRU, only if the store is still over budget after stage 1.
  private evictGlobal(): void {
    while (this.totalBytes() > MAX_STORE_BYTES) {
      const oldest = this.oldest();
      if (!oldest) break;
      this.refs.delete(oldest.ref);
    }
  }

  private oldest(filter?: (r: RefRecord) => boolean): RefRecord | undefined {
    let best: RefRecord | undefined;
    for (const record of this.refs.values()) {
      if (filter && !filter(record)) continue;
      if (!best || record.lastAccess < best.lastAccess) best = record;
    }
    return best;
  }
}
