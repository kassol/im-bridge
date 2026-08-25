/**
 * The pure half of the live end-to-end run.
 *
 * The script itself needs a real bot and a real dsh, so what is proved here is
 * everything that decides whether its output is safe to keep: which fields
 * survive an evidence line, and whether the final verdict can be green while an
 * acceptance item is still unobserved.
 */
import { describe, expect, it } from "vitest";
import { CHECKLIST, Checklist, REDACTED, redactEvidence } from "../live/checklist.ts";

const TOKEN = "8123456789:AAF-abcdefghijklmnopqrstuvwxyz012345678";

function capture(): { lines: string[]; checklist: Checklist } {
  const lines: string[] = [];
  return {
    lines,
    checklist: new Checklist({ write: (line) => lines.push(line), now: () => new Date(0) }),
  };
}

describe("redactEvidence", () => {
  it("keeps ids, counts, and durations", () => {
    expect(
      redactEvidence({ threadId: 31, sessionId: "session-1", count: 2, durationMs: 1200 }),
    ).toEqual({ threadId: 31, sessionId: "session-1", count: 2, durationMs: 1200 });
  });

  it("drops every field that is not on the list", () => {
    expect(
      redactEvidence({ text: "私钥在这里", caption: "照片说明", prompt: "跑 rm -rf", threadId: 7 }),
    ).toEqual({ threadId: 7 });
  });

  it("replaces a value shaped like a bot token even under an allowed key", () => {
    expect(redactEvidence({ reason: `failed with ${TOKEN}` })).toEqual({ reason: REDACTED });
  });

  it("bounds a long allowed string instead of writing it whole", () => {
    const long = "x".repeat(500);
    const reason = redactEvidence({ reason: long })["reason"];
    expect(typeof reason).toBe("string");
    expect((reason as string).length).toBe(120);
  });

  it("drops a non-finite number rather than writing null", () => {
    expect(redactEvidence({ count: Number.NaN, durationMs: Number.POSITIVE_INFINITY })).toEqual({});
  });
});

describe("Checklist", () => {
  it("covers every acceptance item exactly once", () => {
    const ids = CHECKLIST.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("album-atomic");
    expect(ids).toContain("multipart-failure");
    expect(ids).toContain("restart-recovery");
  });

  it("starts every item pending and refuses an unknown id", () => {
    const { checklist } = capture();
    for (const item of CHECKLIST) expect(checklist.state(item.id)).toBe("pending");
    expect(() => checklist.pass("no-such-item")).toThrow(/unknown checklist item/u);
  });

  it("writes one redacted JSON line per state change", () => {
    const { lines, checklist } = capture();
    checklist.pass("text-prompt", { sessionId: "session-1", durationMs: 900 });
    checklist.fail("text-steer", "TelegramApiError", { threadId: 31 });

    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records[0]).toEqual({
      time: "1970-01-01T00:00:00.000Z",
      event: "live.item.passed",
      item: "text-prompt",
      sessionId: "session-1",
      durationMs: 900,
    });
    expect(records[1]).toEqual({
      time: "1970-01-01T00:00:00.000Z",
      event: "live.item.failed",
      item: "text-steer",
      reason: "TelegramApiError",
      threadId: 31,
    });
  });

  it("stays red while any item is unobserved", () => {
    const { checklist } = capture();
    for (const item of CHECKLIST) checklist.pass(item.id);
    expect(checklist.summary().ok).toBe(true);

    const partial = capture().checklist;
    for (const item of CHECKLIST.slice(1)) partial.pass(item.id);
    const summary = partial.summary();
    expect(summary.pending).toBe(1);
    expect(summary.ok).toBe(false);
    expect(partial.report().at(-1)).toContain("FAIL");
  });

  it("counts a failed item as failed, never as pending", () => {
    const { checklist } = capture();
    for (const item of CHECKLIST) checklist.pass(item.id);
    checklist.fail("long-output", "split-failed");
    const summary = checklist.summary();
    expect(summary.failed).toBe(1);
    expect(summary.pending).toBe(0);
    expect(summary.ok).toBe(false);
  });
});
