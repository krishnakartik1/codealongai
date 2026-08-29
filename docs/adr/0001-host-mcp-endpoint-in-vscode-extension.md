# Host the MCP endpoint in the VS Code extension host

CodeAlongAI will host its default-off, loopback Streamable HTTP MCP endpoint inside the laptop-local Node.js VS Code extension host. This keeps VS Code authoritative for editor state and the extension authoritative for the walkthrough session; the endpoint delegates workspace reads and validated walkthrough transitions to extension-owned handlers and owns no independent domain state. Extension-owned collaborators connect through an internally allocated loopback port.

## Considered Options

A separately launched service would have no useful state without CodeAlongAI. An extension-supervised child process would add packaging, process supervision, and IPC while still depending on the extension. Hosting the endpoint in the extension host gives up process isolation but removes both failure seams for the model-free hackathon.

## Consequences

The extension switch starts and stops the endpoint with the extension lifecycle. CodeAlongAI cannot start or generate a walkthrough while the endpoint is disabled. The endpoint remains discoverable while enabled when no walkthrough session exists and reports that no walkthrough is active. The extension allocates an IPv4 loopback port internally and retries transient allocation failures up to three times; that port is not a contributed setting or operator responsibility. This narrowly supersedes the former stable configurable-port consequence while preserving extension-host ownership and loopback transport. The hackathon assumes one VS Code window; multi-window endpoint coordination is deferred.
