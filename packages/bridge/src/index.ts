/**
 * Entry point.
 *
 * The LaunchAgent passes one argument: the path of the configuration file.
 * Startup validates that file, proves the bot can work in topics, and then
 * polls Telegram. Every accepted update goes to the runtime, which owns the
 * menus and the links.
 */
import { DshBackend } from "./backends/dsh.ts";
import { loadConfig } from "./config.ts";
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

  try {
    await runUpdateLoop({
      api,
      allowlist,
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

try {
  await main();
} catch (error) {
  // Configuration and startup errors carry no credential by construction.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
