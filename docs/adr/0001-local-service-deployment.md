# ADR 0001: Local service deployment

Date: 2026-08-24

Status: accepted, partially implemented

Implementation status: `scripts/setup-dsh.sh` implements the dsh installation,
credential validation, LaunchAgent, and bounded logging decisions. The bridge
env installer and bridge LaunchAgent remain pending until the bridge event loop
exists.

## Context

The bridge and its backend are long-running services on a single workstation.
They are not batch jobs: a Telegram topic must stay answerable while the user
session is active, so both processes must start at login, restart after a crash,
and keep bounded logs.

Two facts constrain the design:

- The bridge opens no inbound port. It polls Telegram outbound and connects to
  dsh on the loopback address only. Deployment therefore needs no firewall or
  reverse proxy, only process supervision.
- The bot token is the sole credential in front of an agent that can run shell
  commands. Every deployment mechanism that touches it (installer, supervisor
  configuration, log output) is part of the security boundary.

An earlier working session installed dsh into a throwaway directory and ran it
by hand. That is not reproducible and does not survive a reboot.

## Decision

### Backend installation

Install dsh with npm into a private runtime directory,
`~/.local/share/im-bridge/dsh/runtime`, pinned to an exact version. Query the
available version first and pin the result; do not install a floating range.
Upgrades are manual: run the setup script again, verify, then keep or roll back.
No automatic or scheduled upgrade.

The installer writes to a `staging` sibling of `runtime` and renames it into
place only after the tree is complete and its version verified. The previous
runtime is kept as `runtime.previous` until the service answers on its port, so
a failed upgrade restores the working version.

Rationale: dsh is an independent long-lived service with its own release cadence.
A pinned version makes a restart reproducible.

The package manager is not interchangeable here. dsh 0.1.1-rc.2 declares only two
of the `@deepseek-ai/dsh-client-ui-*` plugins that its boot configuration imports
dynamically. pnpm's strict layout exposes that gap: the process exits within
three seconds with `ERR_MODULE_NOT_FOUND`. npm's flat `node_modules` hoists the
undeclared plugins where the loader finds them, and dsh then listens on
`127.0.0.1:3080`. Measured 2026-08-24 against the same version. This is a
workaround for an upstream packaging defect; revisit it when dsh declares its
plugin dependencies completely.

A private directory is used rather than a global install because the wizard must
not own a shared npm prefix, and because a directory rename gives an atomic swap
and a cheap rollback. `npx` is excluded because it hangs without output.

### Process supervision

Run two separate user LaunchAgents, one for dsh and one for the bridge. Both
start at user login. Both restart only on abnormal exit, so a deliberate stop
stays stopped for maintenance.

Rationale: the two services fail and upgrade independently. A single agent would
couple their restarts and interleave their logs. A system-level daemon would
require administrator rights for no benefit on a single-user machine.

### Startup ordering

The bridge does not depend on start order. It retries its dsh connection with
bounded backoff, which also covers dsh restarting underneath a running bridge.

Rationale: a start-order guarantee would only solve the boot race, while the
reconnect path is needed anyway for mid-session restarts. One mechanism covers
both cases.

### Credentials

The Telegram bot token and the numeric user allowlist will live in an env-format file
at `~/.config/im-bridge/env` with mode 600. The bridge setup script will read both
interactively with terminal echo disabled, so neither value reaches a command
line, a shell history file, or a transcript. The bridge will validate the file at
startup: it checks permissions, required keys, and value format, and exits with
a clear error when a check fails. Token rotation means editing the file and
restarting the bridge; there is no hot reload.

The DeepSeek API key stays where dsh already expects it, `~/.dsh/.env`. It is not
merged into the bridge env file.

Rationale: a narrow file keeps each reader limited to the credentials it needs.
Strict startup validation converts a silent misconfiguration into an immediate,
named failure. Hot reload would add file-watching state to the one component
whose failure mode is unauthorised shell access.

### Logging

Each service writes to its own fixed log file, capped at 10 MB per file with 5
files retained.

Rationale: enough history to diagnose a fault from the previous day, with a
bounded disk cost that needs no attention.

### Repository artifacts

The repository holds credential-free templates and setup scripts. LaunchAgent
property lists and env files are generated into the user's home directory at
setup time and are never committed. The dsh path is implemented now; the bridge
path follows when its event loop is implemented.

## Consequences

- The next user login restores both services without manual steps. A crash
  restarts the affected service only.
- Upgrading dsh is a deliberate act with a recorded version, so a regression can
  be traced to a specific change and reverted.
- The runtime directory holds about 455 packages, so a fresh install takes
  roughly 12 minutes and the disk cost is paid twice during the swap.
- A failed start keeps the dsh log. The setup script prints a filtered, redacted
  tail of it; the full file stays on disk for inspection.
- Rotating the bot token requires a bridge restart, which drops in-flight
  streaming output. This is accepted: rotation is rare and a restart is fast.
- The dsh setup script requires an interactive terminal because it asks for
  confirmation before installing or replacing service files. The future bridge
  setup script will also prompt for the token with echo disabled. Unattended
  installation is not supported.
- Logs older than the retention window are lost. Anything worth keeping longer
  must be copied out.
- Because the templates carry no secrets, a fresh clone cannot start the
  services until the install script has produced the env file.
