/**
 * scripts/setup-bridge.sh, proved through what it generates.
 *
 * The wizard cannot be run here: it installs a LaunchAgent, talks to the real
 * Bot API, and asks a human to tap buttons. What is testable is everything it
 * writes and the order in which it commits — the two places where a mistake
 * either leaks the bot token or replaces a working service with a broken one.
 *
 * The token used below is a syntactically valid but fictional value. Nothing
 * here contacts Telegram.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("../../../scripts/setup-bridge.sh", import.meta.url));
const dshScriptPath = fileURLToPath(new URL("../../../scripts/setup-dsh.sh", import.meta.url));
const entryPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** A well-formed value that no bot will ever answer to. */
const FAKE_TOKEN = "8123456789:AAF-abcdefghijklmnopqrstuvwxyz012345678";

const script = (): string => readFileSync(scriptPath, "utf8");

/** Pulls a heredoc body out of the live script so the test cannot drift from it. */
function heredoc(open: string, terminator: string): string {
  const text = script();
  const start = text.indexOf(open);
  expect(start, `script must contain: ${open}`).toBeGreaterThan(-1);
  const end = text.indexOf(`\n${terminator}`, start + open.length);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end + terminator.length + 1);
}

/** Pulls a shell function body out of the live script. */
function shellFunction(name: string): string {
  const text = script();
  const start = text.indexOf(`${name}() {`);
  expect(start, `script must define ${name}`).toBeGreaterThan(-1);
  const end = text.indexOf("\n}", start) + 2;
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "setup-bridge-test-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

interface WriterResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the generated configuration writer exactly as the wizard runs it. */
function writeConfig(options: {
  token: string;
  allowlist: string;
  aliases: string;
  databasePath: string;
  dshUrl?: string;
  logLevel?: string;
  out: string;
}): WriterResult {
  const writer = join(workspace, "write-config.mjs");
  writeFileSync(writer, stripHeredoc(heredoc('cat > "$CONFIG_WRITER_TMP" <<"WRITER_EOF"', "WRITER_EOF")));
  // The wizard checks the generated file before it runs it.
  execFileSync(process.execPath, ["--check", writer], { stdio: "pipe" });
  try {
    const stdout = execFileSync(process.execPath, [writer], {
      input: options.token,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        BRIDGE_ALLOWLIST: options.allowlist,
        BRIDGE_ALIASES: options.aliases,
        BRIDGE_DATABASE: options.databasePath,
        BRIDGE_DSH_URL: options.dshUrl ?? "http://127.0.0.1:3080",
        BRIDGE_LOG_LEVEL: options.logLevel ?? "info",
        BRIDGE_CONFIG_OUT: options.out,
      },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout?.toString("utf8") ?? "",
      stderr: failure.stderr?.toString("utf8") ?? "",
    };
  }
}

/** Drops the `cat > ... <<TAG` line and the terminator, leaving the body. */
function stripHeredoc(block: string): string {
  const lines = block.split("\n");
  return `${lines.slice(1, -1).join("\n")}\n`;
}

function checkConfig(path: string): number {
  try {
    execFileSync(process.execPath, ["--experimental-strip-types", entryPath, path, "config", "check"], {
      stdio: "pipe",
    });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}

describe("setup-bridge.sh wizard library", () => {
  it("carries the wizard library above the STAGES marker verbatim", () => {
    const marker = "# STAGES: author this section.";
    const mine = script();
    const dsh = readFileSync(dshScriptPath, "utf8");
    expect(mine.slice(0, mine.indexOf(marker))).toBe(dsh.slice(0, dsh.indexOf(marker)));
  });

  it("keeps the reserved temp name under the .mjs extension node --check needs", () => {
    const text = script();
    expect(text).toContain('CONFIG_WRITER_RESERVED=$(mktemp "$FILES_STAGING/write-config.XXXXXX")');
    expect(text).toContain('CONFIG_WRITER_TMP="${CONFIG_WRITER_RESERVED}.mjs"');
    expect(text).toContain('"$NODE_BIN" --check "$CONFIG_WRITER_TMP"');
  });
});

describe("setup-bridge.sh configuration file", () => {
  it("writes a mode-0600 config the bridge loader accepts", () => {
    const aliasDir = join(workspace, "work");
    mkdirSync(aliasDir);
    const out = join(workspace, "config.json");

    const result = writeConfig({
      token: FAKE_TOKEN,
      allowlist: "149523521, 88",
      aliases: `work=${aliasDir}`,
      databasePath: join(workspace, "bridge.db"),
      out,
    });

    expect(result.status).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(statSync(out).uid).toBe(process.getuid?.());
    const document = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
    expect(document).toEqual({
      botToken: FAKE_TOKEN,
      allowedUserIds: [149523521, 88],
      cwdAliases: { work: aliasDir },
      databasePath: join(workspace, "bridge.db"),
      dshUrl: "http://127.0.0.1:3080",
      logLevel: "info",
    });
    expect(checkConfig(out)).toBe(0);
  });

  it("refuses a value that is not a bot token, without quoting it back", () => {
    const out = join(workspace, "config.json");
    const result = writeConfig({
      token: "not-a-token-but-still-secret",
      allowlist: "1",
      aliases: `work=${workspace}`,
      databasePath: join(workspace, "bridge.db"),
      out,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("bot token is not in the");
    expect(result.stderr).not.toContain("not-a-token-but-still-secret");
    expect(() => readFileSync(out)).toThrow();
  });

  it("refuses an empty allowlist, which is the only authentication there is", () => {
    const result = writeConfig({
      token: FAKE_TOKEN,
      allowlist: "",
      aliases: `work=${workspace}`,
      databasePath: join(workspace, "bridge.db"),
      out: join(workspace, "config.json"),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("BRIDGE_ALLOWLIST is empty");
  });

  it("refuses a relative cwd alias directory", () => {
    const result = writeConfig({
      token: FAKE_TOKEN,
      allowlist: "1",
      aliases: "work=relative/path",
      databasePath: join(workspace, "bridge.db"),
      out: join(workspace, "config.json"),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("absolute path");
  });

  it("reports a wrong file mode through the loader rather than trusting the writer", () => {
    const aliasDir = join(workspace, "work");
    mkdirSync(aliasDir);
    const out = join(workspace, "config.json");
    writeConfig({
      token: FAKE_TOKEN,
      allowlist: "1",
      aliases: `work=${aliasDir}`,
      databasePath: join(workspace, "bridge.db"),
      out,
    });
    chmodSync(out, 0o644);
    expect(checkConfig(out)).toBe(1);
  });
});

describe("setup-bridge.sh token handling", () => {
  it("never echoes, stores, or passes the token on a command line", () => {
    const text = script();
    expect(text).toContain("ask_secret BOT_TOKEN");
    // The only use of the value is a pipe into the writer's standard input.
    const uses = text
      .split("\n")
      .filter(line => line.includes("$BOT_TOKEN"))
      .map(line => line.trim());
    expect(uses).toEqual([
      '[[ "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{35,}$ ]] || {',
      `printf '%s' "$BOT_TOKEN" | BRIDGE_ALLOWLIST="$ALLOWED_USER_IDS" \\`,
    ]);
    expect(text).not.toMatch(/write_env\s+BOT_TOKEN/u);
    expect(text).not.toMatch(/(echo|printf|note|say|warn)[^\n]*\$BOT_TOKEN[^|]*$/mu);
  });

  it("keeps the token out of every generated artifact except the config file", () => {
    const aliasDir = join(workspace, "work");
    mkdirSync(aliasDir);
    const configPath = join(workspace, "config.json");
    const result = writeConfig({
      token: FAKE_TOKEN,
      allowlist: "1",
      aliases: `work=${aliasDir}`,
      databasePath: join(workspace, "bridge.db"),
      out: configPath,
    });

    expect(result.stdout).not.toContain(FAKE_TOKEN);
    expect(result.stderr).not.toContain(FAKE_TOKEN);
    const plist = generatePlist({ configPath });
    expect(plist).not.toContain(FAKE_TOKEN);
    // The remembered answers are the non-secret ones only.
    expect(script()).toContain("write_env ALLOWED_USER_IDS");
    expect(script()).toContain("write_env LOG_LEVEL");
  });
});

/** Generates the LaunchAgent plist the way the wizard's heredoc does. */
function generatePlist(options: { configPath?: string } = {}): string {
  const out = join(workspace, "bridge.plist");
  execFileSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
PLIST_TMP="$1"
LABEL="$2"
NODE_BIN="$3"
BRIDGE_ENTRY="$4"
CONFIG_FILE="$5"
LOG_FILE="$6"
NODE_DIR="$7"
${heredoc('cat > "$PLIST_TMP" <<EOF', "EOF")}`,
      "generate-plist",
      out,
      "dev.im-bridge.bridge",
      "/opt/node/bin/node",
      "/opt/im-bridge/packages/bridge/src/index.ts",
      options.configPath ?? "/Users/tester/.config/im-bridge/config.json",
      "/Users/tester/Library/Logs/im-bridge/bridge.log",
      "/opt/node/bin",
    ],
    { cwd: workspace },
  );
  execFileSync("plutil", ["-lint", out], { stdio: "pipe" });
  return readFileSync(out, "utf8");
}

describe("setup-bridge.sh LaunchAgent plist", () => {
  it("passes the pinned runtime and nothing but the config path", () => {
    const plist = generatePlist();
    const args = [...plist.matchAll(/<array>([\s\S]*?)<\/array>/gu)][0]?.[1] ?? "";
    expect([...args.matchAll(/<string>(.*?)<\/string>/gu)].map(match => match[1])).toEqual([
      "/opt/node/bin/node",
      "--experimental-strip-types",
      "/opt/im-bridge/packages/bridge/src/index.ts",
      "/Users/tester/.config/im-bridge/config.json",
    ]);
  });

  it("starts at login and restarts only after an abnormal exit", () => {
    const plist = generatePlist();
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/u,
    );
    // A bare `<true/>` KeepAlive would restart a deliberate stop as well.
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/u);
  });

  it("sends both streams to the bridge log", () => {
    const plist = generatePlist();
    expect(plist).toContain(
      "<key>StandardOutPath</key>\n  <string>/Users/tester/Library/Logs/im-bridge/bridge.log</string>",
    );
    expect(plist).toContain(
      "<key>StandardErrorPath</key>\n  <string>/Users/tester/Library/Logs/im-bridge/bridge.log</string>",
    );
  });
});

describe("setup-bridge.sh log rotation", () => {
  it("keeps the newest file and drops everything past the retained count", () => {
    const logFile = join(workspace, "bridge.log");
    const big = Buffer.alloc(11 * 1024 * 1024, 0x61);
    writeFileSync(logFile, big);
    for (const index of [1, 2, 3, 4]) writeFileSync(`${logFile}.${String(index)}`, `archive ${String(index)}`);

    execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
LOG_FILE="${logFile}"
LOG_MAX_BYTES=10485760
LOG_FILE_COUNT=5
${shellFunction("rotate_logs")}
rotate_logs`,
      ],
      { stdio: "pipe" },
    );

    expect(() => readFileSync(logFile)).toThrow();
    expect(readFileSync(`${logFile}.2`, "utf8")).toBe("archive 1");
    expect(readFileSync(`${logFile}.1`).length).toBe(big.length);
    // The fifth archive is dropped rather than kept forever.
    expect(() => readFileSync(`${logFile}.5`)).toThrow();
  });

  it("leaves a log below the ceiling alone", () => {
    const logFile = join(workspace, "bridge.log");
    writeFileSync(logFile, "small");
    execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
LOG_FILE="${logFile}"
LOG_MAX_BYTES=10485760
LOG_FILE_COUNT=5
${shellFunction("rotate_logs")}
rotate_logs`,
      ],
      { stdio: "pipe" },
    );
    expect(readFileSync(logFile, "utf8")).toBe("small");
  });
});

describe("setup-bridge.sh validation ordering", () => {
  // Ordering is a property of the stages. `rollback` is declared above them and
  // repeats several of the same commands, so it is excluded from the search.
  const stages = (): string => script().slice(script().indexOf('stage "Pre-flight checks"'));
  const at = (needle: string): number => {
    const index = stages().indexOf(needle);
    expect(index, `stages must contain: ${needle}`).toBeGreaterThan(-1);
    return index;
  };

  it("validates the staged config before it replaces the installed one", () => {
    expect(at('"$BRIDGE_ENTRY" "$CONFIG_TMP" config check')).toBeLessThan(
      at('mv "$CONFIG_TMP" "$CONFIG_FILE"'),
    );
  });

  it("runs typecheck and the suite, then the probe, then the live check, then installs", () => {
    const typecheck = at("pnpm -F bridge typecheck )");
    const suite = at("pnpm -F bridge test )");
    const probe = at('"$BRIDGE_ENTRY" "$CONFIG_FILE" probe');
    const live = at("pnpm -F bridge live:e2e");
    const install = at('launchctl bootstrap "$DOMAIN" "$PLIST"');
    expect(typecheck).toBeLessThan(suite);
    expect(suite).toBeLessThan(probe);
    expect(probe).toBeLessThan(live);
    expect(live).toBeLessThan(install);
  });

  it("detects the test topic before it probes into it", () => {
    expect(at('"$CONFIG_FILE" topic detect')).toBeLessThan(at('"$CONFIG_FILE" probe'));
  });

  it("writes no service file before the live check passed", () => {
    const text = stages();
    const live = text.indexOf("pnpm -F bridge live:e2e");
    expect(text.slice(0, live)).not.toContain('mv "$PLIST_TMP" "$PLIST"');
    expect(text.slice(0, live)).not.toContain('launchctl bootstrap');
  });

  it("sets each rollback flag only after the move it undoes", () => {
    const text = stages();
    const configMove = text.indexOf('mv "$CONFIG_TMP" "$CONFIG_FILE"');
    expect(text.indexOf("CONFIG_REPLACED=1", configMove)).toBeGreaterThan(configMove);
    const plistMove = text.indexOf('mv "$PLIST_TMP" "$PLIST"');
    expect(text.indexOf("PLIST_REPLACED=1", plistMove)).toBeGreaterThan(plistMove);
    // The flags are only cleared once the service has reported itself started.
    const started = text.lastIndexOf('(( STARTED == 1 ))');
    expect(text.indexOf("TRANSACTION_STARTED=0", started)).toBeGreaterThan(started);
  });
  it("reads the detected topic ids out of the JSON Lines the command prints", () => {
    const text = script();
    const lines = text
      .split("\n")
      .filter(line => line.startsWith("TEST_THREAD_ID=") || line.startsWith("TEST_CHAT_ID="));
    expect(lines).toHaveLength(2);

    const sample = [
      '{"time":"2026-08-25T04:52:39.692Z","level":"info","event":"bridge.probe.identity","botId":8123456789}',
      '{"time":"2026-08-25T04:52:41.100Z","level":"info","event":"bridge.topic.detected","chatId":149523521,"threadId":47}',
    ].join("\n");
    const output = execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail\nDETECT_OUTPUT="$1"\n${lines.join("\n")}\nprintf '%s %s' "$TEST_THREAD_ID" "$TEST_CHAT_ID"`,
        "parse-detect",
        sample,
      ],
      { encoding: "utf8" },
    );
    expect(output).toBe("47 149523521");
  });
});

describe("setup-bridge.sh rollback", () => {
  it("restores the previous config and plist, or removes what it added", () => {
    const text = script();
    expect(text).toContain('cp "$BACKUP_DIR/config.json" "$CONFIG_FILE"');
    expect(text).toContain('cp "$BACKUP_DIR/bridge.plist" "$PLIST"');
    expect(text).toContain('rm -f "$CONFIG_FILE"');
    expect(text).toContain('rm -f "$PLIST"');
    expect(text).toContain('launchctl bootstrap "$DOMAIN" "$PLIST" || warn');
    expect(text).toContain('rm -f "$CONFIG_WRITER_RESERVED"');
    expect(text).toContain('rm -f "$CONFIG_WRITER_TMP"');
    expect(text).toContain('rm -f "$PLIST_TMP"');
  });

  it("backs the existing files up before the first replacement", () => {
    const text = script();
    const backup = text.indexOf('cp "$CONFIG_FILE" "$BACKUP_DIR/config.json"');
    expect(backup).toBeGreaterThan(-1);
    expect(backup).toBeLessThan(text.indexOf('mv "$CONFIG_TMP" "$CONFIG_FILE"'));
    expect(text.indexOf('cp "$PLIST" "$BACKUP_DIR/bridge.plist"')).toBeLessThan(
      text.indexOf('mv "$PLIST_TMP" "$PLIST"'),
    );
  });

  it("does nothing when the run never started changing anything", () => {
    const text = script();
    expect(text).toContain("(( status == 0 || TRANSACTION_STARTED == 0 )) && return 0");
    // Collecting answers happens before the transaction opens.
    expect(text.indexOf("ask_secret BOT_TOKEN")).toBeLessThan(text.indexOf("TRANSACTION_STARTED=1"));
  });

  it("keeps the bridge log for diagnosis and never deletes it", () => {
    const text = script();
    expect(text).toContain('[[ ! -f "$LOG_FILE" ]] || note "bridge log kept for diagnosis: $LOG_FILE"');
    expect(text).not.toMatch(/rm -[a-z]*f[a-z]* "\$LOG_FILE"$/mu);
  });
});

describe("setup-bridge.sh failure diagnostics", () => {
  it("prints only fixed diagnostics even when a secret shares the matching line", () => {
    const logFile = join(workspace, "bridge.log");
    writeFileSync(logFile, `{"event":"telegram.poll.failed","token":"${FAKE_TOKEN}"}\n`);

    const output = execFileSync(
      "bash",
      [
        "-c",
        `set -uo pipefail
LOG_FILE="${logFile}"
note() { printf '%s\\n' "$1"; }
warn() { printf '%s\\n' "$1"; }
${shellFunction("show_log_tail")}
show_log_tail`,
      ],
      { encoding: "utf8" },
    );

    expect(output).not.toContain(FAKE_TOKEN);
    expect(output).toContain("diagnosis: long polling could not reach the Bot API");
    expect(output).toContain(logFile);
  });

  it("fails the stage when the service never reports bridge.started", () => {
    const text = script();
    expect(text).toContain(`grep -q '"event":"bridge.started"' "$LOG_FILE"`);
    expect(text).toContain('warn "the LaunchAgent did not report bridge.started within 30 seconds"');
    const failure = text.indexOf('warn "the LaunchAgent did not report bridge.started within 30 seconds"');
    expect(text.slice(failure, failure + 200)).toContain("exit 1");
  });
});
