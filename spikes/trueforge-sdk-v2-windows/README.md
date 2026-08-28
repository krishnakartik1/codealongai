# TrueForge MCP SDK v2 Windows discovery spike

This disposable spike answers one question: on native Windows, can pinned
TrueForge 0.1.4 register, initialize, discover, disconnect from, and rediscover
a separately running one-tool loopback Streamable HTTP fixture built with the
official MCP TypeScript SDK v2 packages, without a model?

The fixture exposes exactly one inert `ping` tool through pinned
`@modelcontextprotocol/server@2.0.0` and
`@modelcontextprotocol/node@2.0.0`. Its HTTP entry explicitly selects the SDK's
stateless 2025 compatibility path. The runner starts TrueForge and the fixture
as independent processes, registers the fixture through TrueForge's public
settings API, and asks TrueForge's public discovery API for the tool schema. It
then stops only the fixture, requires discovery to fail, restarts only the
fixture, and requires discovery to succeed again.

Fixture instrumentation verifies that each successful discovery sent
`initialize` and `tools/list`, used a 2025 protocol revision without an MCP
session header, and sent no `tools/call`.

## Native Windows run

Requirements: native Windows, Git, Node.js 22.14 or newer, and two free
loopback ports. Run from PowerShell, not WSL:

```powershell
git clone --branch spike/trueforge-sdk-v2-windows --single-branch https://github.com/krishnakartik1/codealongai.git codealongai-trueforge-v2-spike
Set-Location codealongai-trueforge-v2-spike/spikes/trueforge-sdk-v2-windows
npm ci
npm run spike 2>&1 | Tee-Object -FilePath windows-run.txt
```

Keep `windows-run.txt`. A passing run ends with a JSON object whose `result` is
`PASS`; it records Windows, Node.js, TrueForge, and both MCP SDK versions plus
all discovery and fixture observations needed by the Wayfinder decision.

## Linux preflight

The asset itself passed on Linux with Node.js 22.22.1 before the Windows
handoff. TrueForge requested protocol `2025-11-25`; both fixture processes saw
one `initialize`, one `tools/list`, zero `tools/call`, and zero MCP session
headers. Registration, initial discovery, disconnected discovery, and
rediscovery returned HTTP 200, 200, 502, and 200 respectively. This is only a
runner preflight; the decision still requires the native-Windows output.

## Native Windows result

The required native-Windows run passed on August 28, 2026 with Node.js 22.23.2
on Windows_NT 10.0.26200 x64. The exact machine-readable output is archived at
[`evidence/windows-2026-08-28.json`](evidence/windows-2026-08-28.json).

The runner chooses unused IPv4 loopback ports, binds both processes explicitly
to `127.0.0.1`, keeps TrueForge state in a temporary SQLite database, shortens
MCP failure timeouts, and removes the database after both child processes
stop. It configures no provider, agent, session, model turn, authentication,
editor access, filesystem access, or CodeAlongAI domain tool.

Pinned TrueForge 0.1.4 delegates migrations to a Kysely file provider that
passes native absolute paths directly to dynamic `import()`. Node.js rejects a
Windows drive-letter path there because ESM imports require a `file:` URL. On
Windows only, this runner installs a local Node loader that converts absolute
filesystem paths with `pathToFileURL` before TrueForge starts. The installed
TrueForge and Kysely packages remain unchanged. This is a spike compatibility
shim, not a CodeAlongAI product path convention; product code must use
cross-platform Node path and URL APIs directly.

This is verification evidence, not extension production code and not the
eventual CodeAlongAI MCP implementation.
