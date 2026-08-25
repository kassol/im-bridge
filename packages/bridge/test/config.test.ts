import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";

const TOKEN = "8123456789:AAF-abcdefghijklmnopqrstuvwxyz012345678";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function workspace(): Promise<{ root: string; projectDir: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bridge-config-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  await mkdir(projectDir);
  return { root, projectDir };
}

async function writeConfig(root: string, document: unknown, mode = 0o600): Promise<string> {
  const path = join(root, "config.json");
  await writeFile(path, typeof document === "string" ? document : JSON.stringify(document), "utf8");
  await chmod(path, mode);
  return path;
}

function validDocument(projectDir: string, root: string): Record<string, unknown> {
  return {
    botToken: TOKEN,
    allowedUserIds: [149523521],
    cwdRoots: { work: projectDir },
    databasePath: join(root, "im-bridge.db"),
    dshUrl: "http://127.0.0.1:3080",
  };
}

describe("loadConfig", () => {
  it("loads a mode-0600 file owned by the current user", async () => {
    const { root, projectDir } = await workspace();
    const path = await writeConfig(root, { ...validDocument(projectDir, root), logLevel: "debug" });

    const config = await loadConfig(path);

    expect(config.botToken).toBe(TOKEN);
    expect(config.allowedUserIds).toEqual([149523521]);
    expect([...config.cwdRoots]).toEqual([["work", projectDir]]);
    expect(config.databasePath).toBe(join(root, "im-bridge.db"));
    expect(config.dshUrl).toBe("http://127.0.0.1:3080");
    expect(config.logLevel).toBe("debug");
  });

  it("defaults the log level to info", async () => {
    const { root, projectDir } = await workspace();
    const path = await writeConfig(root, validDocument(projectDir, root));
    await expect(loadConfig(path)).resolves.toMatchObject({ logLevel: "info" });
  });

  it("rejects a file readable by anyone but the owner", async () => {
    const { root, projectDir } = await workspace();
    const path = await writeConfig(root, validDocument(projectDir, root), 0o644);
    await expect(loadConfig(path)).rejects.toThrow(/mode 0600/);
  });

  it("rejects a file owned by another user", async () => {
    const { root, projectDir } = await workspace();
    const path = await writeConfig(root, validDocument(projectDir, root));
    // The test cannot chown a file, so it moves the current uid instead.
    const uid = process.getuid?.() ?? 0;
    vi.spyOn(process as { getuid(): number }, "getuid").mockReturnValue(uid + 1);
    await expect(loadConfig(path)).rejects.toThrow(/owned by the current user/);
  });

  it("rejects a missing file and malformed JSON", async () => {
    const { root } = await workspace();
    await expect(loadConfig(join(root, "absent.json"))).rejects.toThrow(/cannot be read/);
    const path = await writeConfig(root, "{ not json");
    await expect(loadConfig(path)).rejects.toThrow(/is not valid JSON/);
  });

  it("rejects an unknown or missing field", async () => {
    const { root, projectDir } = await workspace();
    const extra = await writeConfig(root, { ...validDocument(projectDir, root), tunnel: true });
    await expect(loadConfig(extra)).rejects.toThrow(/unknown field: tunnel/);
    const { botToken: _omitted, ...rest } = validDocument(projectDir, root);
    const missing = await writeConfig(root, rest);
    await expect(loadConfig(missing)).rejects.toThrow(/botToken/);
  });

  it("rejects a token that is not a Telegram bot token", async () => {
    const { root, projectDir } = await workspace();
    const path = await writeConfig(root, { ...validDocument(projectDir, root), botToken: "not-a-token" });
    await expect(loadConfig(path)).rejects.toThrow(/botToken/);
  });

  it("keeps the token out of every error message", async () => {
    const { root, projectDir } = await workspace();
    const path = await writeConfig(root, { ...validDocument(projectDir, root), allowedUserIds: [] });
    await expect(loadConfig(path)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(TOKEN) }) as Error,
    );
  });

  it("rejects an empty allowlist and a non-integer user id", async () => {
    const { root, projectDir } = await workspace();
    const empty = await writeConfig(root, { ...validDocument(projectDir, root), allowedUserIds: [] });
    await expect(loadConfig(empty)).rejects.toThrow(/allowedUserIds/);
    const fractional = await writeConfig(root, { ...validDocument(projectDir, root), allowedUserIds: [1.5] });
    await expect(loadConfig(fractional)).rejects.toThrow(/allowedUserIds/);
  });

  it("rejects invalid cwd root alias syntax", async () => {
    const { root, projectDir } = await workspace();
    for (const alias of ["", "a".repeat(33), "with space", "dot.alias", "斜杠"]) {
      const path = await writeConfig(root, {
        ...validDocument(projectDir, root),
        cwdRoots: { [alias]: projectDir },
      });
      await expect(loadConfig(path)).rejects.toThrow(/cwd root/);
    }
  });

  it("rejects cwd root aliases that collide case-insensitively", async () => {
    const { root, projectDir } = await workspace();
    const path = await writeConfig(root, {
      ...validDocument(projectDir, root),
      cwdRoots: { Work: projectDir, work: projectDir },
    });
    await expect(loadConfig(path)).rejects.toThrow(/duplicate cwd root/i);
  });

  it("rejects a relative, missing, or non-directory cwd root", async () => {
    const { root, projectDir } = await workspace();
    const file = join(root, "notes.txt");
    await writeFile(file, "x", "utf8");
    const cases: Array<[string, RegExp]> = [
      ["./project", /absolute/],
      [join(root, "absent"), /does not resolve to a directory/],
      [file, /does not resolve to a directory/],
    ];
    for (const [dir, expected] of cases) {
      const path = await writeConfig(root, { ...validDocument(projectDir, root), cwdRoots: { work: dir } });
      await expect(loadConfig(path)).rejects.toThrow(expected);
    }
  });

  it("resolves a cwd root through symlinks", async () => {
    const { root, projectDir } = await workspace();
    const link = join(root, "link");
    await symlink(projectDir, link);
    const path = await writeConfig(root, { ...validDocument(projectDir, root), cwdRoots: { work: link } });
    const config = await loadConfig(path);
    expect(config.cwdRoots.get("work")).toBe(projectDir);
  });

  it("rejects an unusable dsh url, database path, and log level", async () => {
    const { root, projectDir } = await workspace();
    const url = await writeConfig(root, { ...validDocument(projectDir, root), dshUrl: "ws://127.0.0.1:3080" });
    await expect(loadConfig(url)).rejects.toThrow(/dshUrl/);
    const db = await writeConfig(root, { ...validDocument(projectDir, root), databasePath: "  " });
    await expect(loadConfig(db)).rejects.toThrow(/databasePath/);
    const level = await writeConfig(root, { ...validDocument(projectDir, root), logLevel: "trace" });
    await expect(loadConfig(level)).rejects.toThrow(/logLevel/);
  });

  it("accepts an empty cwd root map", async () => {
    const { root, projectDir } = await workspace();
    const path = await writeConfig(root, { ...validDocument(projectDir, root), cwdRoots: {} });
    await expect(loadConfig(path)).resolves.toMatchObject({ cwdRoots: new Map() });
  });
});
