import { describe, it, expect } from 'vitest';
import { FrameHydrationStore, makeFrameHandle } from '../../src/infrastructure/frame-hydration-store.js';
import type { RawNodesResponse } from '../../src/domain/figma-raw.js';

const raw = (id: string): RawNodesResponse => ({ nodes: { [id]: { document: { id, name: id, type: 'FRAME' } as any } } });

describe('FrameHydrationStore', () => {
  it('holds a raw and returns it when heldDepth >= wantDepth', () => {
    const s = new FrameHydrationStore(100, 50, 1000, () => 0);
    s.setIfDeeper('u1', 'k', raw('a'), 5, 10);
    expect(s.get('u1', 'k', 4)?.heldDepth).toBe(5); // deeper hold serves a shallower want
    expect(s.get('u1', 'k', 5)?.heldDepth).toBe(5);
    expect(s.get('u1', 'k', 6)).toBeNull();          // too shallow — caller must deepen
  });

  it('setIfDeeper never regresses a deeper hold (write-if-deeper race guard)', () => {
    const s = new FrameHydrationStore(100, 50, 1000, () => 0);
    s.setIfDeeper('u1', 'k', raw('deep'), 7, 10);
    s.setIfDeeper('u1', 'k', raw('shallow'), 5, 10); // concurrent shallower write arrives late
    const held = s.get('u1', 'k', 5);
    expect(held?.heldDepth).toBe(7);
    expect(Object.keys(held!.raw.nodes)[0]).toBe('deep');
  });

  it('an EXPIRED deeper hold is replaceable by a fresh shallower write', () => {
    let t = 0;
    const s = new FrameHydrationStore(1000, 500, 1000, () => t);
    s.setIfDeeper('u1', 'k', raw('deep'), 7, 10);
    t = 1000; // now == expiresAt (0 + 1000) → existing counts as expired
    s.setIfDeeper('u1', 'k', raw('shallow'), 5, 10); // guard falls through, fresh write wins
    const held = s.get('u1', 'k', 5);
    expect(held?.heldDepth).toBe(5);
    expect(Object.keys(held!.raw.nodes)[0]).toBe('shallow');
  });

  it('lazy TTL expiry drops the hold on access after ttl', () => {
    let t = 0;
    const s = new FrameHydrationStore(100, 50, 1000, () => t);
    s.setIfDeeper('u1', 'k', raw('a'), 5, 10);
    t = 999; expect(s.get('u1', 'k', 5)).not.toBeNull();
    t = 1000; expect(s.get('u1', 'k', 5)).toBeNull(); // expiresAt = 0 + 1000
  });

  it('stage-1 owner eviction never touches another owner (LRU by lastAccess)', () => {
    const s = new FrameHydrationStore(1000, 30, 10_000, () => 0);
    s.setIfDeeper('u1', 'a', raw('a'), 5, 20);
    s.setIfDeeper('u1', 'b', raw('b'), 5, 20); // u1 now 40 > 30 → oldest (a) evicted
    s.setIfDeeper('u2', 'c', raw('c'), 5, 20); // u2 independent
    expect(s.get('u1', 'a', 5)).toBeNull();
    expect(s.get('u1', 'b', 5)).not.toBeNull();
    expect(s.get('u2', 'c', 5)).not.toBeNull();
  });

  it('stage-1 eviction spares an OLDER record of a different owner', () => {
    let t = 0;
    const s = new FrameHydrationStore(1000, 30, 10_000, () => t);
    t = 1; s.setIfDeeper('u2', 'z', raw('z'), 5, 20); // u2, globally-oldest
    t = 2; s.setIfDeeper('u1', 'a', raw('a'), 5, 20);
    t = 3; s.setIfDeeper('u1', 'b', raw('b'), 5, 20); // u1=40>30 → stage-1 must evict u1/a, NOT u2/z
    expect(s.get('u2', 'z', 5)).not.toBeNull(); // a no-filter evictOwner would kill u2/z here
    expect(s.get('u1', 'a', 5)).toBeNull();
    expect(s.get('u1', 'b', 5)).not.toBeNull();
  });

  it('stage-2 global eviction reclaims the globally-oldest across owners', () => {
    let t = 0;
    const s = new FrameHydrationStore(50, 40, 10_000, () => t);
    t = 1; s.setIfDeeper('u1', 'a', raw('a'), 5, 20);
    t = 2; s.setIfDeeper('u2', 'b', raw('b'), 5, 20); // total 40 ok
    t = 3; s.setIfDeeper('u3', 'c', raw('c'), 5, 20); // total 60 > 50 → evict oldest (u1/a)
    expect(s.get('u1', 'a', 5)).toBeNull();
    expect(s.get('u2', 'b', 5)).not.toBeNull();
    expect(s.get('u3', 'c', 5)).not.toBeNull();
  });

  it('makeFrameHandle binds one owner to the shared store', () => {
    const s = new FrameHydrationStore(100, 50, 1000, () => 0);
    const h1 = makeFrameHandle(s, 'u1');
    const h2 = makeFrameHandle(s, 'u2');
    h1.setIfDeeper('k', raw('a'), 5, 10);
    expect(h1.get('k', 5)?.heldDepth).toBe(5);
    expect(h2.get('k', 5)).toBeNull(); // different owner, same key → isolated
  });
});
