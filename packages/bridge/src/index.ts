/**
 * Entry point.
 *
 * The LaunchAgent passes one argument: the path of the configuration file.
 * Startup validates that file, proves the bot can work in topics, and then
 * polls Telegram. Every accepted update goes to the runtime, which owns the
 * menus and the links.
 *
 * A second argument runs a local command against the same configuration and
 * exits instead of polling. `dead-letters list` is the only one: it reads what
 * the bridge gave up on, and it needs no bot token and no backend.
 */
import { DshBackend } from "./backends/dsh.ts";
import { loadConfig, type BridgeConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { BridgeRuntime } from "./runtime/runtime.ts";
import { Store } from "./store/store.ts";
import { Allowlist } from "./telegram/allowlist.ts";
import { TelegramApi } from "./telegram/api.ts";
import { runUpdateLoop } from "./telegram/updates.ts";

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (configPath === undefined) {
    throw new Error("Usage: node --experimental-strip-types src/index.ts <config.json>");
  }
  const config = await loadConfig(configPath);
  const command = process.argv.slice(3);
  if (command.length > 0) {
    runCommand(command, config);
    return;
  }
  const logger = createLogger({ level: config.logLevel });
  const allowlist = new Allowlist(config.allowedUserIds);
  const api = new TelegramApi({ token: config.botToken, logger });

  // Fails on an invalid token and on a bot whose threaded mode is off, before
  // any update is accepted.
  const identity = await api.getMe();
  const store = new Store(config.databasePath);
  // A session may only be created inside a configured alias directory, so the
  // alias map is also the backend's allowed cwd roots.
  const backend = new DshBackend({
    baseUrl: config.dshUrl,
    allowedCwdRoots: [...config.cwdAliases.values()],
  });
  logger.info("bridge.started", { botId: identity.id, count: allowlist.size });

  const controller = new AbortController();
  const stop = (reason: string) => (): void => {
    logger.info("bridge.stopping", { reason });
    controller.abort();
  };
  // Minimal shutdown: stop polling and let the process exit. Draining active
  // work is the graceful-shutdown ticket.
  process.on("SIGTERM", stop("SIGTERM"));
  process.on("SIGINT", stop("SIGINT"));

  const runtime = new BridgeRuntime({
    api,
    backend,
    store,
    allowlist,
    cwdAliases: config.cwdAliases,
    logger,
    signal: controller.signal,
  });

  // Whatever the last run left mid-flight is isolated and reported before a
  // new update is accepted, so recovery cannot race the work it is recovering.
  await runtime.recover();

  // Subscribing before polling means a turn already running in dsh's own Web UI
  // renders from its next event, not from the next Telegram message.
  await runtime.start();

  try {
    await runUpdateLoop({
      api,
      allowlist,
      checkpoint: store,
      logger,
      signal: controller.signal,
      onUpdate: (update) => runtime.handleUpdate(update),
    });
  } finally {
    await backend.close();
    store.close();
    logger.info("bridge.stopped");
  }
}

/**
 * Prints one JSON line per isolated update.
 *
 * A dead letter has no column for prompt text, a caption, an image, or a
 * token, so the whole record is safe to print as it stands.
 */
function runCommand(command: readonly string[], config: BridgeConfig): void {
  if (command[0] !== "dead-letters" || command[1] !== "list" || command.length !== 2) {
    throw new Error("Usage: <config.json> [dead-letters list]");
  }
  const store = new Store(config.databasePath);
  try {
    for (const record of store.listDeadLetters()) {
      process.stdout.write(`${JSON.stringify(record)}\n`);
    }
  } finally {
    store.close();
  }
}

try {
  await main();
} catch (error) {
  // Configuration and startup errors carry no credential by construction.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
