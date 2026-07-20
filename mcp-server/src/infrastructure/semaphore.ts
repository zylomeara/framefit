// Bounds how many wrapped operations run at once; the rest queue FIFO. Used to cap
// concurrent heavy Figma subtree fetches (a single whole-file tree can be >100MB —
// several in flight at once starve the event loop and risk OOM on the no-swap prod box).
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();        // hand the slot directly to the waiter; active unchanged
      else this.active--;      // no waiter → free the slot
    }
  }
}

// Process-wide shared instance so every FigmaRestAdapter (per-token, created per-request in
// multi-tenant) draws from the same concurrency budget. First call fixes the limit.
let shared: Semaphore | undefined;
export function getFigmaSemaphore(max: number): Semaphore {
  if (!shared) shared = new Semaphore(max);
  return shared;
}

// Process-wide governor for the parse-into-heap hydration path (getFrameRaw materializeFrame). A
// SEPARATE singleton from getFigmaSemaphore so N concurrent hydrations cannot multiply the transient
// parse spike even if the Figma request concurrency is raised. First call fixes the limit.
let sharedMaterialize: Semaphore | undefined;
export function getMaterializeGovernor(max: number): Semaphore {
  if (!sharedMaterialize) sharedMaterialize = new Semaphore(max);
  return sharedMaterialize;
}
