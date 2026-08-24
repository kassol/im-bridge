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
    ["-c", `set -euo pipefail\nDSH_SUPERVISOR="${supervisor}"\n${snippet}\nprintf '%s' "$SUPERVISOR_TMP"`],
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
