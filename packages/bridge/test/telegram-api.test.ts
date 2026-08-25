import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, type Logger } from "../src/log.ts";
import { TelegramApi, TelegramApiError } from "../src/telegram/api.ts";
import { startFakeTelegram, type FakeReply, type FakeTelegram } from "./fake-telegram.ts";

const TOKEN = "8123456789:AAF-abcdefghijklmnopqrstuvwxyz012345678";

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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}

function capturedLogger(lines: string[]): Logger {
  return createLogger({ level: "debug", write: (line) => lines.push(line) });
}

function apiFor(server: FakeTelegram, extra: { logger?: Logger; slept?: number[] } = {}): TelegramApi {
  return new TelegramApi({
    token: TOKEN,
    baseUrl: server.baseUrl,
    logger: extra.logger,
    sleep: async (ms) => {
      extra.slept?.push(ms);
    },
  });
}

const IDENTITY = { ok: true, result: { id: 42, username: "im_bridge_bot", has_topics_enabled: true } };

describe("TelegramApi transport", () => {
  it("posts JSON to the token path and returns the bot identity", async () => {
    const server = await fake(() => ({ json: IDENTITY }));
    await expect(apiFor(server).getMe()).resolves.toEqual({ id: 42, username: "im_bridge_bot" });
    expect(server.calls[0]).toMatchObject({
      path: `/bot${TOKEN}/getMe`,
      method: "getMe",
      contentType: "application/json",
      body: {},
    });
  });

  it("refuses a bot whose threaded mode is off", async () => {
    const server = await fake(() => ({ json: { ok: true, result: { id: 42, username: "b", has_topics_enabled: false } } }));
    await expect(apiFor(server).getMe()).rejects.toThrow(/[Tt]hreaded mode/);
    expect(server.methods()).toEqual(["getMe"]);
  });

  it("reports an invalid token as a bounded API error", async () => {
    const server = await fake(() => ({
      status: 401,
      json: { ok: false, error_code: 401, description: "Unauthorized" },
    }));
    const failure = await apiFor(server).getMe().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TelegramApiError);
    const error = failure as TelegramApiError;
    expect(error.errorCode).toBe(401);
    expect(error.description).toBe("Unauthorized");
    expect(error.message).not.toContain(TOKEN);
    // Deterministic rejection: retrying an invalid token only repeats it.
    expect(server.methods()).toEqual(["getMe"]);
  });

  it("long polls with a 50 second server timeout and a 60 second client timeout", async () => {
    const timeouts: number[] = [];
    const controllers: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      timeouts.push(ms);
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    });
    const server = await fake((call) => (call.count === 1 ? { json: { ok: true, result: [] } } : { hang: true }));
    const api = apiFor(server);

    await expect(api.getUpdates({ offset: 7 })).resolves.toEqual([]);
    expect(server.calls[0]?.body).toEqual({ timeout: 50, offset: 7, allowed_updates: ["message", "callback_query"] });
    expect(timeouts).toEqual([60_000]);

    const pending = api.getUpdates({});
    controllers[1]?.abort(new DOMException("timed out", "TimeoutError"));
    await expect(pending).rejects.toThrow(TelegramApiError);
  });

  it("retries an idempotent read three times with exponential backoff", async () => {
    const slept: number[] = [];
    const server = await fake((call) => (call.count < 4 ? { status: 500, json: { ok: false } } : { json: IDENTITY }));
    await expect(apiFor(server, { slept }).getMe()).resolves.toMatchObject({ id: 42 });
    expect(slept).toEqual([1_000, 2_000, 4_000]);

    const failing = await fake(() => ({ status: 500, json: { ok: false, description: "Internal Server Error" } }));
    const exhausted: number[] = [];
    await expect(apiFor(failing, { slept: exhausted }).getMe()).rejects.toThrow(TelegramApiError);
    expect(failing.calls).toHaveLength(4);
    expect(exhausted).toEqual([1_000, 2_000, 4_000]);
  });

  it("waits the complete retry_after on 429", async () => {
    const slept: number[] = [];
    const server = await fake((call) =>
      call.count === 1
        ? { status: 429, json: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 14 } } }
        : { json: IDENTITY },
    );
    await expect(apiFor(server, { slept }).getMe()).resolves.toMatchObject({ id: 42 });
    expect(slept).toEqual([14_000]);
  });

  it("retries a final send only when Telegram proves it was not delivered", async () => {
    const rejected: number[] = [];
    const throttled = await fake((call) =>
      call.count === 1
        ? { status: 429, json: { ok: false, error_code: 429, parameters: { retry_after: 3 } } }
        : { json: { ok: true, result: { message_id: 900 } } },
    );
    await expect(
      apiFor(throttled, { slept: rejected }).sendMessage({ chatId: 5, text: "hi" }),
    ).resolves.toBe(900);
    expect(rejected).toEqual([3_000]);
    expect(throttled.calls[1]?.body).toEqual({ chat_id: 5, text: "hi" });

    // A 5xx may mean Telegram accepted the send and lost the response.
    const ambiguous = await fake(() => ({ status: 502, json: { ok: false, description: "Bad Gateway" } }));
    const slept: number[] = [];
    await expect(apiFor(ambiguous, { slept }).sendMessage({ chatId: 5, threadId: 9, text: "hi" })).rejects.toThrow(
      TelegramApiError,
    );
    expect(ambiguous.calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it("classifies a lost connection as retryable for reads and final for sends", async () => {
    const server = await fake(() => ({ json: IDENTITY }));
    await server.close();
    cleanups.splice(0);
    const slept: number[] = [];
    const api = apiFor(server, { slept });
    await expect(api.getMe()).rejects.toThrow(TelegramApiError);
    expect(slept).toEqual([1_000, 2_000, 4_000]);
    slept.length = 0;
    await expect(api.sendMessage({ chatId: 1, text: "x" })).rejects.toThrow(TelegramApiError);
    expect(slept).toEqual([]);
  });

  it("keeps the token out of errors even when Telegram echoes it", async () => {
    const server = await fake(() => ({
      status: 400,
      json: { ok: false, error_code: 400, description: `Bad Request: bot${TOKEN} is wrong` },
    }));
    const error = (await apiFor(server).getMe().catch((failure: unknown) => failure)) as TelegramApiError;
    expect(error.description).not.toContain(TOKEN);
    expect(error.description).toContain("<redacted>");
    expect(error.message).not.toContain(TOKEN);
  });

  it("bounds an error description", async () => {
    const server = await fake(() => ({ status: 400, json: { ok: false, error_code: 400, description: "d".repeat(900) } }));
    const error = (await apiFor(server).getMe().catch((failure: unknown) => failure)) as TelegramApiError;
    expect(error.description).toHaveLength(200);
  });

  it("rejects a malformed body as a transient failure", async () => {
    const server = await fake((call) => (call.count < 3 ? { raw: "<html>502</html>" } : { json: IDENTITY }));
    const slept: number[] = [];
    await expect(apiFor(server, { slept }).getMe()).resolves.toMatchObject({ id: 42 });
    expect(slept).toEqual([1_000, 2_000]);
  });

  it("logs only bounded fields and never the token or message text", async () => {
    const lines: string[] = [];
    const server = await fake((call) => {
      if (call.method === "getMe") return { json: IDENTITY };
      if (call.count === 1) {
        return { status: 429, json: { ok: false, error_code: 429, parameters: { retry_after: 2 } } };
      }
      return { json: { ok: true, result: { message_id: 12 } } };
    });
    const api = apiFor(server, { logger: capturedLogger(lines), slept: [] });
    await api.getMe();
    await api.sendMessage({ chatId: 5, threadId: 9, text: "secret user text" });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain("secret user text");
      for (const key of Object.keys(JSON.parse(line) as Record<string, unknown>)) {
        expect([
          "time", "level", "event", "method", "retryClass", "attempt", "delayMs", "durationMs",
          "errorCode", "errorSummary", "reason", "updateId", "chatId", "threadId", "userId",
          "messageId", "sessionId", "botId", "count",
        ]).toContain(key);
      }
    }
  });

  it("stops a call when the caller aborts", async () => {
    const server = await fake(() => ({ hang: true }));
    const controller = new AbortController();
    const pending = apiFor(server).getUpdates({ signal: controller.signal });
    await waitFor(() => server.calls.length === 1);
    controller.abort(new Error("shutting down"));
    await expect(pending).rejects.toThrow("shutting down");
    expect(server.calls).toHaveLength(1);
  });
});

describe("menu methods", () => {
  it("sends an inline keyboard in Telegram's field names", async () => {
    const server = await fake(() => ({ json: { ok: true, result: { message_id: 900 } } }));
    await apiFor(server).sendMessage({
      chatId: 5000,
      threadId: 31,
      text: "菜单",
      replyMarkup: [[{ text: "关闭", callbackData: "epoch1:x:" }]],
    });
    expect(server.calls[0]?.body).toEqual({
      chat_id: 5000,
      message_thread_id: 31,
      text: "菜单",
      reply_markup: { inline_keyboard: [[{ text: "关闭", callback_data: "epoch1:x:" }]] },
    });
  });

  it("treats an edit Telegram calls unmodified as already applied", async () => {
    const server = await fake(() => ({
      status: 400,
      json: { ok: false, error_code: 400, description: "Bad Request: message is not modified" },
    }));
    const api = apiFor(server);
    await expect(
      api.editMessageText({ chatId: 5000, messageId: 900, text: "菜单", replyMarkup: [] }),
    ).resolves.toBeUndefined();
    await expect(api.editMessageReplyMarkup({ chatId: 5000, messageId: 900 })).resolves.toBeUndefined();
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]?.body).toEqual({ chat_id: 5000, message_id: 900 });
  });

  it("reports any other edit failure", async () => {
    const server = await fake(() => ({
      status: 400,
      json: { ok: false, error_code: 400, description: "Bad Request: message to edit not found" },
    }));
    await expect(
      apiFor(server).editMessageText({ chatId: 5000, messageId: 900, text: "菜单" }),
    ).rejects.toBeInstanceOf(TelegramApiError);
  });

  it("answers a callback query with an alert", async () => {
    const server = await fake(() => ({ json: { ok: true, result: true } }));
    await apiFor(server).answerCallbackQuery({ callbackId: "cb-1", text: "已解除绑定", showAlert: true });
    expect(server.calls[0]?.body).toEqual({
      callback_query_id: "cb-1",
      text: "已解除绑定",
      show_alert: true,
    });
  });
});
