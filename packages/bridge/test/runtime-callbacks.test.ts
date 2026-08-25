import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  directoryDigest,
  directoryLabel,
  listSubdirectories,
  resolveInsideRoot,
  type DirectoryChoice,
} from "../src/runtime/directories.ts";
import {
  existingSessionsMenu,
  newSessionMenu,
  PAGE_SIZE,
  sessionLabel,
  subdirectoryMenu,
  type SessionChoice,
} from "../src/runtime/menus.ts";

const EPOCH = createEpoch(Date.parse("2026-08-25T09:00:00.000Z"));

const ACTIONS: CallbackAction[] = [
  { kind: "manage" },
  { kind: "new" },
  { kind: "root", alias: "workspace", page: 0 },
  { kind: "root", alias: "workspace", page: 4 },
  { kind: "create", alias: "workspace", digest: directoryDigest("im-bridge") },
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
    const digest = directoryDigest("目录名可以很长，也可以不是 ASCII".repeat(20));
    const action: CallbackAction = { kind: "create", alias, digest };
    const data = encodeCallback(EPOCH, action);
    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(CALLBACK_DATA_LIMIT);
    expect(decodeCallback(data)).toEqual({ epoch: EPOCH, action });
  });

  it("refuses to build data over the limit instead of letting Telegram truncate it", () => {
    expect(() => encodeCallback(EPOCH, { kind: "create", alias: "z".repeat(80), digest: "0" })).toThrow(
      "over Telegram's 64",
    );
  });

  it("names a directory by the digest of its name, never by the name or a page position", () => {
    const data = encodeCallback(EPOCH, { kind: "create", alias: "work", digest: directoryDigest("im-bridge") });
    expect(data).not.toContain("im-bridge");
    expect(data).toContain(directoryDigest("im-bridge"));
    expect(directoryDigest("im-bridge")).not.toBe(directoryDigest("im-bridge2"));
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
    const rejected = [
      "",
      "nope",
      `${EPOCH}:m`,
      `${EPOCH}:?:x`,
      `${EPOCH}:e:-1`,
      `${EPOCH}:e:abc`,
      `${EPOCH}:c:`,
      `${EPOCH}:c:work`,
      `${EPOCH}:c:work:`,
      `${EPOCH}:d:work`,
      `${EPOCH}:d:work:-1`,
      `${EPOCH}:d:work:abc`,
    ];
    for (const data of rejected) {
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

function directories(count: number): DirectoryChoice[] {
  return Array.from({ length: count }, (_unused, index) => {
    const name = `dir-${String(index).padStart(2, "0")}`;
    return { name, digest: directoryDigest(name) };
  });
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

  it("offers only the configured cwd roots", () => {
    const view = newSessionMenu(EPOCH, ["work", "notes"]);
    expect(view.keyboard.slice(0, 2).map((row) => row[0]?.text)).toEqual(["work", "notes"]);
    expect(view.keyboard.at(-1)?.map((button) => button.text)).toEqual(["返回", "关闭"]);
  });

  it("pages a root's subdirectories eight at a time", () => {
    const first = subdirectoryMenu(EPOCH, "work", directories(20), 0);
    expect(first.keyboard.filter((row) => row.length === 1 && row[0]?.text.startsWith("dir-"))).toHaveLength(
      PAGE_SIZE,
    );
    expect(first.text).toContain("在 work 下选择目录");
    expect(first.text).toContain("第 1/3 页");
    expect(first.keyboard.at(-2)?.map((button) => button.text)).toEqual(["下一页"]);

    const middle = subdirectoryMenu(EPOCH, "work", directories(20), 1);
    expect(middle.text).toContain("第 2/3 页");
    expect(middle.keyboard.at(-2)?.map((button) => button.text)).toEqual(["上一页", "下一页"]);
    expect(middle.keyboard[0]?.[0]?.text).toBe("dir-08");
    expect(middle.keyboard.at(-1)?.map((button) => button.text)).toEqual(["返回", "关闭"]);
  });

  it("clamps a subdirectory page whose list has since shrunk, and says when there is none", () => {
    expect(subdirectoryMenu(EPOCH, "work", directories(3), 9).text).toContain("第 1/1 页");
    const empty = subdirectoryMenu(EPOCH, "work", [], 0);
    expect(empty.text).toBe("work 下没有可用的子目录。");
    expect(empty.keyboard).toEqual([[expect.anything(), expect.anything()]]);
  });

  it("labels a session by title, or by root alias, directory, and id tail, never by path", () => {
    const titled: Session = { sessionId: "01j8-abcd1234", running: false, cwd: "/private/work", title: "重构 store" };
    const untitled: Session = { sessionId: "01j8-abcd1234", running: false, cwd: "/private/work/im-bridge" };
    expect(sessionLabel(titled, "work")).toBe("重构 store");
    expect(sessionLabel(untitled, "work/im-bridge")).toBe("work/im-bridge abcd1234");
    expect(sessionLabel(untitled, undefined)).toBe("未知目录 abcd1234");
    expect(sessionLabel(untitled, "work/im-bridge")).not.toContain("/private");
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

describe("subdirectories of a cwd root", () => {
  let workspace: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), "im-bridge-roots-")));
    root = join(workspace, "root");
    outside = join(workspace, "outside");
    mkdirSync(root);
    mkdirSync(outside);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("lists non-hidden immediate directories by name, and nothing else", async () => {
    for (const name of ["zulu", "alpha", ".git", "mike"]) mkdirSync(join(root, name));
    mkdirSync(join(root, "alpha", "nested"));
    writeFileSync(join(root, "notes.txt"), "x", "utf8");
    // A link is not a directory entry, so a link out of the root is not offered.
    symlinkSync(outside, join(root, "escape"));

    const choices = await listSubdirectories(root);

    expect(choices.map((choice) => choice.name)).toEqual(["alpha", "mike", "zulu"]);
    expect(choices.map((choice) => choice.digest)).toEqual(["alpha", "mike", "zulu"].map(directoryDigest));
  });

  it("resolves a listed name to its real path inside the root", async () => {
    mkdirSync(join(root, "alpha"));
    await expect(resolveInsideRoot(root, "alpha")).resolves.toBe(join(root, "alpha"));
  });

  it("refuses a name that left the root or stopped existing", async () => {
    symlinkSync(outside, join(root, "escape"));
    await expect(resolveInsideRoot(root, "escape")).resolves.toBeUndefined();
    await expect(resolveInsideRoot(root, "..")).resolves.toBeUndefined();
    await expect(resolveInsideRoot(root, "absent")).resolves.toBeUndefined();
  });

  it("names a cwd by its root alias and the one directory below it", () => {
    expect(directoryLabel("work", root, root)).toBe("work");
    expect(directoryLabel("work", root, join(root, "alpha"))).toBe("work/alpha");
    expect(directoryLabel("work", root, join(root, "alpha", "nested"))).toBe("work/alpha");
    expect(directoryLabel("work", root, outside)).toBeUndefined();
  });
});
