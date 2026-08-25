/**
 * Entry point.
 *
 * The LaunchAgent passes one argument: the path of the configuration file.
 * Startup validates that file, proves the bot can work in topics, and then
 * polls Telegram. Every accepted update goes to the runtime, which owns the
 * menus and the links.
 *
 * Further arguments run one local command against the same configuration and
 * exit instead of polling. They exist for the setup wizard, which must not
 * re-implement configuration validation or Bot API calls in bash:
 *
 *   dead-letters list        what the bridge gave up on; no token, no backend
 *   config check             load the configuration and report it usable
 *   topic detect             wait for a message in a private topic, print its ids
 *   probe --thread <id>      prove Rich Message drafts and final sends work
 *
 * Every command prints JSON Lines through the same logger the service uses, so
 * the field whitelist that keeps tokens and user content out of the log keeps
 * them out of the wizard's terminal too.
 *
 * The commands are exported and take the Bot API base URL, so the tests drive
 * them against the fake Bot API instead of a spawned process. The service only
 * starts when this file is the entry point of the process.
 */
import { realpathSync } from "node:fs";
import { DshBackend } from "./backends/dsh.ts";
import { loadConfig, type BridgeConfig } from "./config.ts";
import { createLogger, type Logger } from "./log.ts";
import { BridgeRuntime } from "./runtime/runtime.ts";
import { Store } from "./store/store.ts";
import { Allowlist } from "./telegram/allowlist.ts";
import { TelegramApi } from "./telegram/api.ts";
import { classifyUpdate, runUpdateLoop } from "./telegram/updates.ts";

const USAGE = "Usage: <config.json> [dead-letters list | config check | topic detect | probe --thread <id>]";

/** How long `topic detect` waits for the human to post in the new topic. */
const DETECT_TIMEOUT_MS = 180_000;

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (configPath === undefined) {
    throw new Error("Usage: node --experimental-strip-types src/index.ts <config.json>");
  }
  const config = await loadConfig(configPath);
  const command = process.argv.slice(3);
  if (command.length > 0) {
    await runCommand(command, config);
    return;
  }
  await runService(config);
}

async function runService(config: BridgeConfig): Promise<void> {
  const logger = createLogger({ level: config.logLevel });
  const allowlist = new Allowlist(config.allowedUserIds);
  const api = new TelegramApi({ token: config.botToken, logger });

  // Fails on an invalid token and on a bot whose threaded mode is off, before
  // any update is accepted.
  const identity = await api.getMe();
  const store = new Store(config.databasePath);
  // A session may only be created inside a configured cwd root, so the root
  // map is also the backend's allowed cwd roots.
  const backend = new DshBackend({
    baseUrl: config.dshUrl,
    allowedCwdRoots: [...config.cwdRoots.values()],
  });
  logger.info("bridge.started", { botId: identity.id, count: allowlist.size });

  const polling = new AbortController();
  const runtime = new BridgeRuntime({
    api,
    backend,
    store,
    allowlist,
    cwdRoots: config.cwdRoots,
    logger,
    polling,
  });

  // Whatever the last run left mid-flight is isolated and reported before a
  // new update is accepted, so recovery cannot race the work it is recovering.
  await runtime.recover();

  // Subscribing before polling means a turn already running in dsh's own Web UI
  // renders from its next event, not from the next Telegram message.
  await runtime.start();

  // Registered only now: a signal during recovery finds nothing to drain, and
  // the default termination leaves every record open for the next start.
  let stopping = false;
  const stop = (reason: string) => (): void => {
    if (stopping) {
      // A second signal while the first one is still draining. Exiting leaves
      // every unfinished processing record open, which is exactly what startup
      // recovery reads, so it is safe to be abrupt.
      logger.error("bridge.shutdown.forced", { reason });
      process.exit(1);
    }
    stopping = true;
    void runtime.shutdown({ reason });
  };
  process.on("SIGTERM", stop("SIGTERM"));
  process.on("SIGINT", stop("SIGINT"));

  try {
    await runUpdateLoop({
      api,
      allowlist,
      checkpoint: store,
      logger,
      signal: polling.signal,
      onUpdate: (update) => runtime.handleUpdate(update),
    });
  } catch (error) {
    // The loop settles its own drops against the Store. A shutdown that passed
    // its deadline closes that Store underneath it, so this failure is the
    // expected end of a drain that timed out, not a lost update: nothing the
    // loop had left to settle was durable.
    if (!stopping) throw error;
    logger.error("bridge.poll.aborted", {
      errorSummary: error instanceof Error ? error.name : undefined,
    });
  }
  await runtime.shutdown({ reason: stopping ? "signal" : "loop-ended" });
  logger.info("bridge.stopped");
}

async function runCommand(command: readonly string[], config: BridgeConfig): Promise<void> {
  if (command[0] === "dead-letters" && command[1] === "list" && command.length === 2) {
    listDeadLetters(config);
    return;
  }
  if (command[0] === "config" && command[1] === "check" && command.length === 2) {
    // Reaching here is the whole check: `loadConfig` already proved ownership,
    // mode, every field, and every cwd root directory.
    createLogger({ level: "info" }).info("bridge.config.ok", { count: config.allowedUserIds.length });
    return;
  }
  if (command[0] === "topic" && command[1] === "detect" && command.length === 2) {
    await detectTopic(config);
    return;
  }
  if (command[0] === "probe") {
    await probeRichMessages(config, command.slice(1));
    return;
  }
  throw new Error(USAGE);
}

/**
 * Prints one JSON line per isolated update.
 *
 * A dead letter has no column for prompt text, a caption, an image, or a
 * token, so the whole record is safe to print as it stands.
 */
function listDeadLetters(config: BridgeConfig): void {
  const store = new Store(config.databasePath);
  try {
    for (const record of store.listDeadLetters()) {
      process.stdout.write(`${JSON.stringify(record)}\n`);
    }
  } finally {
    store.close();
  }
}

/**
 * Reports the ids of the first private topic an allowlisted user writes in.
 *
 * The bot cannot create a topic in a private chat, so the human makes one and
 * posts in it. Polling starts at the persisted checkpoint and settles what it
 * consumes, so this command leaves the checkpoint exactly as the service would
 * have: the detection message is accounted for instead of being replayed as a
 * prompt by the service that starts later.
 */
export async function detectTopic(config: BridgeConfig, baseUrl?: string): Promise<void> {
  const logger = createLogger({ level: config.logLevel });
  const allowlist = new Allowlist(config.allowedUserIds);
  const api = new TelegramApi({ token: config.botToken, baseUrl, logger });
  const identity = await api.getMe();
  logger.info("bridge.probe.identity", { botId: identity.id });
  const store = new Store(config.databasePath);
  const deadline = Date.now() + DETECT_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      const offset = store.checkpoint();
      const updates = await api.getUpdates(offset === 0 ? {} : { offset: offset + 1 });
      const seen: number[] = [];
      let found: { chatId: number; threadId: number } | undefined;
      for (const update of updates) {
        seen.push(update.update_id);
        const decision = classifyUpdate(update, allowlist);
        if (found === undefined && decision.action === "deliver" && decision.update.thread.threadId > 0) {
          found = decision.update.thread;
        }
      }
      if (seen.length > 0) store.settleUpdates(seen);
      if (found !== undefined) {
        logger.info("bridge.topic.detected", { chatId: found.chatId, threadId: found.threadId });
        return;
      }
    }
  } finally {
    store.close();
  }
  throw new Error("No message arrived in a private topic before the detection timeout");
}

/**
 * Proves the two Rich Message calls the bridge cannot work without.
 *
 * Rendering is a deployment prerequisite (ADR 0003): there is no plain-message
 * fallback, so a bot that cannot stream a draft and land a final Rich Message
 * must not be installed as a service. The evidence is ids and durations only.
 */
export async function probeRichMessages(
  config: BridgeConfig,
  args: readonly string[],
  baseUrl?: string,
): Promise<void> {
  const threadId = readNumberFlag(args, "--thread");
  if (threadId === undefined) throw new Error(USAGE);
  const chatId = readNumberFlag(args, "--chat") ?? soleAllowedUserId(config);
  const logger = createLogger({ level: config.logLevel });
  const api = new TelegramApi({ token: config.botToken, baseUrl, logger });

  const identity = await api.getMe();
  logger.info("bridge.probe.identity", { botId: identity.id });

  await timed(logger, "bridge.probe.draft", { chatId, threadId }, () =>
    api.sendRichMessageDraft({
      chatId,
      threadId,
      draftId: 1,
      blocks: [
        { type: "thinking", text: "正在检查 Rich Message 渲染" },
        { type: "paragraph", text: "安装前自检：结构化草稿" },
        { type: "pre", text: 'print("im-bridge")', language: "python" },
      ],
    }),
  );

  const messageId = await timed(logger, "bridge.probe.final", { chatId, threadId }, () =>
    api.sendRichMessage({
      chatId,
      threadId,
      markdown: "安装前自检通过：最终 Rich Message 已送达本 topic。\n\n```python\nprint(\"im-bridge\")\n```\n",
    }),
  );
  logger.info("bridge.probe.passed", { chatId, threadId, messageId });
}

/** Runs one probe step and reports how long the real Bot API took. */
async function timed<T>(
  logger: Logger,
  event: string,
  fields: { chatId: number; threadId: number },
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const result = await run();
  logger.info(event, { ...fields, durationMs: Date.now() - startedAt });
  return result;
}

/**
 * A private chat's id is the user's id, so a single-user allowlist names the
 * chat. More than one user is ambiguous and has to be said explicitly.
 */
export function soleAllowedUserId(config: BridgeConfig): number {
  const [only, ...rest] = config.allowedUserIds;
  if (only === undefined || rest.length > 0) {
    throw new Error("Pass --chat <id>: the allowlist does not name a single private chat");
  }
  return only;
}

export function readNumberFlag(args: readonly string[], flag: string): number | undefined {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  const value = Number(args[at + 1]);
  if (!Number.isSafeInteger(value)) throw new Error(`${flag} needs an integer id`);
  return value;
}

// Only the process that was started with this file runs a bridge. Importing it
// — as the command tests do — must not poll Telegram or open a database.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename) {
  try {
    await main();
  } catch (error) {
    // Configuration and startup errors carry no credential by construction.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
