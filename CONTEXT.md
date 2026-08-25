# Domain Context

## Glossary

### backend

A coding agent harness controlled by the bridge. The current backend is `dsh`.

### session

A backend-owned, persisted conversation. The backend assigns its stable id. A session can exist without a linked platform thread.

### platform

An instant messaging service connected to the bridge. The current platform is Telegram.

### thread

A platform-owned conversation container. In Telegram, a thread is a private-chat topic identified by the pair `chat_id` and `message_thread_id`.

### link

A persisted one-to-one mapping between a thread and a session.

### turn

One complete exchange from a user prompt through the terminal backend result.

### backend event

A transient, normalized fact emitted by a backend during a turn. Platform code consumes backend events without knowing the backend's native protocol.

### prompt content

One atomic input sent to a session. Prompt content contains text and image parts. Starting a turn and steering an active turn use the same content shape.

### polling checkpoint

The highest Telegram update id whose business effects completed or were isolated as a dead letter. The bridge persists this checkpoint before requesting later updates.

### dead letter

A Telegram update isolated after its processing retry limit is exhausted. A dead letter preserves the update id and a bounded failure summary so polling can continue without silently losing the failure.
