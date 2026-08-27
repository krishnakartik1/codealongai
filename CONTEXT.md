# CodeAlongAI

CodeAlongAI is a guided code-learning context that keeps the human's real editor activity distinct from CodeAlongAI's walkthrough attention and explanations.

## Language

**Editor state**:
The human's actual workspace and interaction state: documents, visible editors, focus, cursor, and selection. It remains distinct from CodeAlongAI attention and is never impersonated by CodeAlongAI.
_Avoid_: Extension state, UI state

**Walkthrough session**:
The active learning context containing the walkthrough graph, immutable human origin, named CodeAlongAI attention, visited stops, and per-stop conversations.
_Avoid_: MCP session, editor session

**Request snapshot**:
An immutable view of a walkthrough session and relevant editor state used to answer one integration request. It is a projection, never an independent authority.
_Avoid_: Server state, session copy

**MCP endpoint**:
The read-only boundary through which an MCP client requests information from the active CodeAlongAI context. It exposes request snapshots and owns no walkthrough session or editor state.
_Avoid_: MCP companion, standalone MCP service
