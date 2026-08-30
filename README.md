# CodeAlongAI

CodeAlongAI is a model-free hackathon prototype exploring collaboration with an
AI companion directly in the editor.

## Local development

Requirements: Node.js 22 and desktop VS Code.

```bash
npm install
npm run build
npm run typecheck
```

Open this repository in VS Code, run the `Run CodeAlongAI` launch configuration,
enable the window setting `codealongai.mcp.enabled`, and choose `CodeAlongAI: Ask
about this code` from the Command Palette in the Extension Development Host.

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
Ubuntu x86-64. It packages the checked-out build, starts an actual Extension
Development Host with a fresh disposable profile, and drives the production
local TrueForge adapter through the real loopback MCP endpoint. The local
sidecar keeps provider configuration and credentials local; Daytona is the
remote producer sandbox and has no editor or workspace authority.

Set `CODEALONGAI_NATIVE_ACCEPTANCE=1`, an operator-selected fully qualified
model, supported reasoning effort, and Reply input through the corresponding
`CODEALONGAI_NATIVE_ACCEPTANCE_*` variables. The runner never prints or saves
those values, request identifiers, payloads, editor text, or private paths. It
reports `SKIP` when not opted in and `BLOCKED` when external setup cannot be
proved, retaining only transient redacted pass/fail evidence.

V1 proves one model-backed Ask and one Reply that adds graph stops. It excludes
provider onboarding, non-Ubuntu hosts, and workspace mutation.

## Install the latest release

Download [codealongai.vsix](https://github.com/krishnakartik1/codealongai/releases/latest/download/codealongai.vsix)
from the latest release. In desktop VS Code, run **Extensions: Install from
VSIX...** and select the downloaded file, or run:

```bash
code --install-extension codealongai.vsix
```

Then enable the `codealongai.mcp.enabled` setting and run **CodeAlongAI: Ask
about this code** from the Command Palette.
