import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// scripts/setup-dsh.sh writes the dsh supervisor to a temp file and runs
// `node --check` on it before moving it into place. Node 24 picks the module
// loader from the final extension, so a temp name that does not end in .mjs
// aborts the wizard midway through its file-replacement stage.
const scriptPath = fileURLToPath(new URL("../../../scripts/setup-dsh.sh", import.meta.url));

// Pull the live mktemp lines out of the script so this test tracks the real
// implementation rather than a copy of it that could drift.
function supervisorTempSnippet(): string {
  const script = readFileSync(scriptPath, "utf8");
  const lines = script.split("\n");
  const start = lines.findIndex(line => line.startsWith("SUPERVISOR_RESERVED="));
  const end = lines.findIndex(line => line.startsWith('cat > "$SUPERVISOR_TMP"'));
  expect(start, "script must reserve a supervisor temp name").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start, end).join("\n");
}

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "setup-dsh-test-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

// Resolves the temp path the given shell snippet produces for DSH_SUPERVISOR.
function resolveTempPath(snippet: string): string {
  const supervisor = join(workspace, "supervisor.mjs");
  return execFileSync(
    "bash",
    ["-c", `set -euo pipefail\nDSH_SUPERVISOR="${supervisor}"\nDSH_FILES_STAGING="${workspace}"\n${snippet}\nprintf '%s' "$SUPERVISOR_TMP"`],
    { encoding: "utf8" },
  );
}

describe("setup-dsh.sh supervisor temp file", () => {
  it("creates a temp path that keeps the .mjs extension", () => {
    const tempPath = resolveTempPath(supervisorTempSnippet());
    expect(tempPath.endsWith(".mjs")).toBe(true);
  });

  it("passes node --check, which the pre-fix name did not", () => {
    const source = "export const supervisor = 1;\n";

    const fixed = resolveTempPath(supervisorTempSnippet());
    writeFileSync(fixed, source);
    expect(() => execFileSync(process.execPath, ["--check", fixed], { stdio: "pipe" })).not.toThrow();

    // The original `mktemp "${DSH_SUPERVISOR}.XXXXXX"` left the random suffix
    // last, which is the exact failure the wizard hit.
    const legacy = resolveTempPath('SUPERVISOR_TMP=$(mktemp "${DSH_SUPERVISOR}.XXXXXX")');
    expect(legacy.endsWith(".mjs")).toBe(false);
    writeFileSync(legacy, source);
    expect(() => execFileSync(process.execPath, ["--check", legacy], { stdio: "pipe" })).toThrow(
      /ERR_UNKNOWN_FILE_EXTENSION/,
    );
  });

  it("reserves the temp name exclusively so a rerun cannot collide", () => {
    const snippet = supervisorTempSnippet();
    const first = resolveTempPath(snippet);
    const second = resolveTempPath(snippet);
    expect(first).not.toBe(second);
  });

  it("cleans both reserved and final temp paths during rollback", () => {
    const script = readFileSync(scriptPath, "utf8");
    expect(script).toContain('rm -f "$SUPERVISOR_RESERVED"');
    expect(script).toContain('rm -f "$SUPERVISOR_TMP"');
  });
});

// dsh 0.1.1-rc.2 declares only 2 of the client-ui plugins its boot config
// imports. pnpm's strict layout hides the undeclared ones and dsh exits with
// ERR_MODULE_NOT_FOUND within 3 seconds; npm's flat node_modules resolves them
// and dsh listens on 127.0.0.1:3080. The wizard must therefore install with npm
// into a private runtime directory, never as a global package.
describe("setup-dsh.sh dsh runtime installation", () => {
  const script = () => readFileSync(scriptPath, "utf8");

  it("installs the pinned version with npm inside the staging directory", () => {
    expect(script()).toContain(
      '( cd "$DSH_STAGING" && npm install --no-audit --no-fund --loglevel=error "@deepseek-ai/dsh@$DSH_VERSION" )',
    );
  });

  it("never installs dsh globally", () => {
    const installCommands = script()
      .split("\n")
      .filter(line => /\b(npm install|npm i|pnpm add|pnpm install|yarn add)\b/.test(line));
    expect(installCommands.length).toBeGreaterThan(0);
    for (const line of installCommands) {
      expect(line, `global install in: ${line.trim()}`).not.toMatch(/(^|\s)(-g|--global)(\s|$)/);
    }
    expect(script()).not.toMatch(/pnpm (add|remove) -g/);
  });

  it("points the supervisor at the runtime binary, not a resolved global bin", () => {
    const text = script();
    expect(text).toContain('DSH_RUNTIME_BIN="$DSH_RUNTIME/node_modules/.bin/dsh"');
    expect(text).toContain('const child = spawn("$DSH_RUNTIME_BIN"');
    expect(text).not.toContain("pnpm bin -g");
  });

  it("stages beside the runtime so the swap is a same-filesystem rename", () => {
    const text = script();
    expect(text).toContain('DSH_RUNTIME="$DSH_HOME/runtime"');
    expect(text).toContain('DSH_STAGING="$DSH_HOME/staging"');
    // The staged tree must be complete before the live runtime is touched.
    const installAt = text.indexOf("npm install --no-audit");
    const versionCheckAt = text.indexOf('[[ "$INSTALLED_VERSION" == "$DSH_VERSION" ]]');
    const swapAt = text.indexOf('mv "$DSH_STAGING" "$DSH_RUNTIME"');
    const filesSwapAt = text.indexOf('mv "$SUPERVISOR_TMP" "$DSH_SUPERVISOR"');
    expect(installAt).toBeGreaterThan(-1);
    expect(versionCheckAt).toBeGreaterThan(installAt);
    expect(swapAt).toBeGreaterThan(versionCheckAt);
    expect(filesSwapAt).toBeGreaterThan(swapAt);
  });

  it("creates an explicit private npm project before installation", () => {
    const text = script();
    expect(text).toContain(`printf '{"private":true}\\n' > "$DSH_STAGING/package.json"`);
  });

  it("sets rollback state only after each runtime move succeeds", () => {
    const text = script();
    const oldMove = text.indexOf('mv "$DSH_RUNTIME" "$DSH_PREVIOUS_RUNTIME"');
    const oldMoved = text.indexOf("OLD_RUNTIME_MOVED=1", oldMove);
    const newMove = text.indexOf('mv "$DSH_STAGING" "$DSH_RUNTIME"');
    const newInstalled = text.indexOf("NEW_RUNTIME_INSTALLED=1", newMove);
    expect(oldMove).toBeGreaterThan(-1);
    expect(oldMoved).toBeGreaterThan(oldMove);
    expect(newMove).toBeGreaterThan(oldMoved);
    expect(newInstalled).toBeGreaterThan(newMove);
  });

  it("does not stop the live service during the long runtime install", () => {
    const text = script();
    const stage4 = text.indexOf('stage "Install pinned dsh runtime"');
    const stage5 = text.indexOf('stage "Start and verify dsh"');
    expect(stage4).toBeGreaterThan(-1);
    expect(stage5).toBeGreaterThan(stage4);
    expect(text.slice(stage4, stage5)).not.toContain('launchctl bootout "$DOMAIN/$LABEL"');
  });

  it("restores the previous runtime when a later stage fails", () => {
    const text = script();
    expect(text).toContain('mv "$DSH_RUNTIME" "$DSH_PREVIOUS_RUNTIME"');
    expect(text).toContain('mv "$DSH_PREVIOUS_RUNTIME" "$DSH_RUNTIME"');
    expect(text).toContain('if (( OLD_RUNTIME_MOVED == 1 )); then');
    expect(text).toContain('rm -rf "$DSH_STAGING" "$DSH_FILES_STAGING"');
  });

  it("drops the backup only after the service verifies", () => {
    const text = script();
    const httpCheckAt = text.indexOf('curl --fail --silent --show-error --max-time 5');
    const cleanupAt = text.lastIndexOf('rm -rf "$DSH_PREVIOUS_RUNTIME"');
    expect(httpCheckAt).toBeGreaterThan(-1);
    expect(cleanupAt).toBeGreaterThan(httpCheckAt);
  });
});

// A failed start is the only time the log matters, so rollback keeps it and
// Stage 5 prints a bounded tail. The key must never reach the terminal.
describe("setup-dsh.sh failure diagnostics", () => {
  const script = () => readFileSync(scriptPath, "utf8");

  it("keeps the dsh log during rollback", () => {
    const text = script();
    expect(text).toContain('[[ ! -f "$LOG_FILE" ]] || note "dsh log kept for diagnosis: $LOG_FILE"');
    // Nothing in the script may delete the live log.
    expect(text).not.toMatch(/rm -[a-z]*f[a-z]* "\$LOG_FILE"/);
  });

  it("shows a redacted tail on both Stage 5 failure paths", () => {
    const text = script();
    expect(text).toContain("show_log_tail() {");
    const occurrences = text.split("\n").filter(line => line.trim() === "show_log_tail").length;
    expect(occurrences).toBe(2);
  });

  it("prints only fixed diagnostics even when a secret shares the matching line", () => {
    const text = script();
    const start = text.indexOf("show_log_tail() {");
    const end = text.indexOf("\n}", start) + 2;
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const functionSource = text.slice(start, end);

    const logFile = join(workspace, "dsh.log");
    writeFileSync(logFile, "Authorization: Bearer plain-secret-value ERR_MODULE_NOT_FOUND\n");

    const output = execFileSync(
      "bash",
      [
        "-c",
        `set -uo pipefail\nLOG_FILE="${logFile}"\nnote() { printf '%s\\n' "$1"; }\nwarn() { printf '%s\\n' "$1"; }\n${functionSource}\nshow_log_tail`,
      ],
      { encoding: "utf8" },
    );

    expect(output).not.toContain("plain-secret-value");
    expect(output).not.toContain("Authorization");
    expect(output).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(output).toContain("diagnosis: dsh reported a missing module");
    expect(output).toContain(logFile);
  });
});
