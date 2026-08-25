/**
 * Scheduler tests.
 *
 * The scheduler decides only two things — who waits for whom, and how many run
 * at once — so the tasks here are gates rather than real work.
 */
import { describe, expect, it } from "vitest";
import { MAX_ACTIVE_THREADS, ThreadScheduler } from "../src/runtime/scheduler.ts";

interface Gate {
  readonly wait: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Lets every already-resolved promise run before the assertion. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

describe("ThreadScheduler", () => {
  it("runs the tasks of one thread in the order they arrived", async () => {
    const scheduler = new ThreadScheduler();
    const done: number[] = [];
    const first = gate();

    const one = scheduler.run("thread-1", async () => {
      await first.wait;
      done.push(1);
    });
    const two = scheduler.run("thread-1", async () => {
      done.push(2);
    });

    await settle();
    // The second task cannot overtake the first, however fast it is.
    expect(done).toEqual([]);
    first.open();
    await Promise.all([one, two]);
    expect(done).toEqual([1, 2]);
  });

  it("runs four threads at once and admits the fifth when one finishes", async () => {
    const scheduler = new ThreadScheduler();
    const started: string[] = [];
    const gates = new Map<string, Gate>();
    const work: Array<Promise<void>> = [];

    for (let index = 0; index < MAX_ACTIVE_THREADS + 1; index += 1) {
      const key = `thread-${String(index)}`;
      const held = gate();
      gates.set(key, held);
      work.push(
        scheduler.run(key, async () => {
          started.push(key);
          await held.wait;
        }),
      );
    }

    await settle();
    expect(started).toEqual(["thread-0", "thread-1", "thread-2", "thread-3"]);

    gates.get("thread-0")?.open();
    await work[0];
    await settle();
    expect(started).toHaveLength(MAX_ACTIVE_THREADS + 1);
    expect(started.at(-1)).toBe("thread-4");

    for (const held of gates.values()) held.open();
    await Promise.all(work);
  });

  it("keeps a busy thread from holding its slot for a whole backlog", async () => {
    const scheduler = new ThreadScheduler({ maxThreads: 1 });
    const started: string[] = [];
    const busy = gate();

    const first = scheduler.run("thread-1", async () => {
      started.push("busy-1");
      await busy.wait;
    });
    const second = scheduler.run("thread-1", async () => {
      started.push("busy-2");
    });
    const other = scheduler.run("thread-2", async () => {
      started.push("other");
    });

    busy.open();
    await Promise.all([first, second, other]);
    // The waiting thread goes before the busy thread's next task.
    expect(started).toEqual(["busy-1", "other", "busy-2"]);
  });

  it("reports a failed task to its caller and keeps the thread running", async () => {
    const scheduler = new ThreadScheduler();
    const failing = scheduler.run("thread-1", async () => {
      throw new Error("task exploded");
    });
    let ran = false;
    const next = scheduler.run("thread-1", async () => {
      ran = true;
    });

    await expect(failing).rejects.toThrow("task exploded");
    await next;
    expect(ran).toBe(true);
    expect(scheduler.size).toBe(0);
  });
});
