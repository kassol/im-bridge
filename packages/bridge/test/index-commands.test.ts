/**
 * Local command seam tests.
 *
 * The wizard runs `topic detect` and `probe` against the real Bot API, so both
 * are driven here against the fake one: the commands take a base URL, and the
 * evidence they print is captured from stdout, where the wizard reads it. What
 * matters is that they print the ids the wizard needs and never the token.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.ts";
import { detectTopic, probeRichMessages, readNumberFlag, soleAllowedUserId } from "../src/index.ts";
import { startFakeTelegram, type FakeCall, type FakeReply, type FakeTelegram } from "./fake-telegram.ts";

const TOKEN = "8123456789:AAF-abcdefghijklmnopqrstuvwxyz012345678";
const AUTHORISED = 149523521;
const STRANGER = 999000111;
const THREAD = 31;

const IDENTITY = { ok: true, result: { id: 42, username: "im_bridge_bot", has_topics_enabled: true } };

let dir: string;
let server: FakeTelegram | undefined;
let printed: string[];

function config(extra: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    botToken: TOKEN,
    allowedUserIds: [AUTHORISED],
    cwdAliases: new Map<string, string>(),
    databasePath: join(dir, "bridge.db"),
    dshUrl: "http://127.0.0.1:3080",
    logLevel: "info",
    ...extra,
  };
}

/** One private-topic message, as Telegram delivers it. */
function topicMessage(updateId: number, userId: number): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: 77,
      from: { id: userId, is_bot: false },
      chat: { id: userId, type: "private" },
      message_thread_id: THREAD,
      text: "在这里",
    },
  };
}

async function fake(handle: (call: FakeCall) => FakeReply): Promise<FakeTelegram> {
  server = await startFakeTelegram(handle);
  return server;
}

function methods(): string[] {
  return (server?.calls ?? []).map((call) => call.method);
}

function records(): Array<Record<string, unknown>> {
  return printed.map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "im-bridge-commands-"));
  printed = [];
  server = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    printed.push(String(chunk).trimEnd());
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  if (server !== undefined) await server.close();
});

describe("topic detect", () => {
  it("prints the ids of the first authorised private topic and ignores a stranger", async () => {
    await fake((call) => {
      if (call.method === "getMe") return { json: IDENTITY };
      return call.count === 1
        ? { json: { ok: true, result: [topicMessage(20, STRANGER)] } }
        : { json: { ok: true, result: [topicMessage(21, AUTHORISED)] } };
    });

    await detectTopic(config(), server?.baseUrl);

    const detected = records().find((record) => record["event"] === "bridge.topic.detected");
    expect(detected).toMatchObject({ chatId: AUTHORISED, threadId: THREAD });
    // The stranger's update was settled, not detected: two polls were needed.
    expect(methods().filter((method) => method === "getUpdates")).toHaveLength(2);
    for (const line of printed) expect(line).not.toContain(TOKEN);
  });
});

describe("probe", () => {
  it("sends one structured draft and one final Rich Message to the thread", async () => {
    await fake((call) => {
      if (call.method === "getMe") return { json: IDENTITY };
      if (call.method === "sendRichMessage") return { json: { ok: true, result: { message_id: 4242 } } };
      return { json: { ok: true, result: true } };
    });

    await probeRichMessages(config(), ["--thread", String(THREAD)], server?.baseUrl);

    expect(methods()).toEqual(["getMe", "sendRichMessageDraft", "sendRichMessage"]);
    const draft = server?.calls[1];
    expect(draft?.body["chat_id"]).toBe(AUTHORISED);
    expect(draft?.body["message_thread_id"]).toBe(THREAD);
    const blocks = (draft?.body["rich_message"] as { blocks: Array<{ type: string; language?: string }> }).blocks;
    expect(blocks.map((block) => block.type)).toEqual(["thinking", "paragraph", "pre"]);
    expect(blocks[2]?.language).toBe("python");
    expect(records().at(-1)).toMatchObject({ event: "bridge.probe.passed", messageId: 4242 });
    for (const line of printed) expect(line).not.toContain(TOKEN);
  });

  it("needs an explicit chat when the allowlist names more than one user", () => {
    expect(() => soleAllowedUserId(config({ allowedUserIds: [AUTHORISED, STRANGER] }))).toThrow(/--chat/u);
    expect(soleAllowedUserId(config())).toBe(AUTHORISED);
  });

  it("rejects a flag value that is not an integer id", () => {
    expect(() => readNumberFlag(["--thread", "abc"], "--thread")).toThrow(/integer id/u);
    expect(readNumberFlag(["--chat", "5"], "--chat")).toBe(5);
    expect(readNumberFlag([], "--thread")).toBeUndefined();
  });
});
