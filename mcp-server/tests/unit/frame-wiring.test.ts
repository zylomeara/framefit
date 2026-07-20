import { describe, it, expect } from 'vitest';
import { makeReadCaches } from '../../src/infrastructure/server.js';
import { FrameHydrationStore } from '../../src/infrastructure/frame-hydration-store.js';
import { loadConfig } from '../../src/infrastructure/config.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { RawNodesResponse } from '../../src/domain/figma-raw.js';

const logger = createLogger({ level: 'silent' });
const raw = (id: string): RawNodesResponse => ({ nodes: { [id]: { document: { id, name: id, type: 'FRAME' } as any } } });

describe('frame-hydration wiring', () => {
  it('makeReadCaches without a frameStore has no frameCache (backward-compat)', () => {
    const rc = makeReadCaches(loadConfig({}), logger);
    expect(rc.frameCache).toBeUndefined();
  });

  it('makeReadCaches binds ONE shared store to distinct owners (readCachesFor pattern)', () => {
    const store = new FrameHydrationStore(1e9, 1e9, 1e6, () => 0);
    const rcA = makeReadCaches(loadConfig({}), logger, undefined, store, 'userA');
    const rcB = makeReadCaches(loadConfig({}), logger, undefined, store, 'userB');
    rcA.frameCache!.setIfDeeper('k', raw('a'), 5, 10);
    expect(rcA.frameCache!.get('k', 5)?.heldDepth).toBe(5);
    expect(rcB.frameCache!.get('k', 5)).toBeNull();           // isolated by owner
    // proves it is ONE store, not two: userB writing then userA still sees only its own
    rcB.frameCache!.setIfDeeper('k', raw('b'), 5, 10);
    expect(rcA.frameCache!.get('k', 5)?.heldDepth).toBe(5);
  });
});
