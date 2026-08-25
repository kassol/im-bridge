/**
 * Update admission.
 *
 * Two rules decide when an update runs. Inside one thread the user sees a
 * conversation, so its updates run one at a time and in arrival order: a
 * second message must not overtake the prompt before it. Across threads the
 * bridge runs at most four at once, because every unit may hold image bytes
 * and a Telegram send, and an unbounded fan-out would turn a burst into a
 * rate-limit penalty that lasts longer than the burst did.
 *
 * A lane is one thread's queue. It holds the global slot for exactly one task
 * and then releases it, so a busy thread cannot keep a fifth thread waiting
 * behind its whole backlog. Lanes are admitted in the order they became ready:
 * `Map` iterates by insertion, and an emptied lane is deleted, so a thread that
 * just ran re-enters at the back.
 */

/** Threads that may run at once. Their work holds memory and Telegram quota. */
export const MAX_ACTIVE_THREADS = 4;

interface Task {
  readonly run: () => Promise<void>;
  readonly settle: (error: unknown) => void;
}

interface Lane {
  readonly tasks: Task[];
  active: boolean;
}

export interface ThreadSchedulerOptions {
  /** Injected by tests. Production uses `MAX_ACTIVE_THREADS`. */
  maxThreads?: number;
}

export class ThreadScheduler {
  readonly #maxThreads: number;
  readonly #lanes = new Map<string, Lane>();
  /** Resolved once every lane is empty. Shutdown waits on these. */
  readonly #drains = new Set<() => void>();
  #active = 0;

  constructor(options: ThreadSchedulerOptions = {}) {
    this.#maxThreads = options.maxThreads ?? MAX_ACTIVE_THREADS;
  }

  /** Threads with work, running or waiting. */
  get size(): number {
    return this.#lanes.size;
  }

  /**
   * Resolves when nothing is running and nothing is queued.
   *
   * Shutdown uses it to wait out the work already admitted. It says nothing
   * about work admitted afterwards, so a caller that must reach a quiet state
   * checks `size` again after it resolves.
   */
  drain(): Promise<void> {
    if (this.#idle()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#drains.add(resolve);
    });
  }

  /**
   * Queues one task on `key` and resolves when that task has finished.
   *
   * The task is queued synchronously, so a caller that dispatches updates in
   * order gets them executed in that order without awaiting each one.
   */
  run(key: string, task: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const lane = this.#lanes.get(key) ?? { tasks: [], active: false };
      lane.tasks.push({
        run: task,
        settle: (error) => (error === undefined ? resolve() : reject(error)),
      });
      this.#lanes.set(key, lane);
      this.#pump();
    });
  }

  /** Starts as many waiting lanes as the global limit allows. */
  #pump(): void {
    for (const [key, lane] of this.#lanes) {
      if (this.#active >= this.#maxThreads) return;
      if (lane.active || lane.tasks.length === 0) continue;
      lane.active = true;
      this.#active += 1;
      void this.#step(key, lane);
    }
  }

  async #step(key: string, lane: Lane): Promise<void> {
    const task = lane.tasks[0];
    if (task === undefined) return;
    let failure: unknown;
    try {
      await task.run();
    } catch (error) {
      // `undefined` means success, so a thrown `undefined` still reports as a
      // failure rather than resolving the caller.
      failure = error ?? new Error("scheduled task failed");
    }
    lane.tasks.shift();
    lane.active = false;
    this.#active -= 1;
    // A thread with more work re-enters at the back of the admission order,
    // so it cannot hold a slot against a thread that has been waiting.
    this.#lanes.delete(key);
    if (lane.tasks.length > 0) this.#lanes.set(key, lane);
    task.settle(failure);
    this.#pump();
    if (!this.#idle()) return;
    const waiting = [...this.#drains];
    this.#drains.clear();
    for (const resolve of waiting) resolve();
  }

  #idle(): boolean {
    return this.#active === 0 && this.#lanes.size === 0;
  }
}
