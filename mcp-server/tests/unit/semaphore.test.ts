import { describe, it, expect } from 'vitest';
import { Semaphore } from '../../src/infrastructure/semaphore.js';

describe('Semaphore', () => {
  it('never runs more than max concurrently and runs all tasks', async () => {
    const sem = new Semaphore(2);
    let active = 0, peak = 0, done = 0;
    const task = () => sem.run(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--; done++;
    });
    await Promise.all(Array.from({ length: 6 }, task));
    expect(peak).toBeLessThanOrEqual(2);
    expect(done).toBe(6);
  });

  it('propagates errors and still releases the slot', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok'); // slot was freed
  });

  it('never exceeds max when a fresh caller races a woken waiter', async () => {
    // Chaining the fresh caller off `a`'s own resolution (the shape first tried here)
    // never reproduces the race: the release path resolves the waiter's promise
    // *before* `a`'s own promise settles, so the waiter's `active++` continuation is
    // always enqueued ahead of anything chained via `a.then(...)`. To land the fresh
    // caller inside the actual under-count window (after `active--`, before the woken
    // waiter's `active++` resumes), it must be scheduled independently, timed to a
    // precise microtask offset from `Promise.resolve()` — found empirically to be 2
    // hops for this shape (1 holder, 1 waiter, single-await track). This reliably
    // reproduces peak=2 on the buggy implementation and peak=1 after the fix.
    const sem = new Semaphore(1);
    let active = 0, peak = 0;
    const track = async () => {
      active++; peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
    };
    const a = sem.run(() => track());              // holds the slot
    const b = sem.run(() => track());               // queued waiter
    const c = Promise.resolve()
      .then(() => {})
      .then(() => sem.run(() => track()));           // fresh caller, timed into the release window
    await Promise.all([a, b, c]);
    expect(peak).toBe(1);
  });

  it('never exceeds max under a broad microtask-only fan-out (scheduler-independent)', async () => {
    // Pins the same bound as the timing-sensitive race test above, but without relying on a
    // precise microtask offset: a wide Promise.all of many tasks, each yielding a couple of
    // microtask hops, exercises many interleavings of the acquire/release path at once.
    const max = 3;
    const sem = new Semaphore(max);
    let active = 0, peak = 0, completed = 0;
    const task = () => sem.run(async () => {
      active++; peak = Math.max(peak, active);
      await Promise.resolve();
      await Promise.resolve();
      active--; completed++;
    });
    await Promise.all(Array.from({ length: 30 }, task));
    expect(peak).toBeLessThanOrEqual(max);
    expect(completed).toBe(30);
  });
});
