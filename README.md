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

## Install and set up the latest release

CodeAlongAI requires desktop VS Code 1.103 or later.

1. Download [codealongai.vsix](https://github.com/krishnakartik1/codealongai/releases/latest/download/codealongai.vsix)
   from the latest GitHub release.
2. In VS Code, open the Command Palette and run **Extensions: Install from
   VSIX...**, then select the downloaded file. You can also install it from a
   terminal:

   ```bash
   code --install-extension codealongai.vsix
   ```

3. Reload VS Code when prompted, then open the repository you want to explore.
4. Open **Settings**, search for `CodeAlongAI`, and enable **CodeAlongAI: MCP:
   Enabled** for the current window. The equivalent `settings.json` entry is:

   ```json
   {
     "codealongai.mcp.enabled": true
   }
   ```

5. Select code, or place the cursor on a nonblank line, and run
   **CodeAlongAI: Ask about this code** from the Command Palette. The walkthrough
   appears as a native comment thread in the editor.
6. Reply in the comment thread to ask follow-up questions. Use the thread's
   navigation controls to move between walkthrough stops.

The extension starts its local MCP endpoint on loopback port `61337`. If that
port is already in use, set **CodeAlongAI: MCP: Port** to another available
port and reload the VS Code window.

To replace an older local build, download the new VSIX and run:

```bash
code --install-extension codealongai.vsix --force
```
