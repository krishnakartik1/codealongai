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
and choose `CodeAlongAI: Ask pair` from the Command Palette in the Extension
Development Host. The host opens the two-file workspace under `demo-workspace/`.

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
