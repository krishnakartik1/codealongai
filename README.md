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

## Shared-attention walkthrough

In `checkout.ts`, select `subtotal` in the `console.log` call, then run
`CodeAlongAI: Ask pair`. Run `CodeAlongAI: Continue walkthrough` twice. The
second step asks before it opens `pricing.ts`; choose **Follow AI** to reveal the
known subtraction defect with an anchored explanation. `CodeAlongAI: Stop
following` removes the AI cues, and `CodeAlongAI: Reset walkthrough` clears all
state before another run.

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
