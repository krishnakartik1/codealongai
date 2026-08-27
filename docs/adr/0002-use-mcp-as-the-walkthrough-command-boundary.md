# Use MCP as the workspace-safe walkthrough command boundary

CodeAlongAI will expose workspace reads and every validated walkthrough transition through MCP while prohibiting workspace mutation. Native VS Code navigation controls call the same extension-owned handlers in-process, but the deterministic walkthrough driver commits question outcomes and graph patches through the real loopback Streamable HTTP endpoint; a future TrueForge model can use that same producer path without replacing the session core or UI.

## Considered Options

A snapshot-only MCP endpoint plus an extension-only producer contract would make the future model path a second integration. Sending every native Back, Next, and Destinations action through loopback HTTP would add transport coupling without testing the producer seam, so those controls remain in-process adapters over the same handlers.

## Consequences

Human-originated start, replacement, reset, and question requests use single-use authority tokens, and session writes use session revisions. The endpoint may request changes to the memory-only walkthrough session but never owns that session or changes source documents. Starting and generating a walkthrough requires the MCP switch to be enabled.
