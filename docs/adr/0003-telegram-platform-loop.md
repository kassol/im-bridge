# ADR 0003: Telegram platform loop and delivery semantics

Date: 2026-08-24

Status: accepted

## Context

The first platform loop must connect private Telegram topics to dsh sessions
without exposing the machine to unapproved users, duplicating agent actions after
a crash, or allowing Telegram rate limits to build an unbounded backlog.

Telegram Bot API 10.2 provides Rich Messages. `sendRichMessageDraft` streams
structured blocks to private topics, and `sendRichMessage` persists up to 32768
UTF-8 characters. This differs from the 4096-character limit of plain
`sendMessageDraft` and `sendMessage`. The verified schema is recorded in
`docs/research/telegram-rich-messages.md`.

Telegram update handling and dsh prompt acceptance cannot share one atomic
transaction. A crash can therefore force a choice between possibly repeating an
agent action and possibly asking the user to resend one prompt.

## Decision

### Thread and link management

The bridge operates only in private-chat topics. It silently drops every update
from a user outside the allowlist before performing any other processing. An
authorised message in the private main chat tells the user to create or enter a
topic. Group and channel updates are ignored.

An unlinked topic discards the triggering message and displays an inline menu:
create a session from a configured cwd alias, or bind an existing unlinked
session. Existing sessions are paged eight at a time and shown by title, or by
cwd alias plus the last eight session-id characters. Real cwd paths are never
shown.

A link is strictly one-to-one in both directions. Rebinding requires an explicit
unlink first. `/manage` opens the current menu; `/start` explains the topic
entry point. Menus include a close button. Unknown commands from authorised
users get a short correction and a `/manage` action.

Callbacks encode a process epoch plus a stable session id or cwd alias. They do
not use mutable list indexes. Every click rechecks the allowlist, callback epoch,
current link, available sessions, and configured cwd alias. Restart makes old
buttons expire. Repeated clicks edit the original menu into its current state
and never duplicate a link or session creation.

An active turn blocks unlink. Unlink never deletes the backend session. A link
to a session deleted outside the bridge is shown as invalid and offers explicit
unlink and repair; it is not silently removed.

### Backend prompt content and steer

The Backend contract gains a seventh action, `steer(sessionId, content)`. Both
`sendPrompt` and `steer` accept the same prompt content: an ordered list of text
and image parts. A normal message starts a turn when the linked session is idle.
Text or images received while it is running automatically steer the active
turn, followed by a short Telegram acknowledgement.

At startup, `listSessions().running` restores active status. Events from linked
sessions are rendered even when the turn began in dsh Web UI. Events are always
routed through the link that exists when the event arrives. Unlinked events are
logged and dropped. An unlinked approval remains pending for another dsh client;
the bridge does not answer it.

### Image input

The bridge accepts plain text and JPEG, PNG, or WebP images sent as Telegram
photos or image documents. One prompt contains at most four images, each at
most 5 MiB after download. For a Telegram photo, it selects the largest variant
whose advertised size fits, then still enforces the hard streaming limit. Image
documents may preserve their filename in the image part. A caption is the text
part; an image without a caption uses a fixed Chinese request to analyse it.
Images are also valid steer content.

Telegram albums are collected by `media_group_id` until a one-second quiet
window closes, then sent as one atomic prompt. One failed image fails the whole
prompt. Album updates form one checkpoint unit.

Downloads stream into memory and abort as soon as they exceed 5 MiB; the bridge
does not trust Content-Length. Image buffers never reach disk, logs, or dead
letters and are released after the backend request. A global 20 MiB semaphore
bounds original image buffers.

### Update ordering and durable processing

Updates are serial within one thread and run across at most four threads. A
polling checkpoint advances only through the highest contiguous sequence of
updates that completed or became dead letters. `getUpdates` uses a 50-second
long-poll timeout, a 60-second HTTP timeout, and reconnect backoff from one to
30 seconds.

The bridge persists update processing state before a backend or Telegram side
effect. A bounded, non-sensitive step state records completed effects, returned
entity ids, and final-message part counts so retries in the same process resume
from a known step. Retries never persist prompt or image content. This chooses
duplicate prevention over guaranteed prompt delivery. If the process crashes
after the marker and before the effect, startup moves the processing record to a
dead letter and tells the authorised topic that the previous input may not have
been sent and must be resent.

A processing failure retries at most three times within the same process, using
the recorded step state. Processing retries never continue across restart
because the bridge cannot prove which external effect completed before the
crash. Continued failure writes a dead letter and allows the checkpoint to
advance. Dead letters contain only the
update id, update kind, thread identifiers, bounded error code/summary, and
timestamps. They never contain prompt text, image data, token values, or the
full update. Records expire after 30 days and are visible through a local
`dead-letters list` CLI command.

SQLite `user_version` controls migrations. Schema v2 adds a unique backend /
session constraint, polling checkpoint, processing records, and dead letters.
Migration stops with a report if existing links violate one-to-one session
ownership; it never guesses which link to delete.

### Streaming and final output

The first thinking or output delta creates a Rich Message draft. The bridge
updates it no faster than once per second and honours Telegram `retry_after`.
The draft uses structured blocks: a Telegram `thinking` block contains at most
the latest 2000 characters of reasoning, and parsed output blocks fill the
remaining conservative 30000 UTF-8-character budget. When earlier output is
omitted, the draft says that the complete result will follow.

Thinking is never persisted in the final message. `turn-end.text` is the final
source of truth; accumulated deltas are preview state only. The final result is
sent with `sendRichMessage({markdown})`. Results over a conservative 32000 UTF-8
characters are split with `marked@18` lexer tokens. Block boundaries are kept;
oversized code fences split by line and repeat a safe fence and language. Parts
carry `[N/M]`. A mid-sequence failure stops later sends, preserves successful
parts, and reports the exact sent count.

Steer acceptance, warning, and terminal error are visible as short Chinese
messages. A normal turn does not create separate start/status messages.

### Approval UI

An approval posts the tool name and reason with `允许一次` and `拒绝` inline
buttons in the linked topic. Any allowlisted user may answer; links have no
owner. The click is revalidated and immediately removes the keyboard. A request
already handled by another dsh client edits the original approval to say so and
does not create a second system error.

### Telegram API failure policy

Idempotent reads, file downloads, and draft updates retry at most three times
with exponential backoff. Every 429 waits the full `retry_after`. Final Rich
Message sends retry only when failure proves the request did not reach Telegram;
an ambiguous lost response is not retried because it could duplicate a final
message.

A final-delivery failure does not rerun the backend turn. The bridge keeps the
draft and attempts one short error in the topic, then records diagnostics. A
partial multi-message result is never resent as a group.

### Configuration, logging, and lifecycle

A mode-0600, current-user-owned JSON file stores the bot token, non-empty user
allowlist, cwd aliases, database path, dsh URL, and log level. LaunchAgent passes
only the config path. Aliases are unique case-insensitively, 1-32 ASCII letters,
digits, hyphens, or underscores. Startup resolves every path and fails on any
invalid token, permission, alias, directory, or config field. `getMe` must
confirm threaded mode.

Logs are JSON Lines at info level by default. They may contain stable ids, event
names, bounded error codes/summaries, and durations. They never contain tokens,
prompt text, images, or complete Telegram/dsh payloads.

SIGTERM and SIGINT abort long polling, stop new work, immediately close pending
album windows, wait up to 20 seconds for active update/media/send work, close the
backend, and finally close SQLite. Work still marked processing remains so
startup recovery can isolate and notify it.

### Verification and deployment

Default tests use fake Telegram HTTP, fake backend, temporary SQLite files, and
controlled clocks. They cover allowlist-first filtering, menus and stale
callbacks, one-to-one links and migration, update crash semantics, album
atomicity and memory limits, per-thread ordering, steer, approval races, Rich
drafts, Markdown splitting, retry classes, and shutdown.

A wizard configures the real bot and creates a dedicated test topic. It must
prove `sendRichMessageDraft` blocks and `sendRichMessage` work before installing
the LaunchAgent. Full E2E then covers menu binding, text, images, steer,
approval, long output, and restart recovery. A few real DeepSeek turns and one
harmless approval are authorised. Deployment occurs only after all tests pass.

## Consequences

- The bridge avoids duplicate agent actions across restart windows; a narrow
  crash window asks the user to resend instead.
- Persistent state now includes links, polling checkpoints, processing records,
  and dead letters.
- Rich Message support is a deployment prerequisite. There is no plain-message
  fallback with different rendering semantics.
- Prompt content and steer expand the Backend contract and require a dsh adapter
  change before the Telegram loop can consume images.
- The implementation spans platform API, storage migration, event orchestration,
  configuration, wizard, and LaunchAgent deployment, so it must be split into
  dependency-ordered tickets after a written spec.
