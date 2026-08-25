/**
 * The single configuration source.
 *
 * The bot token is the only credential in front of an agent that can run shell
 * commands, so configuration is one file rather than a merge of file and
 * environment: an env override path would let a stray exported variable widen
 * the allowlist or repoint a cwd alias without editing anything reviewable.
 * The LaunchAgent therefore passes a path and nothing else.
 *
 * Every check here fails startup. A bridge that starts with a broken allowlist
 * or an unreadable alias is worse than a bridge that does not start.
 */
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { LogLevel } from "./log.ts";

export interface BridgeConfig {
  readonly botToken: string;
  readonly allowedUserIds: readonly number[];
  /** Alias -> resolved absolute directory. Real paths never reach Telegram. */
  readonly cwdAliases: ReadonlyMap<string, string>;
  readonly databasePath: string;
  readonly dshUrl: string;
  readonly logLevel: LogLevel;
}

/** Telegram bot tokens are `<bot id>:<secret>`; the secret is 35+ url-safe characters. */
const TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{35,}$/;
const ALIAS_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const REQUIRED_MODE = 0o600;
const KNOWN_FIELDS = [
  "botToken",
  "allowedUserIds",
  "cwdAliases",
  "databasePath",
  "dshUrl",
  "logLevel",
] as const;

export async function loadConfig(path: string): Promise<BridgeConfig> {
  const document = await readDocument(path);
  for (const field of Object.keys(document)) {
    if (!(KNOWN_FIELDS as readonly string[]).includes(field)) {
      throw configError(path, `unknown field: ${field}`);
    }
  }

  const botToken = requireString(path, document, "botToken");
  if (!TOKEN_PATTERN.test(botToken)) {
    // The value itself never appears in the message; the token would then live
    // in the log file of a process that failed to start.
    throw configError(path, "botToken is not a Telegram bot token");
  }

  return {
    botToken,
    allowedUserIds: parseAllowedUserIds(path, document),
    cwdAliases: await parseCwdAliases(path, document),
    databasePath: requireNonBlank(path, document, "databasePath"),
    dshUrl: parseDshUrl(path, document),
    logLevel: parseLogLevel(path, document),
  };
}

/**
 * Read through one file handle so ownership and mode describe the bytes that
 * were parsed, not a file that could be swapped between the check and the read.
 */
async function readDocument(path: string): Promise<Record<string, unknown>> {
  const currentUid = process.getuid?.();
  if (currentUid === undefined) throw configError(path, "this platform has no user ids");
  const handle = await open(path, "r").catch((error: unknown) => {
    throw configError(path, "cannot be read", error);
  });
  try {
    const info = await handle.stat();
    if (info.uid !== currentUid) throw configError(path, "must be owned by the current user");
    if ((info.mode & 0o777) !== REQUIRED_MODE) throw configError(path, "must have mode 0600");
    const raw = await handle.readFile("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw configError(path, "is not valid JSON", error);
    }
    if (!isRecord(parsed)) throw configError(path, "must contain a JSON object");
    return parsed;
  } finally {
    await handle.close();
  }
}

function parseAllowedUserIds(path: string, document: Record<string, unknown>): number[] {
  const value = document["allowedUserIds"];
  if (!Array.isArray(value) || value.length === 0) {
    throw configError(path, "allowedUserIds must be a non-empty array of numeric user ids");
  }
  return value.map((entry) => {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry)) {
      throw configError(path, "allowedUserIds must contain integer user ids");
    }
    return entry;
  });
}

async function parseCwdAliases(
  path: string,
  document: Record<string, unknown>,
): Promise<ReadonlyMap<string, string>> {
  const value = document["cwdAliases"];
  if (!isRecord(value)) throw configError(path, "cwdAliases must be an object mapping alias to directory");
  const resolved = new Map<string, string>();
  const seen = new Map<string, string>();
  for (const [alias, directory] of Object.entries(value)) {
    if (!ALIAS_PATTERN.test(alias)) {
      throw configError(path, `cwd alias must be 1-32 letters, digits, hyphens, or underscores: ${alias}`);
    }
    const previous = seen.get(alias.toLowerCase());
    if (previous !== undefined) {
      throw configError(path, `duplicate cwd alias ignoring case: ${previous} and ${alias}`);
    }
    seen.set(alias.toLowerCase(), alias);
    if (typeof directory !== "string" || !isAbsolute(directory)) {
      throw configError(path, `cwd alias ${alias} must point at an absolute directory path`);
    }
    resolved.set(alias, await resolveDirectory(path, alias, directory));
  }
  return resolved;
}

async function resolveDirectory(path: string, alias: string, directory: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(directory);
    if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw configError(path, `cwd alias ${alias} does not resolve to a directory`, error);
  }
  return real;
}

function parseDshUrl(path: string, document: Record<string, unknown>): string {
  const value = requireNonBlank(path, document, "dshUrl");
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw configError(path, "dshUrl must be an absolute http URL", error);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw configError(path, "dshUrl must be an absolute http URL");
  }
  return value;
}

function parseLogLevel(path: string, document: Record<string, unknown>): LogLevel {
  const value = document["logLevel"];
  if (value === undefined) return "info";
  if (value !== "info" && value !== "debug") throw configError(path, "logLevel must be info or debug");
  return value;
}

function requireString(path: string, document: Record<string, unknown>, field: string): string {
  const value = document[field];
  if (typeof value !== "string") throw configError(path, `${field} must be a string`);
  return value;
}

function requireNonBlank(path: string, document: Record<string, unknown>, field: string): string {
  const value = requireString(path, document, field);
  if (value.trim() === "") throw configError(path, `${field} must not be empty`);
  return value;
}

function configError(path: string, problem: string, cause?: unknown): Error {
  return new Error(`Config ${path} ${problem}`, cause === undefined ? undefined : { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
