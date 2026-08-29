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

## Install the latest release

Download [codealongai.vsix](https://github.com/krishnakartik1/codealongai/releases/latest/download/codealongai.vsix)
from the latest release. In desktop VS Code, run **Extensions: Install from
VSIX...** and select the downloaded file, or run:

```bash
code --install-extension codealongai.vsix
```

Then enable the `codealongai.mcp.enabled` setting and run **CodeAlongAI: Ask
about this code** from the Command Palette.
