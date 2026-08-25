/**
 * The global ceiling on image bytes held in memory.
 *
 * Downloads are the one place where the bridge holds something large. Several
 * threads can be downloading at once, so a per-download limit alone bounds
 * nothing: four threads each holding four 5 MiB images would be 80 MiB. This
 * semaphore bounds the sum instead, and separately bounds how many threads may
 * hold any budget at all.
 *
 * Grants are first in, first out and the accounting happens at grant time, not
 * when the waiter resumes: a large waiter at the head therefore blocks smaller
 * ones behind it instead of being starved by them.
 */
export interface MemorySemaphoreOptions {
  readonly capacityBytes: number;
  readonly maxHolders: number;
}

interface Waiter {
  readonly weightBytes: number;
  readonly grant: () => void;
}

export class MemorySemaphore {
  readonly #capacityBytes: number;
  readonly #maxHolders: number;
  readonly #waiters: Waiter[] = [];

  #usedBytes = 0;
  #holders = 0;

  constructor(options: MemorySemaphoreOptions) {
    this.#capacityBytes = options.capacityBytes;
    this.#maxHolders = options.maxHolders;
  }

  /**
   * Reserves `weightBytes` and returns the release. The caller must release in
   * a `finally`, because a failed download holds exactly as much budget as a
   * successful one until it does.
   */
  async acquire(weightBytes: number): Promise<() => void> {
    if (this.#waiters.length === 0 && this.#fits(weightBytes)) {
      this.#take(weightBytes);
    } else {
      await new Promise<void>((resolve) => {
        this.#waiters.push({ weightBytes, grant: resolve });
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#usedBytes -= weightBytes;
      this.#holders -= 1;
      this.#pump();
    };
  }

  #fits(weightBytes: number): boolean {
    return this.#holders < this.#maxHolders && this.#usedBytes + weightBytes <= this.#capacityBytes;
  }

  #take(weightBytes: number): void {
    this.#usedBytes += weightBytes;
    this.#holders += 1;
  }

  #pump(): void {
    for (;;) {
      const next = this.#waiters[0];
      if (next === undefined || !this.#fits(next.weightBytes)) return;
      this.#waiters.shift();
      this.#take(next.weightBytes);
      next.grant();
    }
  }
}
