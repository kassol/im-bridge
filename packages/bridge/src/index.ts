/**
 * Entry point.
 *
 * Wiring only: read configuration, fail fast on anything missing, and report
 * what would run. Backend and platform loops are not implemented yet.
 */
import { Allowlist } from "./telegram/allowlist.ts";
import { LinkStore } from "./store/links.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function main(): void {
  // Presence is all we report. The token guards an agent that can run shell
  // commands, so no part of it goes to stdout, which ends up in the log file.
  required("TG_BOT_TOKEN");
  const allowlist = Allowlist.fromEnv(process.env["TG_ALLOWED_USER_IDS"]);
  const dshUrl = process.env["DSH_URL"] ?? "http://127.0.0.1:3080";
  const dbPath = process.env["IM_BRIDGE_DB"] ?? "./im-bridge.db";

  // Refuse to run with no allowlist: a bridge nobody may use is a bug, and
  // starting up anyway invites someone to "fix" it by opening access.
  if (allowlist.size === 0) {
    throw new Error("TG_ALLOWED_USER_IDS is empty; refusing to start with no authorised users");
  }

  const links = new LinkStore(dbPath);

  console.log("im-bridge configured");
  console.log(`  backend      dsh @ ${dshUrl}`);
  console.log("  platform     telegram (token configured)");
  console.log(`  authorised   ${allowlist.size} user(s)`);
  console.log(`  links        ${dbPath} (${links.list().length} existing)`);
  console.log("Backend and platform loops are not implemented yet.");

  links.close();
}

main();
