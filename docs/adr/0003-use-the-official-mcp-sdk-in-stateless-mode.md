# Use the official MCP TypeScript SDK in stateless mode

CodeAlongAI will pin the official MCP TypeScript SDK v2 packages and serve a stateless Streamable HTTP endpoint at `http://127.0.0.1:<port>/mcp` from the desktop VS Code UI extension host. The endpoint supports the SDK's 2026 protocol and stateless 2025 compatibility mode, rejects the older SSE-only transport, validates loopback Host and Origin before dispatch, and permits only one in-flight `tools/call`. This keeps the endpoint free of transport-owned state while the extension remains authoritative for the walkthrough session; interrupted or overlapping work is handled through request identity, session revisions, and idempotent receipts rather than MCP transport sessions.

## Considered Options

A stateful MCP transport would offer resumable streams and connection-scoped features that CodeAlongAI does not use, while adding session storage, reconnect, and shutdown responsibilities. The previously tested monolithic SDK v1.30.0 remains maintained, but v2 is the current stable line and supports the legacy protocol needed by pinned TrueForge 0.1.4. That compatibility was re-proved on native Windows before the final MCP specification was synthesized.

## Consequences

Clients initialize and discover tools again after reconnect and retry interrupted calls instead of resuming streams. CodeAlongAI's future TrueForge agent configuration must disable parallel tool calls, and the server still rejects a second overlapping tool call with a retryable error. The endpoint binds only to IPv4 loopback, runs only in the local desktop UI extension host, and exposes no health or debug route.
