// mcp-server/tests/unit/dom-snapshot-store.test.ts
// Fake-clock unit tests for the in-memory DOM snapshot store: sliding TTL (30 min
// from last access) + hard cap (2h from creation), per-owner 10MB quota with
// same-owner LRU eviction, then a global 40MB LRU, and the strict resolve()
// check order (unknown_ref -> expired -> owner_mismatch -> unknown_selector).
import { describe, it, expect } from 'vitest';
import {
  DomSnapshotStore,
  StoreError,
  SNAPSHOT_TTL_MS,
  SNAPSHOT_HARD_CAP_MS,
  MAX_POST_BYTES,
  MAX_SNAPSHOTS_PER_POST,
  MAX_STORE_BYTES,
  MAX_OWNER_BYTES,
  PER_REF_OVERHEAD_BYTES,
} from '../../src/infrastructure/dom-snapshot-store.js';

function snap(selector: string, extra: Record<string, unknown> = {}) {
  return { selector, status: 'ok', ...extra };
}

// Builds a snapshot whose lone entry, once JSON.stringify'd inside a one-element
// array, is as close as possible to `targetBytes` — used to drive the store
// across its byte thresholds without hardcoding JSON-overhead arithmetic.
function fillerSnapshot(selector: string, targetBytes: number) {
  const overhead = JSON.stringify([{ selector, filler: '' }]).length;
  const fillerLen = Math.max(0, targetBytes - overhead);
  return { selector, filler: 'x'.repeat(fillerLen) };
}

describe('DomSnapshotStore', () => {
  it('constants match the brief', () => {
    expect(SNAPSHOT_TTL_MS).toBe(30 * 60 * 1000);
    expect(SNAPSHOT_HARD_CAP_MS).toBe(2 * 60 * 60 * 1000);
    expect(MAX_POST_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_SNAPSHOTS_PER_POST).toBe(20);
    expect(MAX_STORE_BYTES).toBe(40 * 1024 * 1024);
    expect(MAX_OWNER_BYTES).toBe(MAX_STORE_BYTES / 4);
    expect(PER_REF_OVERHEAD_BYTES).toBe(1024);
  });

  it('mint -> upload -> resolve happy path', () => {
    let t = 0;
    const store = new DomSnapshotStore(() => t);
    const token = store.mint('owner-a');
    const entry = store.upload(token, [snap('.reason'), snap('.title')]);
    expect(entry.selectors).toEqual(['.reason', '.title']);
    expect(entry.expiresAt).toBe(t + SNAPSHOT_TTL_MS);

    const result = store.resolve(entry.ref, '.title', 'owner-a');
    expect(result).toEqual({ ok: true, snapshot: snap('.title') });
  });

  it('sliding TTL: extends on access, expires 31 min after the last touch', () => {
    let t = 0;
    const store = new DomSnapshotStore(() => t);
    const token = store.mint('owner-a');
    const entry = store.upload(token, [snap('.a')]);

    t += 29 * 60 * 1000;
    expect(store.resolve(entry.ref, '.a', 'owner-a').ok).toBe(true); // 29 < 30, alive; extends lastAccess to t

    t += 29 * 60 * 1000; // would be 58 min since upload, but only 29 since last touch
    expect(store.resolve(entry.ref, '.a', 'owner-a').ok).toBe(true); // sliding window renewed it

    t += 31 * 60 * 1000; // 31 min of silence since the last touch
    expect(store.resolve(entry.ref, '.a', 'owner-a')).toEqual({ ok: false, reason: 'expired' });
  });

  it('hard cap: 2h from creation kills the ref even with continuous sub-TTL touches', () => {
    let t = 0;
    const store = new DomSnapshotStore(() => t);
    const token = store.mint('owner-a');
    const entry = store.upload(token, [snap('.a')]);

    for (let i = 0; i < 4; i++) {
      t += 25 * 60 * 1000; // always < 30 min gap, so sliding TTL never fires
      expect(store.resolve(entry.ref, '.a', 'owner-a').ok).toBe(true);
    }
    // t is now 100 min; one more 25-min tick crosses the 120-min hard cap from createdAt=0
    t += 25 * 60 * 1000;
    expect(store.resolve(entry.ref, '.a', 'owner-a')).toEqual({ ok: false, reason: 'expired' });
  });

  it('upload on an expired token -> unknown_token, both via sliding TTL and hard cap', () => {
    // Path 1: sliding TTL — token minted, never touched, 31 min pass.
    let t1 = 0;
    const store1 = new DomSnapshotStore(() => t1);
    const staleToken = store1.mint('owner-a');
    t1 += 31 * 60 * 1000;
    expect(() => store1.upload(staleToken, [snap('.a')])).toThrow(StoreError);
    try {
      store1.upload(staleToken, [snap('.a')]);
      expect.unreachable();
    } catch (e) {
      expect((e as StoreError).code).toBe('unknown_token');
    }

    // Path 2: hard cap — token kept alive via sub-TTL uploads, but total age exceeds 2h.
    let t2 = 0;
    const store2 = new DomSnapshotStore(() => t2);
    const token = store2.mint('owner-a');
    for (let i = 0; i < 4; i++) {
      store2.upload(token, [snap(`.a${i}`)]);
      t2 += 25 * 60 * 1000; // < 30 min gap each time, keeps sliding TTL happy
    }
    // t2 is now 100 min; one more 25-min tick crosses the 120-min hard cap from createdAt=0
    t2 += 25 * 60 * 1000;
    try {
      store2.upload(token, [snap('.final')]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StoreError);
      expect((e as StoreError).code).toBe('unknown_token');
    }
  });

  it('unknown ref / unknown token / unknown selector / owner mismatch', () => {
    let t = 0;
    const store = new DomSnapshotStore(() => t);

    expect(store.resolve('nonexistent-ref', '.x', 'owner-a')).toEqual({ ok: false, reason: 'unknown_ref' });

    try {
      store.upload('nonexistent-token', [snap('.a')]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StoreError);
      expect((e as StoreError).code).toBe('unknown_token');
    }

    const token = store.mint('owner-a');
    const entry = store.upload(token, [snap('.a'), snap('.b')]);

    const badSelector = store.resolve(entry.ref, '.nope', 'owner-a');
    expect(badSelector).toEqual({ ok: false, reason: 'unknown_selector', selectors: ['.a', '.b'] });

    const badOwner = store.resolve(entry.ref, '.a', 'owner-b');
    expect(badOwner).toEqual({ ok: false, reason: 'owner_mismatch' });
  });

  it('owner_mismatch response carries no selectors field; unknown_selector does', () => {
    let t = 0;
    const store = new DomSnapshotStore(() => t);
    const token = store.mint('owner-a');
    const entry = store.upload(token, [snap('.a')]);

    const mismatch = store.resolve(entry.ref, '.a', 'owner-b');
    expect(mismatch.ok).toBe(false);
    expect('selectors' in mismatch).toBe(false);

    const unknownSelector = store.resolve(entry.ref, '.zzz', 'owner-a');
    expect(unknownSelector.ok).toBe(false);
    expect('selectors' in unknownSelector).toBe(true);
    if (!unknownSelector.ok && unknownSelector.reason === 'unknown_selector') {
      expect(unknownSelector.selectors).toEqual(['.a']);
    }
  });

  it('resolve check order: owner_mismatch on an unknown selector still reports owner_mismatch, not unknown_selector', () => {
    let t = 0;
    const store = new DomSnapshotStore(() => t);
    const token = store.mint('owner-a');
    const entry = store.upload(token, [snap('.a')]);

    // Wrong owner AND wrong selector at once — owner check must win (selectors list
    // is reachable only after proving ownership).
    const result = store.resolve(entry.ref, '.does-not-exist', 'owner-b');
    expect(result).toEqual({ ok: false, reason: 'owner_mismatch' });
  });

  it('missing_selector: a snapshot without a string .selector is rejected', () => {
    let t = 0;
    const store = new DomSnapshotStore(() => t);
    const token = store.mint('owner-a');

    try {
      store.upload(token, [{ status: 'ok' }]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StoreError);
      expect((e as StoreError).code).toBe('missing_selector');
    }

    try {
      store.upload(token, [snap('.ok'), { selector: 42 }]);
      expect.unreachable();
    } catch (e) {
      expect((e as StoreError).code).toBe('missing_selector');
    }
  });

  it('caps snapshots per POST at 20 (21 rejected, 20 accepted)', () => {
    let t = 0;
    const store = new DomSnapshotStore(() => t);
    const token = store.mint('owner-a');

    const twentyOne = Array.from({ length: 21 }, (_, i) => snap(`.s${i}`));
    try {
      store.upload(token, twentyOne);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StoreError);
      expect((e as StoreError).code).toBe('too_many');
    }

    const twenty = Array.from({ length: 20 }, (_, i) => snap(`.s${i}`));
    const entry = store.upload(token, twenty);
    expect(entry.selectors).toHaveLength(20);
  });

  it('a single POST over MAX_POST_BYTES is rejected as store_full', () => {
    let t = 0;
    const store = new DomSnapshotStore(() => t);
    const token = store.mint('owner-a');

    const tooBig = [fillerSnapshot('.huge', MAX_POST_BYTES + 1024)];
    try {
      store.upload(token, tooBig);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StoreError);
      expect((e as StoreError).code).toBe('store_full');
    }
  });

  it('per-owner quota: flooding owner A evicts only A\'s oldest refs; owner B stays alive', () => {
    let t = 0;
    const store = new DomSnapshotStore(() => t);

    const tokenB = store.mint('owner-b');
    const entryB = store.upload(tokenB, [snap('.b')]);
    t += 1;

    const tokenA = store.mint('owner-a');
    const refsA: { ref: string; selector: string }[] = [];
    for (let i = 0; i < 7; i++) {
      const selector = `.a${i}`;
      const entry = store.upload(tokenA, [fillerSnapshot(selector, 1_900_000)]); // ~1.9MB each, 7x > 10MB owner cap
      refsA.push({ ref: entry.ref, selector });
      t += 1;
    }

    // B was never touched by A's flood.
    expect(store.resolve(entryB.ref, '.b', 'owner-b')).toEqual({ ok: true, snapshot: snap('.b') });

    // A's earliest ref(s) were evicted to stay under the 10MB per-owner quota...
    const first = refsA[0];
    expect(store.resolve(first.ref, first.selector, 'owner-a')).toEqual({ ok: false, reason: 'unknown_ref' });

    // ...while the most recent one survives.
    const last = refsA[refsA.length - 1];
    expect(store.resolve(last.ref, last.selector, 'owner-a').ok).toBe(true);
  });

  it('global LRU: multiple owners each under their own quota still evict oldest overall past 40MB', () => {
    let t = 0;
    const store = new DomSnapshotStore(() => t);

    const owners = ['c1', 'c2', 'c3', 'c4', 'c5'];
    const allRefs: { owner: string; ref: string; selector: string }[] = [];
    for (const owner of owners) {
      const token = store.mint(owner);
      for (let i = 0; i < 5; i++) {
        const selector = `.${owner}-${i}`;
        // ~1.8MB * 5 = 9MB per owner: comfortably under the 10MB per-owner cap,
        // but 5 owners * 9MB = 45MB blows past the 40MB global cap.
        const entry = store.upload(token, [fillerSnapshot(selector, 1_800_000)]);
        allRefs.push({ owner, ref: entry.ref, selector });
        t += 1;
      }
    }

    const first = allRefs[0];
    expect(store.resolve(first.ref, first.selector, first.owner)).toEqual({ ok: false, reason: 'unknown_ref' });

    const last = allRefs[allRefs.length - 1];
    expect(store.resolve(last.ref, last.selector, last.owner).ok).toBe(true);
  });

  it('tiny-POST flood: per-ref overhead bounds ref count, eviction starts no later than quota/overhead refs', () => {
    let t = 0;
    const store = new DomSnapshotStore(() => t);
    const token = store.mint('owner-a');

    // Each POST carries only a few payload bytes, but is accounted at
    // payload + PER_REF_OVERHEAD_BYTES — so the per-owner quota must force
    // eviction after AT MOST MAX_OWNER_BYTES / PER_REF_OVERHEAD_BYTES refs
    // (10240), no matter how tiny the payloads are. Without the overhead
    // surcharge this loop would retain every ref "within quota" while heap
    // grows unbounded (the OOM vector this constant exists to close).
    const uploads = MAX_OWNER_BYTES / PER_REF_OVERHEAD_BYTES + 1; // 10241
    let firstRef: string | undefined;
    let lastRef: string | undefined;
    for (let i = 0; i < uploads; i++) {
      const entry = store.upload(token, [snap('.t')]);
      if (i === 0) firstRef = entry.ref;
      lastRef = entry.ref;
      t += 1; // deterministic LRU ordering; 10241ms total, far under TTL
    }

    expect(store.resolve(firstRef!, '.t', 'owner-a')).toEqual({ ok: false, reason: 'unknown_ref' });
    expect(store.resolve(lastRef!, '.t', 'owner-a').ok).toBe(true);
  });

  it('resolve extends the capToken sliding TTL, not just the ref (upload still works after resolve-only traffic)', () => {
    let t = 0;
    const store = new DomSnapshotStore(() => t);
    const token = store.mint('owner-a');
    const entry = store.upload(token, [snap('.a')]);

    // Two resolve-only touches at 29-min steps: at t=58min the token's own
    // upload-time lastAccess (t=0) is long past the 30-min sliding TTL, so
    // this upload only succeeds if resolve() extended the token's lastAccess.
    t += 29 * 60 * 1000;
    expect(store.resolve(entry.ref, '.a', 'owner-a').ok).toBe(true);
    t += 29 * 60 * 1000;
    expect(store.resolve(entry.ref, '.a', 'owner-a').ok).toBe(true);

    const entry2 = store.upload(token, [snap('.b')]);
    expect(entry2.ref).not.toBe(entry.ref);
    expect(entry2.selectors).toEqual(['.b']);
  });

  describe('resolveByIndex', () => {
    it('happy path resolves the positional snapshot', () => {
      let t = 0;
      const store = new DomSnapshotStore(() => t);
      const token = store.mint('owner-a');
      const entry = store.upload(token, [snap('.reason'), snap('.title')]);

      const result = store.resolveByIndex(entry.ref, 1, 'owner-a');
      expect(result).toEqual({ ok: true, snapshot: snap('.title') });
    });

    it('duplicate selector across positions: index reaches the payload AT that position, not the first occurrence (the footgun resolveByIndex exists to bypass)', () => {
      let t = 0;
      const store = new DomSnapshotStore(() => t);
      const token = store.mint('owner-a');
      const first = snap('.dup', { rect: { x: 10 } });
      const middle = snap('.other');
      const second = snap('.dup', { rect: { x: 99 } });
      const entry = store.upload(token, [first, middle, second]);
      expect(entry.selectors).toEqual(['.dup', '.other', '.dup']);

      expect(store.resolveByIndex(entry.ref, 0, 'owner-a')).toEqual({ ok: true, snapshot: first });
      expect(store.resolveByIndex(entry.ref, 2, 'owner-a')).toEqual({ ok: true, snapshot: second });

      // The dedup'd bySelector map (first-occurrence-wins) backs plain resolve() — it can only
      // ever see `first`, proving resolveByIndex(2) genuinely bypasses it rather than coincidentally
      // matching.
      expect(store.resolve(entry.ref, '.dup', 'owner-a')).toEqual({ ok: true, snapshot: first });
    });

    it('index out of range (too high, negative, or non-integer) -> unknown_selector with the full selector list', () => {
      let t = 0;
      const store = new DomSnapshotStore(() => t);
      const token = store.mint('owner-a');
      const entry = store.upload(token, [snap('.a'), snap('.b')]);

      expect(store.resolveByIndex(entry.ref, 2, 'owner-a')).toEqual({ ok: false, reason: 'unknown_selector', selectors: ['.a', '.b'] });
      expect(store.resolveByIndex(entry.ref, -1, 'owner-a')).toEqual({ ok: false, reason: 'unknown_selector', selectors: ['.a', '.b'] });
      expect(store.resolveByIndex(entry.ref, 1.5, 'owner-a')).toEqual({ ok: false, reason: 'unknown_selector', selectors: ['.a', '.b'] });
    });

    it('expired ref -> expired, no selectors field', () => {
      let t = 0;
      const store = new DomSnapshotStore(() => t);
      const token = store.mint('owner-a');
      const entry = store.upload(token, [snap('.a')]);
      t += 31 * 60 * 1000;

      const result = store.resolveByIndex(entry.ref, 0, 'owner-a');
      expect(result).toEqual({ ok: false, reason: 'expired' });
      expect('selectors' in result).toBe(false);
    });

    it('owner_mismatch -> owner_mismatch, no selectors field, even on an out-of-range index', () => {
      let t = 0;
      const store = new DomSnapshotStore(() => t);
      const token = store.mint('owner-a');
      const entry = store.upload(token, [snap('.a')]);

      const result = store.resolveByIndex(entry.ref, 99, 'owner-b');
      expect(result).toEqual({ ok: false, reason: 'owner_mismatch' });
      expect('selectors' in result).toBe(false);
    });

    it('unknown ref -> unknown_ref', () => {
      let t = 0;
      const store = new DomSnapshotStore(() => t);
      expect(store.resolveByIndex('nonexistent-ref', 0, 'owner-a')).toEqual({ ok: false, reason: 'unknown_ref' });
    });

    it('touch via resolveByIndex extends the sliding TTL, same as resolve()', () => {
      let t = 0;
      const store = new DomSnapshotStore(() => t);
      const token = store.mint('owner-a');
      const entry = store.upload(token, [snap('.a')]);

      t += 29 * 60 * 1000;
      expect(store.resolveByIndex(entry.ref, 0, 'owner-a').ok).toBe(true);
      t += 29 * 60 * 1000; // would be 58 min since upload, but only 29 since last touch
      expect(store.resolveByIndex(entry.ref, 0, 'owner-a').ok).toBe(true);
      t += 31 * 60 * 1000; // 31 min of silence since the last touch
      expect(store.resolveByIndex(entry.ref, 0, 'owner-a')).toEqual({ ok: false, reason: 'expired' });
    });
  });

  it('store_full message guides toward splitting across POSTs under one capToken', () => {
    const store = new DomSnapshotStore(() => 1000);
    const cap = store.mint('owner');
    const huge = [{ selector: '.a', blob: 'x'.repeat(2 * 1024 * 1024 + 10) }];
    expect(() => store.upload(cap, huge)).toThrow(/multiple POSTs under ONE capToken/);
  });

  // (a') mint-meta (viewport-ergonomics T3): mint carries an optional expectedWidths meta so the
  // upload route can preflight-warn on a mismatched viewport — see dom-snapshot-routes.ts.
  describe('mint meta / getMeta', () => {
    it('mint(owner, { expectedWidths }) -> getMeta returns it back', () => {
      const store = new DomSnapshotStore();
      const token = store.mint('owner-a', { expectedWidths: [1920, 375] });
      expect(store.getMeta(token)).toEqual({ expectedWidths: [1920, 375] });
    });

    it('mint(owner) without meta -> getMeta returns undefined', () => {
      const store = new DomSnapshotStore();
      const token = store.mint('owner-a');
      expect(store.getMeta(token)).toBeUndefined();
    });

    it('getMeta on an unknown token -> undefined, does not throw', () => {
      const store = new DomSnapshotStore();
      expect(() => store.getMeta('nope')).not.toThrow();
      expect(store.getMeta('nope')).toBeUndefined();
    });
  });
});
