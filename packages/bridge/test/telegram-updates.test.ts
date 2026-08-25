import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, type Logger } from "../src/log.ts";
import { Allowlist } from "../src/telegram/allowlist.ts";
import { TelegramApi, type TelegramUpdate } from "../src/telegram/api.ts";
import {
  runUpdateLoop,
  TOPIC_INSTRUCTION,
  type InboundUpdate,
  type PollingCheckpoint,
} from "../src/telegram/updates.ts";
import { startFakeTelegram, type FakeReply, type FakeTelegram } from "./fake-telegram.ts";

const TOKEN = "8123456789:AAF-abcdefghijklmnopqrstuvwxyz012345678";
const AUTHORISED = 149523521;
const STRANGER = 999000111;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fake(handle: (call: { method: string; count: number; body: Record<string, unknown> }) => FakeReply): Promise<FakeTelegram> {
  const server = await startFakeTelegram(handle);
  cleanups.push(() => server.close());
  return server;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}

function silentLogger(): Logger {
  return createLogger({ level: "debug", write: () => {} });
}

/** The durable floor the loop polls from, with the store left out of it. */
function memoryCheckpoint(start = 0): PollingCheckpoint & { readonly settled: number[] } {
  const settled: number[] = [];
  return {
    settled,
    checkpoint: () => start,
    settleUpdates: (updateIds) => {
      settled.push(...updateIds);
      return start;
    },
  };
}

/** Runs the loop over one batch of updates, then cancels it. */
async function drain(
  updates: TelegramUpdate[],
  options: { polls?: number } = {},
): Promise<{ server: FakeTelegram; received: InboundUpdate[]; settled: number[] }> {
  const server = await fake((call) => {
    if (call.method !== "getUpdates") return { json: { ok: true, result: { message_id: 500 } } };
    return call.count === 1 ? { json: { ok: true, result: updates } } : { hang: true };
  });
  const api = new TelegramApi({ token: TOKEN, baseUrl: server.baseUrl });
  const controller = new AbortController();
  const received: InboundUpdate[] = [];
  const checkpoint = memoryCheckpoint();
  const loop = runUpdateLoop({
    api,
    allowlist: new Allowlist([AUTHORISED]),
    checkpoint,
    logger: silentLogger(),
    signal: controller.signal,
    onUpdate: (update) => {
      received.push(update);
    },
  });
  await waitFor(() => server.calls.filter((call) => call.method === "getUpdates").length === (options.polls ?? 2));
  controller.abort();
  await loop;
  return { server, received, settled: checkpoint.settled };
}

function privateTopicMessage(fields: Record<string, unknown>, userId = AUTHORISED): TelegramUpdate {
  return {
    update_id: 10,
    message: {
      message_id: 77,
      from: { id: userId, is_bot: false },
      chat: { id: 5000, type: "private" },
      message_thread_id: 31,
      ...fields,
    },
  };
}

describe("update filtering", () => {
  it("drops an unauthorised user before looking at the chat or the callback data", async () => {
    const { server, received } = await drain([
      privateTopicMessage({ text: "run rm -rf /" }, STRANGER),
      {
        update_id: 11,
        callback_query: {
          id: "cb-1",
          from: { id: STRANGER, is_bot: false },
          data: "link:1",
          message: { message_id: 78, chat: { id: 5000, type: "private" }, message_thread_id: 31 },
        },
      },
    ]);

    expect(received).toEqual([]);
    // Silence is the point: a reply would confirm the bot exists.
    expect(server.methods().every((method) => method === "getUpdates")).toBe(true);
  });

  it("answers authorised main-chat input with the topic instruction", async () => {
    const { server, received } = await drain([
      {
        update_id: 12,
        message: { message_id: 80, from: { id: AUTHORISED }, chat: { id: 5000, type: "private" }, text: "hello" },
      },
    ]);

    expect(received).toEqual([]);
    const sent = server.calls.filter((call) => call.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ chat_id: 5000, text: TOPIC_INSTRUCTION });
  });

  it("ignores group and channel updates", async () => {
    const { server, received } = await drain([
      {
        update_id: 13,
        message: {
          message_id: 81,
          from: { id: AUTHORISED },
          chat: { id: -100, type: "supergroup" },
          message_thread_id: 4,
          text: "hello",
        },
      },
      { update_id: 14, channel_post: { message_id: 82, chat: { id: -200, type: "channel" }, text: "hello" } },
    ]);

    expect(received).toEqual([]);
    expect(server.methods().every((method) => method === "getUpdates")).toBe(true);
  });

  it("normalizes a private-topic text message", async () => {
    const { received } = await drain([privateTopicMessage({ text: "build it" })]);
    expect(received).toEqual([
      {
        kind: "message",
        updateId: 10,
        thread: { chatId: 5000, threadId: 31 },
        userId: AUTHORISED,
        messageId: 77,
        text: "build it",
      },
    ]);
  });

  it("normalizes photos, captions, albums, and image documents", async () => {
    const { received } = await drain([
      privateTopicMessage({
        media_group_id: "album-1",
        caption: "look at this",
        photo: [
          { file_id: "small", file_unique_id: "u1", width: 90, height: 60, file_size: 1_000 },
          { file_id: "large", file_unique_id: "u2", width: 1280, height: 860 },
        ],
      }),
      {
        update_id: 11,
        message: {
          message_id: 78,
          from: { id: AUTHORISED },
          chat: { id: 5000, type: "private" },
          message_thread_id: 31,
          document: { file_id: "doc-1", file_name: "diagram.png", mime_type: "image/png", file_size: 4_096 },
        },
      },
    ]);

    expect(received[0]).toEqual({
      kind: "message",
      updateId: 10,
      thread: { chatId: 5000, threadId: 31 },
      userId: AUTHORISED,
      messageId: 77,
      text: "look at this",
      mediaGroupId: "album-1",
      photo: [
        { fileId: "small", width: 90, height: 60, fileSize: 1_000 },
        { fileId: "large", width: 1280, height: 860 },
      ],
    });
    expect(received[1]).toEqual({
      kind: "message",
      updateId: 11,
      thread: { chatId: 5000, threadId: 31 },
      userId: AUTHORISED,
      messageId: 78,
      document: { fileId: "doc-1", fileName: "diagram.png", mimeType: "image/png", fileSize: 4_096 },
    });
  });

  it("normalizes a callback query raised inside a topic", async () => {
    const { received } = await drain([
      {
        update_id: 15,
        callback_query: {
          id: "cb-9",
          from: { id: AUTHORISED },
          data: "session:abc",
          message: { message_id: 90, chat: { id: 5000, type: "private" }, message_thread_id: 31 },
        },
      },
    ]);

    expect(received).toEqual([
      {
        kind: "callback",
        updateId: 15,
        thread: { chatId: 5000, threadId: 31 },
        userId: AUTHORISED,
        callbackId: "cb-9",
        data: "session:abc",
        messageId: 90,
      },
    ]);
  });

  it("advances the polling offset past the highest received update", async () => {
    const { server } = await drain([
      privateTopicMessage({ text: "one" }),
      { ...privateTopicMessage({ text: "two" }), update_id: 41 },
    ]);
    const polls = server.calls.filter((call) => call.method === "getUpdates");
    expect(polls[0]?.body).not.toHaveProperty("offset");
    expect(polls[1]?.body).toMatchObject({ offset: 42 });
  });
});

describe("polling checkpoint", () => {
  it("resumes from the persisted checkpoint and settles what it drops", async () => {
    const server = await fake((call) =>
      call.count === 1
        ? { json: { ok: true, result: [privateTopicMessage({ text: "run rm -rf /" }, STRANGER)] } }
        : { hang: true },
    );
    const api = new TelegramApi({ token: TOKEN, baseUrl: server.baseUrl });
    const controller = new AbortController();
    const checkpoint = memoryCheckpoint(700);
    const loop = runUpdateLoop({
      api,
      allowlist: new Allowlist([AUTHORISED]),
      checkpoint,
      logger: silentLogger(),
      signal: controller.signal,
      onUpdate: () => {},
    });
    await waitFor(() => server.calls.filter((call) => call.method === "getUpdates").length === 2);
    controller.abort();
    await loop;

    // The first poll already asks past everything the last run confirmed.
    expect(server.calls[0]?.body).toMatchObject({ offset: 701 });
    // Nothing else will finish a dropped update, so the loop settles it.
    expect(checkpoint.settled).toEqual([10]);
  });
});

describe("update loop lifecycle", () => {
  it("backs off from one to thirty seconds and recovers", async () => {
    const slept: number[] = [];
    const controller = new AbortController();
    const server = await fake((call) => (call.count <= 7 ? { status: 500, json: { ok: false } } : { hang: true }));
    const api = new TelegramApi({ token: TOKEN, baseUrl: server.baseUrl });
    const loop = runUpdateLoop({
      api,
      allowlist: new Allowlist([AUTHORISED]),
      checkpoint: memoryCheckpoint(),
      logger: silentLogger(),
      signal: controller.signal,
      onUpdate: () => {},
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await waitFor(() => slept.length === 7);
    controller.abort();
    await loop;
    expect(slept).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it("waits the complete retry_after when polling is throttled", async () => {
    const slept: number[] = [];
    const controller = new AbortController();
    const server = await fake((call) =>
      call.count === 1
        ? { status: 429, json: { ok: false, error_code: 429, parameters: { retry_after: 12 } } }
        : { hang: true },
    );
    const api = new TelegramApi({ token: TOKEN, baseUrl: server.baseUrl });
    const loop = runUpdateLoop({
      api,
      allowlist: new Allowlist([AUTHORISED]),
      checkpoint: memoryCheckpoint(),
      logger: silentLogger(),
      signal: controller.signal,
      onUpdate: () => {},
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await waitFor(() => slept.length === 1);
    controller.abort();
    await loop;
    expect(slept).toEqual([12_000]);
  });

  it("stops polling when cancelled", async () => {
    const server = await fake(() => ({ hang: true }));
    const api = new TelegramApi({ token: TOKEN, baseUrl: server.baseUrl });
    const controller = new AbortController();
    const loop = runUpdateLoop({
      api,
      allowlist: new Allowlist([AUTHORISED]),
      checkpoint: memoryCheckpoint(),
      logger: silentLogger(),
      signal: controller.signal,
      onUpdate: () => {},
    });
    await waitFor(() => server.calls.length === 1);
    controller.abort();
    await expect(loop).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.calls).toHaveLength(1);
  });

  it("logs a dropped update without its text and keeps polling after a handler failure", async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    const server = await fake((call) =>
      call.count === 1
        ? { json: { ok: true, result: [privateTopicMessage({ text: "secret user text" }, STRANGER), privateTopicMessage({ text: "secret user text" })] } }
        : { hang: true },
    );
    const api = new TelegramApi({ token: TOKEN, baseUrl: server.baseUrl });
    const loop = runUpdateLoop({
      api,
      allowlist: new Allowlist([AUTHORISED]),
      checkpoint: memoryCheckpoint(),
      logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
      signal: controller.signal,
      onUpdate: () => {
        throw new Error("handler exploded");
      },
    });
    await waitFor(() => server.calls.filter((call) => call.method === "getUpdates").length === 2);
    controller.abort();
    await loop;

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain("secret user text");
      expect(line).not.toContain(TOKEN);
    }
    expect(lines.some((line) => (JSON.parse(line) as { reason?: string }).reason === "unauthorised")).toBe(true);
  });
});
