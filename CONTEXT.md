# CodeAlongAI

CodeAlongAI is a guided code-learning context that keeps the human's real editor activity distinct from CodeAlongAI's walkthrough attention and explanations.

## Language

**Editor state**:
The human's actual workspace and interaction state: documents, visible editors, focus, cursor, and selection. It remains distinct from CodeAlongAI attention and is never impersonated by CodeAlongAI.
_Avoid_: Extension state, UI state

**Walkthrough session**:
The active learning context containing the walkthrough graph, immutable human origin, named CodeAlongAI attention, visited stops, and per-stop conversations.
_Avoid_: MCP session, editor session

**Walkthrough producer**:
The source of origin descriptors, walkthrough graph data, and question outcomes offered to a walkthrough session. It proposes content but does not own or mutate the session.
_Avoid_: Model, MCP producer

**Walkthrough request**:
A single-use, human-initiated intent to create or replace a walkthrough session, or to answer a question at one stop. It binds a producer result to the editor action that authorized it.
_Avoid_: Model request, MCP request

**Walkthrough transition**:
A validated change to a walkthrough session, such as creation, branch generation, attention movement, or reset. It changes learning context without changing source documents.
_Avoid_: Workspace write, file mutation

**Request snapshot**:
An immutable view of a walkthrough session and relevant editor state used to answer one integration request. It is a projection, never an independent authority.
_Avoid_: Server state, session copy

**Stop excerpt**:
The source text within a walkthrough stop's anchored range as observed for one request. It supplies bounded code context without granting access to arbitrary documents or the wider workspace.
_Avoid_: File contents, workspace contents

**MCP endpoint**:
The workspace-safe boundary through which an MCP client reads CodeAlongAI context and requests validated walkthrough transitions. It owns no walkthrough session or editor state and never authorizes workspace mutation.
_Avoid_: MCP companion, standalone MCP service

**Workspace mutation**:
A change to source-document contents or workspace files. It is outside the CodeAlongAI MCP boundary even when walkthrough transitions are allowed.
_Avoid_: Walkthrough write, session transition
