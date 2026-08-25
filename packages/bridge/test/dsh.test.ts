import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DshBackend } from "../src/backends/dsh.ts";
import { ApprovalNotPendingError, type PromptContent } from "../src/backends/types.ts";

interface CapturedRequest {
  path: string;
  body: unknown;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function startDshServer(
  requestHandler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{
  baseUrl: string;
  send(path: string, payload: unknown): void;
  disconnect(path: string): void;
  connectionCount(path: string): number;
  connections: string[];
}> {
  const sockets = new Map<string, Set<Duplex>>();
  const connections: string[] = [];
  const server = createServer(requestHandler);
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") return socket.destroy();
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const path = request.url ?? "";
    connections.push(path);
    const pathSockets = sockets.get(path) ?? new Set<Duplex>();
    pathSockets.add(socket);
    sockets.set(path, pathSockets);
    socket.on("data", () => socket.destroy());
    socket.on("close", () => pathSockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve, reject) => {
      for (const pathSockets of sockets.values()) for (const socket of pathSockets) socket.destroy();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("dsh server has no TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    connections,
    connectionCount(path) {
      return sockets.get(path)?.size ?? 0;
    },
    disconnect(path) {
      for (const socket of sockets.get(path) ?? []) socket.destroy();
    },
    send(path, payload) {
      const data = Buffer.from(JSON.stringify(payload));
      const frame = data.length < 126
        ? Buffer.concat([Buffer.from([0x81, data.length]), data])
        : Buffer.concat([Buffer.from([0x81, 126, data.length >> 8, data.length & 0xff]), data]);
      for (const socket of sockets.get(path) ?? []) socket.write(frame);
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}

async function startHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("HTTP server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function respond(response: ServerResponse, rpcId: string, value: unknown): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ type: "server-response", rpcId, result: { ok: true, value } }));
}

describe("DshBackend unary actions", () => {
  it("uses dsh RPC envelopes and maps session results", async () => {
    const requests: CapturedRequest[] = [];
    const baseUrl = await startHttpServer(async (request, response) => {
      const body = await readJson(request);
      requests.push({ path: request.url ?? "", body });
      const envelope = body as { rpcId: string; method: string };
      if (envelope.method === "session.list") {
        respond(response, envelope.rpcId, {
          items: [{ sessionId: "s-1", running: true, blank: false, updatedAt: 1, cwd: "/work" }],
        });
      } else if (envelope.method === "session.create") {
        respond(response, envelope.rpcId, { sessionId: "s-2" });
      } else {
        respond(response, envelope.rpcId, { accepted: true });
      }
    });
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, "project");
    await mkdir(cwd);
    const backend = new DshBackend({ baseUrl, allowedCwdRoots: [root] });

    await expect(backend.listSessions()).resolves.toEqual([
      { sessionId: "s-1", running: true, cwd: "/work" },
    ]);
    await expect(backend.createSession(cwd)).resolves.toBe("s-2");
    await expect(backend.sendPrompt("s-2", [{ type: "text", text: "hello" }])).resolves.toBeUndefined();
    await backend.close();

    expect(requests.map(({ path, body }) => ({ path, method: (body as { method: string }).method }))).toEqual([
      { path: "/api/session.list", method: "session.list" },
      { path: "/api/session.create", method: "session.create" },
      { path: "/api/session.prompt", method: "session.prompt" },
    ]);
    for (const { body } of requests) {
      const envelope = body as Record<string, unknown>;
      expect(envelope.type).toBe("client-request");
      expect(envelope.rpcId).toEqual(expect.any(String));
      expect(envelope.method).toEqual(expect.any(String));
    }
    expect((requests[1]?.body as { payload: unknown }).payload).toEqual({ cwd: await realpath(cwd) });
    expect((requests[2]?.body as { payload: unknown }).payload).toEqual({
      sessionId: "s-2",
      mode: "queue",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("allows a cwd child whose name starts with two dots", async () => {
    const baseUrl = await startHttpServer(async (request, response) => {
      const body = await readJson(request) as { rpcId: string };
      respond(response, body.rpcId, { sessionId: "s-dots" });
    });
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, "..project");
    await mkdir(cwd);
    const backend = new DshBackend({ baseUrl, allowedCwdRoots: [root] });
    await expect(backend.createSession(cwd)).resolves.toBe("s-dots");
    await backend.close();
  });

  it("aborts list and prompt HTTP requests at their configured timeouts", async () => {
    const timeoutMs: number[] = [];
    const controllers: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      timeoutMs.push(milliseconds);
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new Error("missing AbortSignal");
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const backend = new DshBackend({ baseUrl: "http://127.0.0.1:3080", allowedCwdRoots: [root], logger: {} });

    const listing = backend.listSessions();
    expect(timeoutMs).toEqual([10_000]);
    controllers[0]?.abort(new DOMException("timed out", "TimeoutError"));
    await expect(listing).rejects.toThrow("session.list request failed");

    const prompting = backend.sendPrompt("s-1", [{ type: "text", text: "hello" }]);
    expect(timeoutMs).toEqual([10_000, 30_000]);
    controllers[1]?.abort(new DOMException("timed out", "TimeoutError"));
    await expect(prompting).rejects.toThrow("session.prompt request failed");

    const steering = backend.steer("s-1", [{ type: "text", text: "instead do this" }]);
    expect(timeoutMs).toEqual([10_000, 30_000, 30_000]);
    controllers[2]?.abort(new DOMException("timed out", "TimeoutError"));
    await expect(steering).rejects.toThrow("session.prompt request failed");
    await backend.close();
  });

  it("rejects cwd outside allowed real paths and non-directories", async () => {
    const baseUrl = await startHttpServer((_request, response) => response.end());
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    const outside = await mkdtemp(join(tmpdir(), "dsh-outside-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    const outsideProject = join(outside, "project");
    await mkdir(outsideProject);
    const link = join(root, "escape");
    await symlink(outsideProject, link);
    const file = join(root, "file");
    await writeFile(file, "x");
    const backend = new DshBackend({ baseUrl, allowedCwdRoots: [root] });

    await expect(backend.createSession(link)).rejects.toThrow("outside allowed cwd roots");
    await expect(backend.createSession(file)).rejects.toThrow("not a directory");
    await expect(backend.createSession(join(root, "missing"))).rejects.toThrow();
    await backend.close();
  });
});

describe("DshBackend prompt content", () => {
  it("keeps part order and maps queue and steer modes to session.prompt", async () => {
    const requests: CapturedRequest[] = [];
    const baseUrl = await startHttpServer(async (request, response) => {
      const body = await readJson(request);
      requests.push({ path: request.url ?? "", body });
      respond(response, (body as { rpcId: string }).rpcId, { accepted: true });
    });
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const backend = new DshBackend({ baseUrl, allowedCwdRoots: [root] });
    const content: PromptContent = [
      { type: "text", text: "describe both" },
      { type: "image", mediaType: "image/png", data: "aGVsbG8=", name: "shot.png" },
      { type: "image", mediaType: "image/webp", data: "aGk=" },
      { type: "text", text: "in order" },
    ];

    await backend.sendPrompt("s-1", content);
    await backend.steer("s-1", [{ type: "image", mediaType: "image/jpeg", data: "aGk=" }]);
    await backend.close();

    expect(requests.map(({ path }) => path)).toEqual(["/api/session.prompt", "/api/session.prompt"]);
    expect((requests[0]?.body as { payload: unknown }).payload).toEqual({
      sessionId: "s-1",
      mode: "queue",
      content: [
        { type: "text", text: "describe both" },
        { type: "image", mediaType: "image/png", data: "aGVsbG8=", name: "shot.png" },
        { type: "image", mediaType: "image/webp", data: "aGk=" },
        { type: "text", text: "in order" },
      ],
    });
    const queued = (requests[0]?.body as { payload: { content: Array<Record<string, unknown>> } }).payload;
    expect("name" in (queued.content[2] ?? {})).toBe(false);
    expect((requests[1]?.body as { payload: unknown }).payload).toEqual({
      sessionId: "s-1",
      mode: "steer",
      content: [{ type: "image", mediaType: "image/jpeg", data: "aGk=" }],
    });
  });

  it("rejects invalid prompt content before any HTTP request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const backend = new DshBackend({ baseUrl: "http://127.0.0.1:3080", allowedCwdRoots: [root], logger: {} });
    // Content crosses the seam from runtime Telegram data, so the adapter narrows it again.
    const gif = [{ type: "image", mediaType: "image/gif", data: "aGk=" }] as unknown as PromptContent;

    await expect(backend.sendPrompt("s-1", [])).rejects.toThrow("at least one part");
    await expect(backend.sendPrompt("s-1", [{ type: "text", text: "" }])).rejects.toThrow("text part must not be empty");
    await expect(backend.steer("s-1", gif)).rejects.toThrow("Unsupported prompt image media type");
    await expect(backend.sendPrompt("s-1", [{ type: "image", mediaType: "image/png", data: "not base64" }]))
      .rejects.toThrow("must be base64");
    await expect(backend.steer("s-1", [{ type: "image", mediaType: "image/png", data: "aGk=", name: "../escape.png" }]))
      .rejects.toThrow("Unsafe prompt image name");
    await expect(backend.sendPrompt("s-1", [{ type: "image", mediaType: "image/png", data: "aGk=", name: "" }]))
      .rejects.toThrow("Unsafe prompt image name");

    expect(fetchSpy).not.toHaveBeenCalled();
    await backend.close();
  });

  it("rejects a refused prompt and every prompt after close", async () => {
    const baseUrl = await startHttpServer(async (request, response) => {
      const body = await readJson(request) as { rpcId: string };
      respond(response, body.rpcId, { accepted: false });
    });
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const backend = new DshBackend({ baseUrl, allowedCwdRoots: [root] });
    const content: PromptContent = [{ type: "text", text: "hello" }];

    await expect(backend.sendPrompt("s-1", content)).rejects.toThrow("dsh did not accept prompt");
    await expect(backend.steer("s-1", content)).rejects.toThrow("dsh did not accept prompt");
    await backend.close();
    await expect(backend.sendPrompt("s-1", content)).rejects.toThrow("DshBackend is closed");
    await expect(backend.steer("s-1", content)).rejects.toThrow("DshBackend is closed");
  });
});

describe("DshBackend event downlinks", () => {
  it("terminates a prompt accepted before the first chunk when mux disconnects", async () => {
    const server = await startDshServer(async (request, response) => {
      const body = await readJson(request) as { rpcId: string };
      respond(response, body.rpcId, { accepted: true });
    });
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const backend = new DshBackend({ baseUrl: server.baseUrl, allowedCwdRoots: [root], logger: {} });
    const events: Array<{ type: string; sessionId: string }> = [];
    const unsubscribe = backend.subscribe((event) => { events.push(event); });
    await waitFor(() => server.connections.length === 2);
    await backend.sendPrompt("s-active", [{ type: "text", text: "hello" }]);
    server.disconnect("/api/events.mux");
    await waitFor(() => events.some((event) => event.type === "error" && event.sessionId === "s-active"));
    unsubscribe();
    await backend.close();
  });

  it("clears volatile state after the final unsubscribe and starts a fresh subscription", async () => {
    const server = await startDshServer(async (request, response) => {
      const body = await readJson(request) as { rpcId: string; method?: string };
      respond(response, body.rpcId, { items: [{ sessionId: "s-1", running: false, blank: false, updatedAt: 1 }] });
    });
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const backend = new DshBackend({ baseUrl: server.baseUrl, allowedCwdRoots: [root], logger: {} });
    const firstEvents: Array<{ type: string }> = [];
    const unsubscribe = backend.subscribe((event) => { firstEvents.push(event); });
    await waitFor(() => server.connections.length === 2);
    server.send("/api/events.mux", { type: "server-request", rpcId: "rpc-old", payload: { type: "approval/requested", sessionId: "s-1", approvalId: "a-old", toolName: "bash" } });
    server.send("/api/events.mux", { type: "server-event", payload: { type: "session/event", sessionId: "s-1", event: { type: "assistant/message", seq: 1, time: 1, data: { message: { content: [{ type: "text", text: "stale" }] } } } } });
    server.send("/api/events.host", { type: "server-event", payload: { type: "host/session-status", sessionId: "s-1", running: true } });
    await waitFor(() => firstEvents.some((event) => event.type === "approval"));
    unsubscribe();
    await waitFor(() => server.connectionCount("/api/events.mux") === 0);
    await expect(backend.respondApproval("rpc-old", true)).rejects.toThrow("Unknown approval request");

    const freshEvents: Array<{ type: string }> = [];
    const unsubscribeFresh = backend.subscribe((event) => { freshEvents.push(event); });
    await waitFor(() => server.connections.filter((path) => path === "/api/events.mux").length === 2);
    await expect(backend.listSessions()).resolves.toEqual([{ sessionId: "s-1", running: false }]);
    server.disconnect("/api/events.mux");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(freshEvents).toEqual([]);
    unsubscribeFresh();
    await backend.close();
  });

  it("warns for malformed known frames and counts unknown session events", async () => {
    const server = await startDshServer((_request, response) => response.end());
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const warnings: unknown[] = [];
    const debug: unknown[] = [];
    const backend = new DshBackend({
      baseUrl: server.baseUrl,
      allowedCwdRoots: [root],
      logger: {
        warn: (_message, details) => warnings.push(details),
        debug: (_message, details) => debug.push(details),
      },
    });
    const unsubscribe = backend.subscribe(() => undefined);
    await waitFor(() => server.connections.length === 2);
    server.send("/api/events.mux", { type: "server-request", rpcId: "bad", payload: { type: "approval/requested", sessionId: "s-1" } });
    server.send("/api/events.mux", { type: "server-event", payload: { type: "session/event", sessionId: "s-1", event: { type: "assistant/chunk", data: { chunk: { type: "text-delta" } } } } });
    for (const type of ["future/one", "future/two"]) {
      server.send("/api/events.mux", { type: "server-event", payload: { type: "session/event", sessionId: "s-1", event: { type, seq: 1, time: 1, data: {} } } });
    }
    await waitFor(() => warnings.length === 2 && debug.length === 2);
    expect(debug).toEqual([{ type: "future/one", count: 1 }, { type: "future/two", count: 2 }]);
    unsubscribe();
    await backend.close();
  });

  it("bounds a single delta and consecutive coalesced deltas", async () => {
    const server = await startDshServer((_request, response) => response.end());
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const backend = new DshBackend({ baseUrl: server.baseUrl, allowedCwdRoots: [root], logger: {} });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: Array<{ type: string; text?: string }> = [];
    const unsubscribe = backend.subscribe(async (event) => {
      events.push(event);
      if (events.length === 1) await gate;
    });
    await waitFor(() => server.connections.length === 2);
    const send = (seq: number, text: string) => server.send("/api/events.mux", { type: "server-event", payload: { type: "session/event", sessionId: "s-1", event: { type: "assistant/chunk", seq, time: seq, data: { chunk: { type: "text-delta", text, index: 0 } } } } });
    send(1, "a".repeat(9_000));
    send(2, "b".repeat(5_000));
    send(3, "c".repeat(5_000));
    await new Promise((resolve) => setTimeout(resolve, 30));
    release?.();
    await waitFor(() => events.some((event) => event.type === "warning"));
    const outputs = events.filter((event) => event.type === "output");
    expect(outputs.map((event) => event.text?.length)).toEqual([8_192, 8_192]);
    expect(events.filter((event) => event.type === "warning")).toHaveLength(1);
    unsubscribe();
    await backend.close();
  });

  it("reports unsupported questions and missing terminal messages while handler failures do not stop delivery", async () => {
    const server = await startDshServer((_request, response) => response.end());
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const logs: unknown[] = [];
    const backend = new DshBackend({
      baseUrl: server.baseUrl,
      allowedCwdRoots: [root],
      logger: { error: (_message, details) => logs.push(details) },
    });
    const events: Array<{ type: string; sessionId: string; text?: string }> = [];
    let throwOnce = true;
    const unsubscribe = backend.subscribe((event) => {
      events.push(event);
      if (throwOnce) {
        throwOnce = false;
        throw new Error("renderer failed");
      }
    });
    await waitFor(() => server.connections.length === 2);
    server.send("/api/events.mux", {
      type: "server-request",
      rpcId: "question-rpc",
      payload: { type: "question/requested", sessionId: "s-1", questions: [{ question: "Choose" }] },
    });
    server.send("/api/events.mux", {
      type: "server-event",
      payload: { type: "session/event", sessionId: "s-2", event: { type: "turn/end", seq: 1, time: 1, data: {} } },
    });
    server.send("/api/events.mux", { type: "server-event", payload: { type: "unknown/new-event" } });

    await waitFor(() => events.length === 3);
    expect(events).toEqual([
      { type: "error", sessionId: "s-1", message: "Interactive questions are not supported" },
      { type: "error", sessionId: "s-2", message: "Turn ended without an assistant message" },
      { type: "turn-end", sessionId: "s-2", text: "" },
    ]);
    expect(logs).toHaveLength(1);
    unsubscribe();
    await backend.close();
  });

  it("applies host running status to listed sessions", async () => {
    const server = await startDshServer(async (request, response) => {
      const body = await readJson(request) as { rpcId: string };
      respond(response, body.rpcId, { items: [{ sessionId: "s-1", running: false, blank: false, updatedAt: 1 }] });
    });
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const backend = new DshBackend({ baseUrl: server.baseUrl, allowedCwdRoots: [root], logger: {} });
    const unsubscribe = backend.subscribe(() => undefined);
    await waitFor(() => server.connections.length === 2);
    server.send("/api/events.host", {
      type: "server-event",
      payload: { type: "host/session-status", sessionId: "s-1", running: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(backend.listSessions()).resolves.toEqual([{ sessionId: "s-1", running: true }]);
    unsubscribe();
    await backend.close();
  });

  it("stops unsubscribed delivery and close waits for active handlers", async () => {
    const server = await startDshServer((_request, response) => response.end());
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const backend = new DshBackend({ baseUrl: server.baseUrl, allowedCwdRoots: [root], logger: {} });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: unknown[] = [];
    const unsubscribe = backend.subscribe(async (event) => {
      events.push(event);
      await gate;
    });
    await waitFor(() => server.connections.length === 2);
    for (let index = 0; index < 2; index += 1) {
      server.send("/api/events.mux", {
        type: "server-event",
        payload: { type: "session/event", sessionId: "s-1", event: { type: "assistant/chunk", seq: index, time: index, data: { chunk: { type: "text-delta", text: String(index), index: 0 } } } },
      });
    }
    await waitFor(() => events.length === 1);
    unsubscribe();
    let closed = false;
    const closing = backend.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    release?.();
    await closing;
    expect(events).toHaveLength(1);
  });

  it("removes approvals resolved by another client", async () => {
    const server = await startDshServer((_request, response) => response.end());
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const backend = new DshBackend({ baseUrl: server.baseUrl, allowedCwdRoots: [root], logger: {} });
    const unsubscribe = backend.subscribe(() => undefined);
    await waitFor(() => server.connections.length === 2);
    server.send("/api/events.mux", {
      type: "server-request",
      rpcId: "rpc-other",
      payload: { type: "approval/requested", sessionId: "s-1", approvalId: "a-other", toolName: "bash" },
    });
    server.send("/api/events.mux", {
      type: "server-event",
      payload: { type: "approval/resolved", sessionId: "s-1", approvalId: "a-other", outcome: "rejected" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(backend.respondApproval("rpc-other", true)).rejects.toThrow("Unknown approval request");
    unsubscribe();
    await backend.close();
  });

  it("reconnects unexpected disconnects, invalidates approvals, and stops after unsubscribe or close", async () => {
    const server = await startDshServer((_request, response) => response.end());
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const backend = new DshBackend({ baseUrl: server.baseUrl, allowedCwdRoots: [root], logger: {} });
    const events: Array<{ type: string; sessionId: string }> = [];
    const unsubscribe = backend.subscribe((event) => { events.push(event); });
    await waitFor(() => server.connections.length === 2);
    server.send("/api/events.mux", {
      type: "server-request",
      rpcId: "rpc-stale",
      payload: { type: "approval/requested", sessionId: "s-1", approvalId: "a-1", toolName: "bash" },
    });
    await waitFor(() => events.some((event) => event.type === "approval"));
    server.disconnect("/api/events.mux");

    await waitFor(() => events.some((event) => event.type === "error" && event.sessionId === "s-1"));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(server.connections.filter((path) => path === "/api/events.mux").length).toBeGreaterThanOrEqual(2);
    await expect(backend.respondApproval("rpc-stale", true)).rejects.toThrow("Unknown approval request");

    unsubscribe();
    await waitFor(() => server.connectionCount("/api/events.mux") === 0 && server.connectionCount("/api/events.host") === 0);
    const connectionTotal = server.connections.length;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(server.connections).toHaveLength(connectionTotal);
    await backend.close();
    expect(() => backend.subscribe(() => undefined)).toThrow("closed");
  }, 10_000);

  it("collapses more than 64 distinct approvals into a terminal overload error within the fixed queue", async () => {
    const server = await startDshServer((_request, response) => response.end());
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const backend = new DshBackend({ baseUrl: server.baseUrl, allowedCwdRoots: [root], logger: {} });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: Array<{ type: string; sessionId: string; message?: string; requestId?: string }> = [];
    const peerEvents: Array<{ type: string; message?: string }> = [];
    const unsubscribe = backend.subscribe(async (event) => {
      events.push(event);
      if (events.length === 1) await gate;
    });
    const unsubscribePeer = backend.subscribe((event) => { peerEvents.push(event); });
    await waitFor(() => server.connections.length === 2);

    for (let index = 0; index < 70; index += 1) {
      server.send("/api/events.mux", {
        type: "server-request",
        rpcId: `rpc-${index}`,
        payload: { type: "approval/requested", sessionId: "s-1", approvalId: `a-${index}`, toolName: "bash" },
      });
    }
    server.send("/api/events.mux", {
      type: "server-event",
      payload: { type: "session/event", sessionId: "s-1", event: { type: "turn/end", seq: 71, time: 71, data: {} } },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    release?.();
    await waitFor(() => events.some((event) => event.type === "turn-end"));

    expect(events.length).toBeLessThanOrEqual(65);
    const overloadIndex = events.findIndex((event) => event.type === "error" && event.message?.includes("approval overload"));
    const turnEndIndex = events.findIndex((event) => event.type === "turn-end");
    expect(overloadIndex).toBeGreaterThanOrEqual(0);
    expect(turnEndIndex).toBeGreaterThan(overloadIndex);
    await waitFor(() => peerEvents.some((event) => event.type === "turn-end"));
    const peerOverloadIndex = peerEvents.findIndex((event) => event.type === "error" && event.message?.includes("approval overload"));
    expect(peerOverloadIndex).toBeGreaterThanOrEqual(0);
    expect(peerEvents.findIndex((event) => event.type === "turn-end")).toBeGreaterThan(peerOverloadIndex);
    await expect(backend.respondApproval("rpc-69", true)).rejects.toThrow("Unknown approval request");
    server.send("/api/events.mux", {
      type: "server-request",
      rpcId: "rpc-next-turn",
      payload: { type: "approval/requested", sessionId: "s-1", approvalId: "a-next", toolName: "bash" },
    });
    await waitFor(() => events.some((event) => event.type === "approval" && event.requestId === "rpc-next-turn"));
    unsubscribe();
    unsubscribePeer();
    await backend.close();
  });

  it("keeps overflow reported after an error and resets it only after turn-end", async () => {
    const server = await startDshServer((_request, response) => response.end());
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const backend = new DshBackend({ baseUrl: server.baseUrl, allowedCwdRoots: [root], logger: {} });
    let release: (() => void) | undefined;
    let gate = new Promise<void>((resolve) => { release = resolve; });
    let blockNext = true;
    const events: Array<{ type: string }> = [];
    const unsubscribe = backend.subscribe(async (event) => {
      events.push(event);
      if (blockNext) {
        blockNext = false;
        await gate;
      }
    });
    await waitFor(() => server.connections.length === 2);
    const sendDelta = (seq: number) => server.send("/api/events.mux", {
      type: "server-event",
      payload: { type: "session/event", sessionId: "s-1", event: { type: "assistant/chunk", seq, time: seq, data: { chunk: { type: seq % 2 === 0 ? "text-delta" : "reasoning-delta", text: "x", index: 0 } } } },
    });
    const flood = (start: number) => { for (let index = start; index < start + 70; index += 1) sendDelta(index); };

    flood(0);
    server.send("/api/events.host", { type: "server-event", payload: { type: "host/agent-error", sessionId: "s-1", message: "failed" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    release?.();
    await waitFor(() => events.some((event) => event.type === "error"));
    expect(events.filter((event) => event.type === "warning")).toHaveLength(1);

    blockNext = true;
    gate = new Promise<void>((resolve) => { release = resolve; });
    sendDelta(100);
    await new Promise((resolve) => setTimeout(resolve, 20));
    flood(101);
    await new Promise((resolve) => setTimeout(resolve, 30));
    release?.();
    await waitFor(() => events.length >= 70);
    expect(events.filter((event) => event.type === "warning")).toHaveLength(1);

    server.send("/api/events.mux", { type: "server-event", payload: { type: "session/event", sessionId: "s-1", event: { type: "turn/end", seq: 200, time: 200, data: {} } } });
    await waitFor(() => events.some((event) => event.type === "turn-end"));
    blockNext = true;
    gate = new Promise<void>((resolve) => { release = resolve; });
    sendDelta(300);
    await new Promise((resolve) => setTimeout(resolve, 20));
    flood(301);
    await new Promise((resolve) => setTimeout(resolve, 30));
    release?.();
    await waitFor(() => events.filter((event) => event.type === "warning").length === 2);
    unsubscribe();
    await backend.close();
  });

  it("keeps complete assistant text isolated across sequential turns", async () => {
    const server = await startDshServer((_request, response) => response.end());
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const backend = new DshBackend({ baseUrl: server.baseUrl, allowedCwdRoots: [root], logger: {} });
    const turnEnds: Array<{ type: string; text?: string }> = [];
    const unsubscribe = backend.subscribe((event) => { if (event.type === "turn-end") turnEnds.push(event); });
    await waitFor(() => server.connections.length === 2);
    for (const [seq, text] of [[1, "first"], [3, "second"]] as const) {
      server.send("/api/events.mux", { type: "server-event", payload: { type: "session/event", sessionId: "s-1", event: { type: "assistant/message", seq, time: seq, data: { message: { content: [{ type: "text", text }] } } } } });
      server.send("/api/events.mux", { type: "server-event", payload: { type: "session/event", sessionId: "s-1", event: { type: "turn/end", seq: seq + 1, time: seq + 1, data: {} } } });
    }
    await waitFor(() => turnEnds.length === 2);
    expect(turnEnds.map((event) => event.text)).toEqual(["first", "second"]);
    unsubscribe();
    await backend.close();
  });

  it("bounds queues per subscriber and session while preserving terminal events", async () => {
    const server = await startDshServer((_request, response) => response.end());
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const backend = new DshBackend({ baseUrl: server.baseUrl, allowedCwdRoots: [root], logger: {} });
    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const slowEvents: Array<{ type: string; sessionId: string; text?: string }> = [];
    const fastEvents: Array<{ type: string; sessionId: string }> = [];
    const unsubscribeSlow = backend.subscribe(async (event) => {
      slowEvents.push(event);
      if (event.sessionId === "s-1" && slowEvents.length === 1) await slowGate;
    });
    const unsubscribeFast = backend.subscribe((event) => { fastEvents.push(event); });
    await waitFor(() => server.connections.length === 2);

    for (let index = 0; index < 70; index += 1) {
      server.send("/api/events.mux", {
        type: "server-event",
        payload: { type: "session/event", sessionId: "s-1", event: { type: "assistant/chunk", seq: index, time: index, data: { chunk: { type: index % 2 === 0 ? "text-delta" : "reasoning-delta", text: String(index), index: 0 } } } },
      });
    }
    server.send("/api/events.mux", {
      type: "server-event",
      payload: { type: "session/event", sessionId: "s-2", event: { type: "assistant/chunk", seq: 1, time: 1, data: { chunk: { type: "text-delta", text: "other", index: 0 } } } },
    });
    server.send("/api/events.mux", {
      type: "server-event",
      payload: { type: "session/event", sessionId: "s-1", event: { type: "turn/end", seq: 71, time: 71, data: {} } },
    });

    await waitFor(() => fastEvents.some((event) => event.type === "turn-end"));
    await waitFor(() => slowEvents.some((event) => event.sessionId === "s-2"));
    releaseSlow?.();
    await waitFor(() => slowEvents.some((event) => event.type === "turn-end"));
    expect(slowEvents.filter((event) => event.type === "warning")).toHaveLength(1);
    expect(slowEvents.some((event) => event.type === "turn-end" && event.sessionId === "s-1")).toBe(true);
    expect(fastEvents.filter((event) => event.type === "warning")).toHaveLength(1);
    unsubscribeSlow();
    unsubscribeFast();
    await backend.close();
  });

  it("responds to approvals through /api/respond and treats a lost race as completion", async () => {
    const requests: CapturedRequest[] = [];
    const server = await startDshServer(async (request, response) => {
      const body = await readJson(request);
      requests.push({ path: request.url ?? "", body });
      response.setHeader("content-type", "application/json");
      const envelope = body as { rpcId: string };
      response.end(JSON.stringify(envelope.rpcId === "rpc-race"
        ? { accepted: false, reason: "not-pending" }
        : { accepted: true }));
    });
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const backend = new DshBackend({ baseUrl: server.baseUrl, allowedCwdRoots: [root], logger: {} });
    const unsubscribe = backend.subscribe(() => undefined);
    await waitFor(() => server.connections.length === 2);
    server.send("/api/events.mux", {
      type: "server-request",
      rpcId: "rpc-approval",
      payload: { type: "approval/requested", sessionId: "s-1", approvalId: "a-1", toolName: "bash" },
    });
    server.send("/api/events.mux", {
      type: "server-request",
      rpcId: "rpc-race",
      payload: { type: "approval/requested", sessionId: "s-1", approvalId: "a-race", toolName: "bash" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(backend.respondApproval("rpc-approval", true)).resolves.toBeUndefined();
    await expect(backend.respondApproval("rpc-race", false)).resolves.toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({
      path: "/api/respond",
      body: {
        type: "client-response",
        rpcId: "rpc-approval",
        result: { ok: true, value: { sessionId: "s-1", approvalId: "a-1", outcome: "allowed-once" } },
      },
    });
    await expect(backend.respondApproval("missing", false)).rejects.toThrow("Unknown approval request");
    // The platform layer selects on the type; it never reads this message.
    await expect(backend.respondApproval("missing", false)).rejects.toBeInstanceOf(ApprovalNotPendingError);
    unsubscribe();
    await backend.close();
  });

  it("opens mux and host downlinks and maps turn, approval, and host errors", async () => {
    const server = await startDshServer((_request, response) => response.end());
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const backend = new DshBackend({ baseUrl: server.baseUrl, allowedCwdRoots: [root], logger: {} });
    const events: unknown[] = [];
    const unsubscribe = backend.subscribe((event) => { events.push(event); });
    await waitFor(() => server.connections.length === 2);

    expect(server.connections.sort()).toEqual(["/api/events.host", "/api/events.mux"]);
    server.send("/api/events.mux", {
      type: "server-event",
      payload: { type: "session/event", sessionId: "s-1", event: { type: "assistant/chunk", seq: 1, time: 1, data: { chunk: { type: "text-delta", text: "hel", index: 0 } } } },
    });
    server.send("/api/events.mux", {
      type: "server-event",
      payload: { type: "session/event", sessionId: "s-1", event: { type: "assistant/chunk", seq: 2, time: 2, data: { chunk: { type: "reasoning-delta", text: "why", index: 0 } } } },
    });
    server.send("/api/events.mux", {
      type: "server-event",
      payload: { type: "session/event", sessionId: "s-1", event: { type: "assistant/message", seq: 3, time: 3, data: { message: { content: [{ type: "text", text: "hello" }] } } } },
    });
    server.send("/api/events.mux", {
      type: "server-event",
      payload: { type: "session/event", sessionId: "s-1", event: { type: "turn/end", seq: 4, time: 4, data: { reason: "stop", turn: 1 } } },
    });
    server.send("/api/events.mux", {
      type: "server-request",
      rpcId: "rpc-approval",
      payload: { type: "approval/requested", sessionId: "s-1", approvalId: "a-1", toolName: "bash", reason: "run command" },
    });
    server.send("/api/events.host", {
      type: "server-event",
      payload: { type: "host/agent-error", sessionId: "s-2", message: "model failed" },
    });

    await waitFor(() => events.length === 5);
    expect(events).toEqual([
      { type: "output", sessionId: "s-1", text: "hel" },
      { type: "thinking", sessionId: "s-1", text: "why" },
      { type: "turn-end", sessionId: "s-1", text: "hello" },
      { type: "approval", sessionId: "s-1", requestId: "rpc-approval", prompt: "bash: run command" },
      { type: "error", sessionId: "s-2", message: "model failed" },
    ]);
    unsubscribe();
    await backend.close();
  });
});
