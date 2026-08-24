# Domain Context

## Glossary

### backend

A coding agent harness controlled by the bridge. The current backend is `dsh`.

### session

A backend-owned, persisted conversation. The backend assigns its stable id. A session can exist without a linked platform thread.

### platform

An instant messaging service connected to the bridge. The current platform is Telegram.

### thread

A platform-owned conversation container. In Telegram, a thread is a private-chat topic identified by `message_thread_id`.

### link

A persisted one-to-one mapping between a thread and a session. Links are the bridge's only required persistent state.

### turn

One complete exchange from a user prompt through the terminal backend result.

### backend event

A transient, normalized fact emitted by a backend during a turn. Platform code consumes backend events without knowing the backend's native protocol.
