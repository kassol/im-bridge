# ADR 0002: dsh backend adapter protocol and buffering

Date: 2026-08-24

Status: accepted

## Context

The bridge needs a dsh adapter that implements the backend contract without
exposing dsh-specific protocol details to platform code. dsh 0.1.1-rc.2 has
three properties that shape the adapter:

- Unary commands use HTTP POST with a repeated method name in the URL and the
  `client-request` body envelope.
- Runtime events use two read-only WebSocket downlinks: `/api/events.mux` for
  session events and approvals, and `/api/events.host` for session status and
  agent errors. A normal HTTP GET to these paths returns `upgrade required` in
  the deployed server.
- dsh queues downlink frames without a bound, so a slow bridge consumer can
  grow dsh memory without limit.

Approval requests are server requests carried on the mux downlink. The answer is
a `client-response` POST to `/api/respond` with the same `rpcId`; its value must
include `sessionId`, `approvalId`, and an outcome. Multiple clients can answer,
and the first answer wins.

A live probe against dsh 0.1.1-rc.2 confirmed the session event sequence and
payload shapes used below. The probe sessions were removed after capture.

## Decision

### Backend contract

The backend contract has six actions:

- `listSessions()`
- `createSession(cwd)`
- `sendPrompt(sessionId, text)`
- `subscribe(handler)`
- `respondApproval(requestId, approved)`
- `close()`

`close()` stops reconnect loops, closes downlinks, clears pending approvals, and
waits for dispatch work to stop.

ADR 0003 supersedes this list. The contract now has seven actions: `sendPrompt`
and `steer` both take prompt content, an ordered list of text and image parts.
The adapter maps `sendPrompt` to `session.prompt` with queue mode and `steer` to
the same call with steer mode. Every other decision in this ADR still holds, and
`steer` shares the prompt request timeout.

### Construction and cwd security

`DshBackend` publicly accepts only its base URL, an injected logger, and one or
more allowed cwd roots. Queue sizes, request timeouts, and retry timing remain
module policy, not public configuration.

`createSession(cwd)` resolves the target and every allowed root with `realpath`.
The target must already exist, must be a directory, and must be inside or equal
to an allowed root. The adapter never creates the directory. This check is in
the adapter so no caller can bypass the shell-access boundary.

### Unary HTTP

Each request uses a fresh `rpcId` and POSTs JSON to `/api/<method>` with:

```json
{"type":"client-request","rpcId":"...","method":"session.list","payload":{}}
```

`listSessions` and `createSession` time out after 10 seconds. `sendPrompt` and
`respondApproval` time out after 30 seconds. Prompt success means dsh accepted
the prompt; turn completion arrives through events. When dsh is unavailable,
unary actions fail immediately with a clear error and are not queued.

### Downlink lifecycle

The first subscriber opens both WebSocket downlinks. The final unsubscribe
closes them, stops reconnecting, and clears pending approvals, turn caches,
active-turn markers, and cached session status. A later subscriber starts fresh
connections and cannot answer request ids from the earlier subscription.
`close()` permanently closes the adapter.

Unexpected disconnects reconnect with exponential backoff from 1 second to 30
seconds, with jitter. A successful connection resets the delay. An accepted
prompt marks its session active before the first output chunk can arrive. A mux
disconnect emits one terminal error for each active session and each session
with a pending approval. Pending approvals become invalid immediately.
`turn/end` and host agent errors clear the active marker.

### Event mapping

The mux downlink maps:

- `assistant/chunk` with `text-delta` to `output`
- `assistant/chunk` with `reasoning-delta` to `thinking`
- `assistant/message` to the complete assistant-message cache for that turn
- `turn/end` to `turn-end`, using the cached complete assistant text
- `approval/requested` to `approval`, while caching its rpc/session/approval ids
- `question/requested` to a terminal error because interactive questions are
  outside v1

If `turn/end` arrives without a complete assistant message, the adapter emits an
error and then an empty `turn-end` so platform state still closes. A
`host/agent-error` frame emits a terminal error and clears that session's turn
cache. Host status frames update session running state. Unknown events are
ignored and counted in diagnostics.

Approval rejection maps to `rejected`; approval maps to `allowed-once`. A
response that loses the multi-client race is normal completion and is logged,
not thrown as a user-facing failure.

### Bounded fan-out

Each subscriber owns a separate queue for each session. Each queue holds at most
64 normalized events. Each normalized `output` or `thinking` delta holds at most
8,192 UTF-16 code units. Consecutive deltas of the same type coalesce only up to
that limit. Truncating either one incoming delta or a coalesced delta uses the
same once-per-turn incomplete-output warning as queue overflow. A slow
subscriber never blocks either downlink or another subscriber.

When a queue is full, the adapter discards the oldest stream delta first. It
coalesces repeated warning and error events by type and deduplicates approval
events by request id. The first discarded delta in a turn inserts one
non-terminal `warning` telling the platform that streamed output is incomplete.
The overflow marker resets only when that turn ends.

The wire protocol does not limit the number of distinct concurrent approval
requests. A fixed queue cannot retain more than 64 distinct approvals. If a
subscriber's session queue still fills after deduplication, the adapter removes
the queued approvals for that session from every subscriber and inserts one
terminal approval-overload error for each subscriber. Later approvals for that
session are suppressed until `turn-end`; the latest `turn-end` is retained after
the overload error so platform state closes in order. The adapter also removes
the corresponding pending approval mappings because it has terminated the
approval flow for the current turn. Handler exceptions are logged and dispatch
continues.

### Validation and diagnostics

Wire data is validated with local type-narrowing functions. Known envelopes and
mapped frames are strict about required fields while allowing unrelated new
fields. Malformed known data is logged as a warning and skipped; it does not tear
down a healthy downlink. Unknown session events are ignored and logged at debug
level with a cumulative count.

The adapter accepts an injected logger and defaults to `console`. Protocol
errors, retries, unknown-event counts, approval races, overflows, and handler
exceptions are internal diagnostics. Connection errors do not become backend
errors unless they invalidate a pending approval or terminate an active turn.

### Tests

Default tests use local fake HTTP and WebSocket servers. They cover envelopes,
timeouts, reconnects, both downlinks, event mapping, approval responses, cwd
containment, queue overflow, ordering, multiple subscribers, and close
semantics.

A separate explicit live probe verifies dsh list/create, both downlink
handshakes, and cleanup. A model-driven turn probe is opt-in because it incurs
API cost.

## Consequences

- Platform code sees one stable backend vocabulary and no dsh wire types.
- Memory use is bounded by active subscribers, active sessions, and the fixed
  queue capacity.
- A slow Telegram renderer may lose intermediate deltas. An approval flood
  terminates that session's turn visibly when 64 distinct queued approvals
  cannot be retained. Terminal state remains ordered and bounded.
- Two downlinks and approval correlation add adapter state, but avoid polling and
  preserve dsh's native running/error signals.
- Interactive dsh questions remain unsupported in v1 and terminate the current
  remote turn visibly.
- Changing queue capacity, retry policy, or event mappings requires a code
  change and tests; these policies are intentionally not runtime configuration.
