# CodeAlongAI

CodeAlongAI is a VS Code extension for guided code learning. Its walkthrough
session and editor state stay in the extension; when the operator enables the
integration, an owned local TrueForge sidecar produces grounded walkthrough
updates through the existing read-only loopback MCP boundary. Daytona is the
only supported version-1 producer sandbox and never receives the workspace or
provider credentials.

## Local development

Requirements: Node.js 22 and desktop VS Code.

```bash
npm install
npm run build
npm run typecheck
```

Open this repository in VS Code, run the `Run CodeAlongAI` launch configuration,
and run `CodeAlongAI: Configure TrueForge`. The local loopback MCP endpoint is
enabled by default; disable the window setting `codealongai.mcp.enabled` only
when you explicitly need it off. Configure the model-provider and Daytona credentials only
in the opened TrueForge UI (the Daytona key needs `sandboxes` and `snapshots`
permissions), then configure a fully qualified `codealongai.trueforge.model`
and compatible `codealongai.trueforge.reasoningEffort`. Choose `CodeAlongAI:
Ask about this code` from the Command Palette in the Extension Development Host.

## Origin walkthrough

In `checkout.ts`, select code (or place the cursor on a nonblank line), then run
`CodeAlongAI: Ask about this code`. CodeAlongAI uses its local loopback MCP
endpoint to create an origin-only, read-only walkthrough and renders its first
native comment thread. It never edits workspace files.

Run the automated Extension Development Host test with:

```bash
npm test
```

On a headless Linux machine with Xvfb installed, use:

```bash
npm run test:headless
```

The test runner downloads and caches an isolated stable VS Code build on its
first run. The extension itself remains model-free and network-free.

## Native Ubuntu production acceptance

`npm run test:native-ubuntu-acceptance` is an explicit operator-run check for
Ubuntu x86-64 and Daytona v1. It packages the checked-out build, starts an
actual Extension Development Host with a fresh disposable profile, and drives
the production local TrueForge adapter through the real loopback MCP endpoint.
The local sidecar uses the existing operator-configured TrueForge store named
by `CODEALONGAI_TRUEFORGE_DATA_PATH`; it is never copied. Daytona is the remote
producer sandbox and has no editor or workspace authority.

Set `CODEALONGAI_NATIVE_ACCEPTANCE=1`, `CODEALONGAI_TRUEFORGE_DATA_PATH`, an
operator-selected fully qualified model, supported reasoning effort, and Reply
input through the corresponding `CODEALONGAI_NATIVE_ACCEPTANCE_*` variables.
The runner writes the model and reasoning effort (never credentials or Reply
input) to its best-effort-cleaned disposable VS Code profile so the production
sidecar can use the named external store. It never prints paths, request IDs,
payloads, editor text, prompts, or credentials. `BLOCKED` (exit 2) is only an
external preflight result; an assertion or host failure is `FAIL` (exit 1).

Run it only after configuring the external TrueForge store and model:

```bash
CODEALONGAI_NATIVE_ACCEPTANCE=1 \\
CODEALONGAI_TRUEFORGE_DATA_PATH=/absolute/path/to/trueforge-store \\
CODEALONGAI_NATIVE_ACCEPTANCE_MODEL=provider/model \\
CODEALONGAI_NATIVE_ACCEPTANCE_REASONING_EFFORT=medium \\
CODEALONGAI_NATIVE_ACCEPTANCE_REPLY='Explain the next branch.' \\
npm run test:native-ubuntu-acceptance
```

V1 proves one model-backed Ask and one Reply that adds graph stops. It excludes
provider onboarding, non-Ubuntu/non-x64 hosts, non-Daytona sandboxes,
multi-window coordination, workspace mutation, and any claim that the shipped
extension is model- or network-free once an operator enables this integration.
Marketplace publication, multi-platform packaging, dependency upgrades,
additional sandbox providers, automatic provider-private cleanup, and
production observability are also out of scope.

## Install the latest release

Download [codealongai.vsix](https://github.com/krishnakartik1/codealongai/releases/latest/download/codealongai.vsix)
from the latest release. In desktop VS Code, run **Extensions: Install from
VSIX...** and select the downloaded file, or run:

```bash
code --install-extension codealongai.vsix
```

Then run **CodeAlongAI: Configure TrueForge** (the local loopback MCP endpoint
is enabled by default and can be disabled explicitly with
`codealongai.mcp.enabled`), and configure the model provider and Daytona only
in its local UI.
Set a fully qualified model and compatible reasoning effort in CodeAlongAI's
settings, then run **CodeAlongAI: Ask about this code** from the Command
Palette.
