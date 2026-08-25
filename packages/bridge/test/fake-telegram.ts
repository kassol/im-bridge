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
}

export interface FakeTelegram {
  readonly baseUrl: string;
  readonly calls: FakeCall[];
  methods(): string[];
  close(): Promise<void>;
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
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
