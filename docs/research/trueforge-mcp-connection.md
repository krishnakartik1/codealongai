# TrueForge MCP connection seam

Research date: 2026-08-27  
Repository under study: `krishnakartik1/codealongai`  
TrueForge source revision inspected: [`c40129c9`](https://github.com/truefoundry/trueforge/commit/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9)  
Published runtime exercised: `@truefoundry/trueforge@0.1.4` (`latest` on the research date)

## Answer

TrueForge is the open-source `truefoundry/trueforge` agent harness. In this repository it is not part of the current extension: the completed model-free map explicitly placed “a real model, TrueForge, MCP ... or provider integration” outside its destination and reserved those concerns for a separate seam spike ([CodeAlongAI map](https://github.com/krishnakartik1/codealongai/issues/1)). The human gate then returned NO-GO and said a TrueForge seam spike was not justified by that version of the prototype ([gate resolution](https://github.com/krishnakartik1/codealongai/issues/9#issuecomment-5437196612)).

The seam can nevertheless be investigated without adding a model. TrueForge has a public tool-discovery endpoint, `GET /api/v1/mcp-servers/{name}/tools`, that connects to a configured MCP server, initializes MCP, and performs `tools/list` ([route contract](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge/src/routes/mcpServerRoutes.ts#L160-L202), [handler](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge/src/apis/mcpServers.ts#L374-L416)). It does **not** expose a public direct `tools/call` endpoint. Tool invocation occurs inside an agent turn after a model emits a tool call ([invocation path](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge-core/src/core/mcp/executeToolCalls.ts#L73-L105)). Therefore the smallest model-free spike should prove registration, connection, initialization, and discovery—not invocation.

## Version warning

There is meaningful release drift. On the research date:

- `npx @truefoundry/trueforge@latest` installed and identified itself as `0.1.4`.
- npm reported `latest: 0.1.4` and `rc: 0.2.0-rc.0`.
- the inspected `main` revision declared `0.2.0-rc.0` and contained commits newer than the published `latest` package ([package manifest](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge/package.json#L1-L23)).

The observations below distinguish the exercised `0.1.4` behavior from source-derived behavior. Any implementation spike should pin the selected package version; `@latest` is not a reproducible dependency.

## Connection facts

### Server shape and transports

- Configured MCP servers are currently `type: "remote"` and require a URL. The manifest has no `command`, `args`, environment, or `stdio` shape ([manifest schema](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge/src/schemas/mcpServer.ts#L13-L59)). TrueForge therefore does not launch or supervise a CodeAlongAI MCP subprocess through this connector contract. The MCP server must already be reachable over HTTP.
- The client probes Streamable HTTP first and legacy SSE second. A previously known transport is tried first, with the other used as fallback. The configured manifest does not select the transport explicitly ([transport client](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge-core/src/core/mcp/remoteMcpClient.ts#L1-L26), [probe loop](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge-core/src/core/mcp/remoteMcpClient.ts#L132-L193)).
- Connection timeout defaults to 30 seconds; an individual MCP request defaults to four minutes. Both are process environment settings (`MCP_CONNECT_TIMEOUT_MS`, `MCP_REQUEST_TIMEOUT_MS`) ([configuration](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge/src/config.ts#L331-L340), [defaults](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge/src/config.ts#L498-L509)). A connection spike should lower these so a bad loopback address fails quickly.

### Configuration

- A connector can be registered in **Settings → Connectors**, or through `POST`/`PUT /api/v1/settings/mcp-servers`. A configured manifest contains `type`, `name`, `url`, `description`, and optional auth ([official connector guide](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/docs/mcp-servers.mdx#L8-L26), [create/replace routes](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge/src/routes/mcpServerRoutes.ts#L92-L158)).
- Shipped YAML catalog entries are discovery presets only; connecting one copies it into persistent configuration. A custom URL does not need a catalog entry ([initial-setup docs](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/docs/harness/initial-setup.mdx), [catalog source](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge/catalog/mcp-catalog.yaml#L1-L4)). CodeAlongAI therefore does not need to modify TrueForge's catalog for the spike.
- Local mode is one TrueForge process with SQLite and no login by default. Official guidance says to keep it on localhost; Node.js 22.14 or newer is required ([quickstart](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/docs/quickstart.mdx#L8-L27)).

### Launch and lifecycle

- Starting TrueForge does not connect every configured MCP server. A remote MCP object is created per turn, and the network connection is opened lazily by `listTools` or `callTool` ([turn resource resolver](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge-core/src/agent-session/TurnResourceResolver.ts#L155-L195), [lazy connection](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge-core/src/core/mcp/RemoteMCP.ts#L224-L285)). The standalone discovery endpoint constructs the same remote client on demand.
- Stateful Streamable HTTP session IDs are retained and can be resumed across turns. A session-expired error causes one fresh reconnect; transport close/error marks the connection unavailable ([remote lifecycle](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge-core/src/core/mcp/RemoteMCP.ts#L135-L159), [connection state](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge-core/src/core/mcp/RemoteMCP.ts#L224-L285)).
- Current source deliberately does not close per-turn MCP connection objects when the turn resource resolver closes; the turn abort signal cancels in-flight work and the objects are dropped ([resolver close contract](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge-core/src/agent-session/TurnResourceResolver.ts#L133-L153)). A local test server should tolerate client disconnects and abandoned sessions rather than relying on a deterministic shutdown notification.
- TrueForge itself handles `SIGINT`/`SIGTERM` by draining active turns and HTTP connections before exiting ([server shutdown](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge/src/main.ts#L334-L385)). That does not imply lifecycle ownership of the separately launched MCP server.

### Discovery and invocation

- `GET /api/v1/mcp-servers/{name}/tools` returns every tool entry supplied by MCP `tools/list`. It is the public, model-free connection check ([API contract](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge/src/routes/mcpServerRoutes.ts#L160-L202)).
- At runtime, TrueForge caches the raw tool list per remote connection. Eager tools are translated into model function schemas; deferred servers are skipped until requested ([tool cache](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge-core/src/core/mcp/RemoteMCP.ts#L161-L194), [tool conversion](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge-core/src/core/mcp/convertMCPServers.ts#L23-L94)).
- An agent attaches a configured server by name and can enable, disable, preload, or require approval for selected tools. Defaults expose all tools, defer schema loading, and require approval for write/destructive annotations ([agent connector settings](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/docs/create-agent/overview.mdx#L287-L300)).
- When a model emits a tool call, TrueForge maps the sanitized model-facing name back to the original MCP tool name, parses arguments, applies allow/approval policy, and sends `tools/call` through the active MCP connection ([invocation path](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge-core/src/core/mcp/executeToolCalls.ts#L73-L105), [policy gate](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge-core/src/core/mcp/ToolSet.ts#L69-L100)).
- No public REST/SDK route for a caller to directly invoke an arbitrary configured MCP tool was found in the inspected source or generated SDK. Calling TrueForge's internal `RemoteMCP` class would test an implementation detail, not the supported host seam. Model-free invocation is therefore intentionally outside the proposed spike.

### Authentication

TrueForge supports three connector auth states ([official connector guide](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/docs/mcp-servers.mdx#L27-L52)):

- **None:** suitable for the loopback spike.
- **Static headers:** arbitrary configured headers are sent on requests. Values are stored in connector configuration and redacted from settings responses ([schema and resolver](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge/src/schemas/mcpServer.ts#L16-L29), [redaction](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge/src/apis/mcpServers.ts#L54-L96)).
- **OAuth DCR:** TrueForge dynamically registers, stores per-user tokens, refreshes them, and pauses a turn for in-chat authorization when needed. A public callback base URL is required when localhost is not the externally visible origin ([official connector guide](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/docs/mcp-servers.mdx#L27-L52), [authorize API](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge/src/routes/mcpServerRoutes.ts#L204-L255)).

Header auth and OAuth add no evidence needed for the first connection question. They should not be included in the spike.

### Logs and errors

- `LOG_LEVEL` controls the process logger. Standalone mode writes human-readable console lines; hosted mode writes JSON. Both include the TrueForge version ([logger](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge/src/logger.ts#L1-L78), [config](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge/src/config.ts#L290-L299)).
- Tool-discovery failures return `502` for transport/upstream errors, `422` for authentication required, and `404` for an unknown configured server ([route responses](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge/src/routes/mcpServerRoutes.ts#L180-L201), [handler mapping](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge/src/apis/mcpServers.ts#L399-L415)).
- Connection failure messages include each attempted transport and its error. A `401` is rewritten to point at configured MCP headers ([connection errors](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge-core/src/core/mcp/remoteMcpClient.ts#L86-L108), [probe failure](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge-core/src/core/mcp/remoteMcpClient.ts#L152-L193)).
- In the exercised `0.1.4` runtime, a successful discovery produced no MCP-specific console line even at `LOG_LEVEL=debug`; the HTTP response was the positive evidence. A failed discovery produced a warning with the server name, both transport failures, and a stack trace.

## Executed model-free check

This was run against the published `latest` package on Linux. It modified only an isolated SQLite file under `/tmp`, registered temporary connectors in that database, and was stopped with `SIGINT` afterward.

1. Start standalone TrueForge:

   ```bash
   SQLITE_PATH=/tmp/codealongai-trueforge-spike.sqlite \
   LOG_LEVEL=debug \
   npx --yes @truefoundry/trueforge@0.1.4 --port 8879
   ```

   Observed: TrueForge `0.1.4`, standalone mode, SQLite initialized, no login, server listening at `http://localhost:8879`.

2. Register a no-auth remote server using the Exa URL shipped in TrueForge's own catalog ([catalog entry](https://github.com/truefoundry/trueforge/blob/c40129c9a0c9734fb077bf1a8d3d0b73cf2c9de9/packages/trueforge/catalog/mcp-catalog.yaml#L31-L35)):

   ```bash
   curl -sS -X PUT http://localhost:8879/api/v1/settings/mcp-servers \
     -H 'Content-Type: application/json' \
     --data '{"manifest":{"type":"remote","name":"exa-spike","url":"https://mcp.exa.ai/mcp","description":"Temporary no-auth discovery-only connection spike."}}'
   ```

   Observed: HTTP `200`, persisted connector, `auth_status.status: "not_required"`.

3. Ask TrueForge—not the MCP server directly—to discover tools:

   ```bash
   curl -sS http://localhost:8879/api/v1/mcp-servers/exa-spike/tools
   ```

   Observed: HTTP `200` with two schemas, `web_search_exa` and `web_fetch_exa`. No model provider, agent definition, session, or model turn was configured.

4. A deliberately unreachable loopback connector returned HTTP `502` with this useful shape:

   ```text
   Failed to connect ... (tried streamable-http, sse):
   [{"transport":"streamable-http","error":"fetch failed"},
    {"transport":"sse","error":"... fetch failed ..."}]
   ```

This proves the public model-free connection and discovery seam on `0.1.4`. It does not prove CodeAlongAI process reachability, tool invocation, authentication, or Windows behavior.

## Recommended CodeAlongAI connection spike

Use a fresh wayfinder research/task ticket whose decision is only: **Can a pinned local TrueForge process discover a separately running loopback MCP server owned by this prototype?**

The smallest harmless protocol fixture is:

1. Pin the TrueForge version rather than using `latest`.
2. Launch TrueForge in local mode with an isolated SQLite path, short MCP timeouts, and `LOG_LEVEL=debug`.
3. Launch a separate, disposable **Streamable HTTP** MCP server on a fixed loopback port. Give it one inert `ping` tool with no editor, filesystem, shell, network, credential, or model access. Instrument the fixture to record `initialize` and `tools/list` request counts.
4. Register `http://127.0.0.1:<port>/mcp` through `PUT /api/v1/settings/mcp-servers` with no auth.
5. Call `GET /api/v1/mcp-servers/<name>/tools` and require:
   - HTTP `200`;
   - exactly the `ping` schema expected;
   - the fixture observed `initialize` and `tools/list` from TrueForge;
   - no model provider, agent, session, or tool call was created.
6. Stop TrueForge and the fixture independently. Record whether a clean reconnect works after restarting only the fixture.

This spike should not live inside the VS Code extension and should not define CodeAlongAI's eventual tools. It answers process reachability and protocol compatibility before UI/editor authority is coupled to MCP.

Do not add `tools/call`, header auth, OAuth, SSE-only support, Docker networking, VS Code lifecycle ownership, or domain payloads to this spike. Each changes the question.

## Unknowns that remain

- **Public model-free invocation:** no supported TrueForge endpoint was found. Proving a tool call through TrueForge currently requires a normal model-backed turn; direct internal-class use would not prove the public seam.
- **Release stability:** `main` and npm `latest` were not the same release. Behavior must be rechecked against the version the project pins.
- **Successful transport visibility:** the discovery response does not identify whether Streamable HTTP or SSE won, and the exercised successful connection emitted no transport log. A local fixture can establish this by implementing only Streamable HTTP.
- **Windows and VS Code process topology:** the executed check ran on Linux and did not involve an Extension Development Host. Loopback reachability, port ownership, startup ordering, and teardown on the target Windows workflow remain unproven.
- **Container/remote-host networking:** `127.0.0.1` means the TrueForge container itself under Docker/Kubernetes. Only local `npx` mode is covered by the proposed loopback spike.
- **Authentication:** support is established from official docs and source, not by a live connection in this research. It is unnecessary for the first seam decision.
- **CodeAlongAI contract:** no evidence here chooses tools, payloads, events, editor mutation authority, or question/walkthrough semantics. Those decisions should wait until this transport spike resolves.
