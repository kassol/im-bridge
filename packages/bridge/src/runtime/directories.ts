/**
 * The directories a session may be created in.
 *
 * A configured cwd root is a parent directory, not a workspace: the bridge
 * lists its immediate subdirectories when the menu is drawn and again when a
 * button is tapped. Nothing about that list is remembered in between, so a
 * project added or removed on disk needs no configuration change and no
 * restart.
 *
 * Two rules keep the listing safe to show and safe to act on:
 *
 *   - A button carries the digest of a directory name, never the name and
 *     never a position in the rendered list. Names can be long or non-ASCII
 *     and Telegram allows 64 bytes of callback data; a digest is eight ASCII
 *     characters whatever the name is.
 *   - The chosen name is resolved through `realpath` and proved to be inside
 *     its root before it becomes a cwd. A name that stopped resolving inside
 *     the root between the two reads is refused, not guessed.
 */
import { createHash } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

/** How many hex characters of a name digest a button carries. */
export const DIRECTORY_DIGEST_LENGTH = 8;

/** One immediate subdirectory of a root, reduced to what a button needs. */
export interface DirectoryChoice {
  readonly name: string;
  /** Stands for the name in callback data, which cannot hold the name itself. */
  readonly digest: string;
}

export function directoryDigest(name: string): string {
  return createHash("sha256").update(name, "utf8").digest("hex").slice(0, DIRECTORY_DIGEST_LENGTH);
}

/**
 * The immediate, non-hidden subdirectories of `root`, sorted by name.
 *
 * `isDirectory()` is false for a symbolic link, so a link out of the root is
 * never offered in the first place. Sorting compares code units rather than
 * locale, so the same directory produces the same order on every machine.
 */
export async function listSubdirectories(root: string): Promise<DirectoryChoice[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((name) => ({ name, digest: directoryDigest(name) }));
}

/**
 * The real path of `name` under `root`.
 *
 * `undefined` means the name no longer resolves inside the root: it vanished
 * between the two reads, or it now points somewhere else. Both are refused the
 * same way, because neither may become a cwd.
 */
export async function resolveInsideRoot(root: string, name: string): Promise<string | undefined> {
  let real: string;
  try {
    real = await realpath(join(root, name));
  } catch {
    return undefined;
  }
  return isInside(root, real) ? real : undefined;
}

/**
 * How a cwd under `root` is named on a button: the root's alias, and the one
 * directory name below it. Nothing deeper and no real path ever appears.
 */
export function directoryLabel(alias: string, root: string, cwd: string): string | undefined {
  if (!isInside(root, cwd)) return undefined;
  const inner = relative(root, cwd);
  if (inner === "") return alias;
  return `${alias}/${inner.split(sep)[0] ?? inner}`;
}

/** True when `target` is `root` itself or below it, with no `..` in between. */
export function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}
