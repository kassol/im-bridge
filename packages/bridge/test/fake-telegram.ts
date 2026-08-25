/**
 * Fake Bot API server.
 *
 * The Telegram adapter takes a base URL, so tests point it here and assert on
 * the real HTTP envelope instead of a mocked fetch.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface FakeCall {
  readonly path: string;
  readonly method: string;
  readonly contentType: string | undefined;
  readonly body: Record<string, unknown>;
  readonly count: number;
}

export interface FakeReply {
  /** Defaults to 200. */
  status?: number;
  /** Response body. Omit together with `raw` for `{ ok: true, result: true }`. */
  json?: unknown;
  /** Sent verbatim, for malformed-body cases. */
  raw?: string;
  /** Never answer, so the client hits its own timeout. */
  hang?: true;
  /** Drop the connection with no response, as `api.telegram.org` does. */
  destroy?: true;
  /** A complete file body, sent with its real Content-Length. */
  bytes?: Uint8Array;
  /** A file body written chunk by chunk, so a client can stop mid-body. */
  stream?: FakeStream;
}

/**
 * A file body the client has to read to the end to receive whole.
 *
 * `contentLength` is omitted by default, which makes Node use chunked transfer
 * encoding and advertise no length at all — the case a client must survive
 * without trusting a header. `onWrote` reports how much actually reached the
 * socket, so a test can prove the client stopped reading early.
 */
export interface FakeStream {
  readonly chunks: readonly Uint8Array[];
  readonly contentLength?: number;
  readonly onWrote?: (written: number) => void;
}

export interface FakeTelegram {
  readonly baseUrl: string;
  readonly calls: FakeCall[];
  methods(): string[];
  close(): Promise<void>;
}

/**
 * Writes a body one chunk at a time, honouring backpressure so the socket
 * carries the chunks separately, and stops as soon as the client goes away.
 */
async function writeStream(response: ServerResponse, stream: FakeStream, status: number): Promise<void> {
  // A client that aborts mid-body makes the socket emit an error; it is the
  // expected end of this response, not a test failure.
  response.on("error", () => void 0);
  response.statusCode = status;
  response.setHeader("content-type", "application/octet-stream");
  if (stream.contentLength !== undefined) response.setHeader("content-length", String(stream.contentLength));
  let written = 0;
  for (const chunk of stream.chunks) {
    if (response.destroyed || response.writableEnded) break;
    const flushed = response.write(Buffer.from(chunk));
    written += 1;
    stream.onWrote?.(written);
    if (!flushed) await drained(response);
  }
  if (!response.destroyed && !response.writableEnded) response.end();
}

/** Resolves when the socket accepts more, or when it is gone. */
function drained(response: ServerResponse): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      response.off("drain", done);
      response.off("close", done);
      response.off("error", done);
      resolve();
    };
    response.once("drain", done);
    response.once("close", done);
    response.once("error", done);
  });
}

export async function startFakeTelegram(
  handle: (call: FakeCall) => FakeReply | Promise<FakeReply>,
): Promise<FakeTelegram> {
  const calls: FakeCall[] = [];
  const counts = new Map<string, number>();
  const open = new Set<ServerResponse>();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const path = request.url ?? "";
      const method = path.slice(path.lastIndexOf("/") + 1);
      const count = (counts.get(method) ?? 0) + 1;
      counts.set(method, count);
      const text = Buffer.concat(chunks).toString("utf8");
      const call: FakeCall = {
        path,
        method,
        contentType: request.headers["content-type"],
        body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
        count,
      };
      calls.push(call);
      const reply = await handle(call);
      if (reply.hang === true) {
        open.add(response);
        return;
      }
      if (reply.destroy === true) {
        response.destroy();
        return;
      }
      if (reply.bytes !== undefined) {
        response.statusCode = reply.status ?? 200;
        response.setHeader("content-type", "application/octet-stream");
        response.end(Buffer.from(reply.bytes));
        return;
      }
      if (reply.stream !== undefined) {
        await writeStream(response, reply.stream, reply.status ?? 200);
        return;
      }
      response.statusCode = reply.status ?? 200;
      response.setHeader("content-type", "application/json");
      response.end(reply.raw ?? JSON.stringify(reply.json ?? { ok: true, result: true }));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake Telegram has no TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    methods: () => calls.map((call) => call.method),
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const response of open) response.destroy();
        // An aborted download leaves its socket behind, and `close` waits for
        // every one of them; the test is over, so they go now.
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
