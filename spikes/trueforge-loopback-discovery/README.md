# TrueForge loopback MCP discovery spike

This disposable spike answers one question: can pinned TrueForge 0.1.4
register, initialize, discover, disconnect from, and rediscover a separately
running loopback Streamable HTTP MCP fixture without a model?

The fixture exposes exactly one inert `ping` tool. The runner starts TrueForge
and the fixture as independent processes, registers the fixture through
TrueForge's public settings API, and asks TrueForge's public discovery API for
the tool schema. It then stops only the fixture, requires discovery to fail,
restarts only the fixture, and requires discovery to succeed again. Fixture
instrumentation verifies that each successful discovery sent `initialize` and
`tools/list`, and that no `tools/call` occurred.

## Run

Requirements: Node.js 22.14 or newer and free loopback ports.

```bash
cd spikes/trueforge-loopback-discovery
npm ci
npm run spike
```

The runner chooses unused loopback ports, keeps TrueForge state in a temporary
SQLite database, shortens MCP failure timeouts, prints a JSON result, and
removes the database after both child processes stop. It does not configure a
provider, agent, session, model turn, authentication, editor access, filesystem
access, or a domain tool.

The MCP SDK and TrueForge dependencies are exact-pinned in `package-lock.json`.
This spike is evidence for later topology decisions, not extension production
code and not the eventual CodeAlongAI MCP contract.

## Observed result

Verified on August 27, 2026 with Node.js 22.22.1 on Linux:

| Check | Result |
| --- | --- |
| Connector registration | HTTP 200 |
| Initial discovery | HTTP 200, exactly `ping` |
| Discovery while fixture was stopped | HTTP 502 |
| Discovery after restarting only the fixture | HTTP 200, exactly `ping` |
| First fixture process | 1 `initialize`, 1 `tools/list`, 0 `tools/call` |
| Restarted fixture process | 1 `initialize`, 1 `tools/list`, 0 `tools/call` |

This live result establishes the pinned public seam on local Linux. The runner
avoids shell-specific launch syntax so it can be rerun on Windows, but Windows
behavior is not claimed until that run is performed there.
