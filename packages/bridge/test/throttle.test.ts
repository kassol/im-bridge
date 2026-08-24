import { describe, expect, it, vi } from "vitest";
import { StreamThrottle } from "../src/telegram/throttle.ts";

const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("StreamThrottle", () => {
  it("coalesces rapid pushes into one flush per interval", async () => {
    vi.useFakeTimers();
    const flushed: string[] = [];
    const t = new StreamThrottle({
      intervalMs: 1000,
      flush: async (text) => { flushed.push(text); },
    });

    // Agent output arrives far faster than Telegram allows.
    t.push("a");
    t.push("ab");
    t.push("abc");
    await tick(0);

    // Only the newest text goes out; intermediate frames are dropped safely.
    expect(flushed).toEqual(["abc"]);

    t.push("abcd");
    await tick(999);
    expect(flushed).toEqual(["abc"]);
    await tick(1);
    expect(flushed).toEqual(["abc", "abcd"]);

    t.close();
    vi.useRealTimers();
  });

  it("honours retry_after before flushing again", async () => {
    vi.useFakeTimers();
    const flushed: string[] = [];
    const t = new StreamThrottle({
      intervalMs: 1000,
      flush: async (text) => { flushed.push(text); },
    });

    t.push("first");
    await tick(0);
    expect(flushed).toEqual(["first"]);

    // Telegram penalties escalate when ignored, so the full delay must pass.
    t.backOff(5);
    t.push("second");
    await tick(1000);
    expect(flushed).toEqual(["first"]);
    await tick(4000);
    expect(flushed).toEqual(["first", "second"]);

    t.close();
    vi.useRealTimers();
  });

  it("finish() flushes pending text immediately", async () => {
    vi.useFakeTimers();
    const flushed: string[] = [];
    const t = new StreamThrottle({
      intervalMs: 1000,
      flush: async (text) => { flushed.push(text); },
    });

    t.push("one");
    await tick(0);
    t.push("one two");

    // Turn ended: the final text must land without waiting out the interval.
    await t.finish();
    expect(flushed).toEqual(["one", "one two"]);

    t.close();
    vi.useRealTimers();
  });

  it("reports flush errors without stopping later flushes", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const flushed: string[] = [];
    let failNext = true;
    const t = new StreamThrottle({
      intervalMs: 1000,
      flush: async (text) => {
        if (failNext) { failNext = false; throw new Error("ECONNRESET"); }
        flushed.push(text);
      },
      onError: (e) => errors.push(e),
    });

    t.push("x");
    await tick(0);
    expect(errors).toHaveLength(1);

    t.push("y");
    await tick(1000);
    expect(flushed).toEqual(["y"]);

    t.close();
    vi.useRealTimers();
  });

  it("stops flushing after close()", async () => {
    vi.useFakeTimers();
    const flushed: string[] = [];
    const t = new StreamThrottle({
      intervalMs: 1000,
      flush: async (text) => { flushed.push(text); },
    });

    t.close();
    t.push("ignored");
    await tick(5000);
    expect(flushed).toEqual([]);

    vi.useRealTimers();
  });
});
