import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/log.ts";

function capture(level: "info" | "debug"): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  const logger = createLogger({
    level,
    write: (line) => lines.push(line),
    now: () => new Date("2026-08-25T10:00:00.000Z"),
  });
  return { lines, logger };
}

describe("createLogger", () => {
  it("writes one JSON Lines record per call", () => {
    const { lines, logger } = capture("info");
    logger.info("telegram.poll.started", { method: "getUpdates" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      time: "2026-08-25T10:00:00.000Z",
      level: "info",
      event: "telegram.poll.started",
      method: "getUpdates",
    });
  });

  it("drops debug records at info level and keeps them at debug level", () => {
    const quiet = capture("info");
    quiet.logger.debug("telegram.request", { method: "getMe" });
    quiet.logger.error("telegram.request.failed", { errorCode: 401 });
    expect(quiet.lines.map((line) => JSON.parse(line).level)).toEqual(["error"]);

    const verbose = capture("debug");
    verbose.logger.debug("telegram.request", { method: "getMe" });
    verbose.logger.info("telegram.poll.started", {});
    expect(verbose.lines.map((line) => JSON.parse(line).level)).toEqual(["debug", "info"]);
  });

  it("bounds string fields so a summary cannot smuggle a payload into the log", () => {
    const { lines, logger } = capture("info");
    logger.error("telegram.request.failed", { errorSummary: "x".repeat(500) });
    const record = JSON.parse(lines[0] ?? "") as { errorSummary: string };
    expect(record.errorSummary).toHaveLength(200);
  });

  it("omits undefined fields", () => {
    const { lines, logger } = capture("info");
    logger.info("telegram.identity", { botId: 7, method: undefined });
    expect(Object.keys(JSON.parse(lines[0] ?? ""))).toEqual(["time", "level", "event", "botId"]);
  });

  it("writes to stdout by default", () => {
    const written: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    createLogger({ level: "info" }).info("bridge.started", {});
    write.mockRestore();
    expect(written).toHaveLength(1);
    expect(written[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(written[0] ?? "")).toMatchObject({ level: "info", event: "bridge.started" });
  });
});
