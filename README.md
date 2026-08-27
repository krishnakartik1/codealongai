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
following` removes the AI cues. Continue twice more to stage the known
one-character proposal. VS Code opens its normal diff with the live
`pricing.ts` document and an untitled staged copy. Choose **Reject proposal**
to discard it, or **Request acceptance** to explicitly accept it. CodeAlongAI
then rechecks the live `pricing.ts` version at its mutation boundary and applies
the known proposal only when it still matches the staged version. To see the
stale refusal, edit `pricing.ts` after staging and before choosing **Request
acceptance**. CodeAlongAI leaves that edit unchanged and reports that the
proposal must be replayed or restaged. Use `CodeAlongAI: Reset walkthrough` to
clear all state before another run.

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
