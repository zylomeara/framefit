import { describe, it, expect } from 'vitest';
import { getMaterializeGovernor, getFigmaSemaphore } from '../../src/infrastructure/semaphore.js';

describe('getMaterializeGovernor (process-wide singleton)', () => {
  it('returns a stable instance and ignores later max args (memoized)', () => {
    const a = getMaterializeGovernor(1);
    const b = getMaterializeGovernor(4);
    expect(a).toBe(b);
  });
  it('is a DISTINCT singleton from the Figma request semaphore', () => {
    expect(getMaterializeGovernor(1)).not.toBe(getFigmaSemaphore(2));
  });
  it('with max=1, a second run() waits for the first to release (serializes parse-into-heap)', async () => {
    const gov = getMaterializeGovernor(1);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = gov.run(async () => { order.push('first-start'); await new Promise<void>((r) => { releaseFirst = r; }); order.push('first-end'); });
    const second = gov.run(async () => { order.push('second-start'); });
    // let microtasks flush; second must NOT have started while first holds the only permit
    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });
});
