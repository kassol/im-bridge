/**
 * Entry point.
 *
 * The LaunchAgent passes one argument: the path of the configuration file.
 * Startup validates that file, proves the bot can work in topics, and then
 * polls Telegram. Link and turn behavior arrive with the runtime; until then
 * an authorised update is only logged.
 */
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
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

  try {
    await runUpdateLoop({
      api,
      allowlist,
      logger,
      signal: controller.signal,
      onUpdate: () => {},
    });
  } finally {
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
