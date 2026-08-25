import { describe, expect, it } from "vitest";
import type { Session } from "../src/backends/types.ts";
import {
  CALLBACK_DATA_LIMIT,
  createEpoch,
  decodeCallback,
  encodeCallback,
  sessionSuffix,
  type CallbackAction,
} from "../src/runtime/callbacks.ts";
import {
  existingSessionsMenu,
  newSessionMenu,
  PAGE_SIZE,
  sessionLabel,
  type SessionChoice,
} from "../src/runtime/menus.ts";

const EPOCH = createEpoch(Date.parse("2026-08-25T09:00:00.000Z"));

const ACTIONS: CallbackAction[] = [
  { kind: "manage" },
  { kind: "new" },
  { kind: "create", alias: "workspace" },
  { kind: "existing", page: 0 },
  { kind: "existing", page: 12 },
  { kind: "bind", sessionSuffix: "6x5c4v01" },
  { kind: "unlink" },
  { kind: "allow", token: "7" },
  { kind: "reject", token: "7" },
  { kind: "close" },
];

describe("callback data", () => {
  it("round-trips every action with the epoch", () => {
    for (const action of ACTIONS) {
      expect(decodeCallback(encodeCallback(EPOCH, action))).toEqual({ epoch: EPOCH, action });
    }
  });

  it("stays inside Telegram's 64-byte limit for the longest configurable alias", () => {
    const alias = "a".repeat(32);
    const data = encodeCallback(EPOCH, { kind: "create", alias });
    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(CALLBACK_DATA_LIMIT);
    expect(decodeCallback(data)).toEqual({ epoch: EPOCH, action: { kind: "create", alias } });
  });

  it("refuses to build data over the limit instead of letting Telegram truncate it", () => {
    expect(() => encodeCallback(EPOCH, { kind: "create", alias: "z".repeat(80) })).toThrow(
      "over Telegram's 64",
    );
  });

  it("carries the session id tail rather than a position in the rendered list", () => {
    const sessionId = "01j8z4qk9m7f3b2n6x5c4v-created-0007";
    expect(sessionSuffix(sessionId)).toBe("ted-0007");
    const data = encodeCallback(EPOCH, { kind: "bind", sessionSuffix: sessionSuffix(sessionId) });
    expect(data).toContain("ted-0007");
    expect(data).not.toMatch(/:\d+$/);
  });

  it("keeps a colon that belongs to the session id tail", () => {
    const action: CallbackAction = { kind: "bind", sessionSuffix: "a:b:c:d1" };
    expect(decodeCallback(encodeCallback(EPOCH, action))).toEqual({ epoch: EPOCH, action });
  });

  it("reports an epoch from another process instead of applying the button", () => {
    const decoded = decodeCallback(encodeCallback("older", { kind: "unlink" }));
    expect(decoded?.epoch).toBe("older");
    expect(decoded?.epoch).not.toBe(EPOCH);
  });

  it("rejects data this process could not have written", () => {
    for (const data of ["", "nope", `${EPOCH}:m`, `${EPOCH}:?:x`, `${EPOCH}:e:-1`, `${EPOCH}:e:abc`, `${EPOCH}:c:`]) {
      expect(decodeCallback(data)).toBeUndefined();
    }
  });

  it("gives a different epoch to a later start", () => {
    expect(createEpoch(1)).not.toBe(createEpoch(2));
  });
});

function choices(count: number): SessionChoice[] {
  return Array.from({ length: count }, (_unused, index) => ({
    sessionId: `01j8z4qk9m7f3b2n6x5c4v-${String(index).padStart(4, "0")}`,
    label: `session ${index}`,
  }));
}

describe("session menus", () => {
  it("pages existing sessions eight at a time", () => {
    const first = existingSessionsMenu(EPOCH, choices(20), 0);
    expect(first.keyboard.filter((row) => row.length === 1 && row[0]?.text.startsWith("session"))).toHaveLength(
      PAGE_SIZE,
    );
    expect(first.text).toContain("第 1/3 页");
    expect(first.keyboard.at(-2)?.map((button) => button.text)).toEqual(["下一页"]);

    const middle = existingSessionsMenu(EPOCH, choices(20), 1);
    expect(middle.text).toContain("第 2/3 页");
    expect(middle.keyboard.at(-2)?.map((button) => button.text)).toEqual(["上一页", "下一页"]);
    expect(middle.keyboard[0]?.[0]?.text).toBe("session 8");
  });

  it("clamps a page number whose list has since shrunk", () => {
    const view = existingSessionsMenu(EPOCH, choices(3), 9);
    expect(view.text).toContain("第 1/1 页");
    expect(view.keyboard[0]?.[0]?.text).toBe("session 0");
  });

  it("offers only the configured aliases", () => {
    const view = newSessionMenu(EPOCH, ["work", "notes"]);
    expect(view.keyboard.slice(0, 2).map((row) => row[0]?.text)).toEqual(["work", "notes"]);
    expect(view.keyboard.at(-1)?.map((button) => button.text)).toEqual(["返回", "关闭"]);
  });

  it("labels a session by title, or by alias and id tail, never by path", () => {
    const titled: Session = { sessionId: "01j8-abcd1234", running: false, cwd: "/private/work", title: "重构 store" };
    const untitled: Session = { sessionId: "01j8-abcd1234", running: false, cwd: "/private/work" };
    expect(sessionLabel(titled, "work")).toBe("重构 store");
    expect(sessionLabel(untitled, "work")).toBe("work abcd1234");
    expect(sessionLabel(untitled, undefined)).toBe("未知目录 abcd1234");
    expect(sessionLabel(untitled, "work")).not.toContain("/private");
  });

  it("cuts an oversized title by characters, never through an emoji", () => {
    // The cut lands exactly on the emoji: by code unit it would split the
    // surrogate pair and leave half a character on the button.
    const title = `${"标".repeat(38)}\u{1f600}${"尾".repeat(10)}`;
    const session: Session = { sessionId: "01j8-abcd1234", running: false, title };

    const label = sessionLabel(session, "work");

    expect(label).toBe(`${"标".repeat(38)}\u{1f600}…`);
    expect([...label]).toHaveLength(40);
  });
});
