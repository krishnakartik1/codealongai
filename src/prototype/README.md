# Native Comment-thread validation prototype

> PROTOTYPE ONLY — throw this branch away after the ticket records its verdict.

This single Extension Development Host prototype answers: does stable VS Code
Comment-thread UI provide acceptable explanation, multi-turn questions,
keyboard flow, reveal behavior, collapsed history, and split-screen density for
CodeAlongAI?

Run it from the repository root:

```bash
npm run prototype:comments
```

In the Extension Development Host:

1. Run **CodeAlongAI Prototype: Start native Comment walkthrough**.
2. Judge whether the new expanded thread is visible enough without a proposed
   reveal/focus API and whether the comment/reply chrome reads acceptably as a
   teaching conversation.
3. Use the keyboard to focus the reply box, ask two questions, and submit each
   with VS Code's native **Ask CodeAlongAI** action. Confirm the `You` and
   `CodeAlongAI` turns remain readable in order.
4. Run **CodeAlongAI Prototype: Follow to pricing stop**, first declining and
   then accepting the consent prompt.
5. Confirm `checkout.ts` remains visible on the left with its earlier thread
   collapsed, while `pricing.ts` opens on the right with the current thread
   expanded. Judge whether both source panes retain useful density.
6. Reopen the old thread and move between editors using only the keyboard.
   Confirm the history is understandable and the current stop is not confused
   with the named human origin.
7. Run **CodeAlongAI Prototype: Show prototype state** to inspect the complete
   in-memory state after the interaction.

Please report a verdict for each category: explanation chrome, question/reply
flow, keyboard flow, automatic visibility, collapsed history, and split-screen
density. Note any category that is acceptable only with a product constraint.

The prototype intentionally does not use proposed APIs, persist state, call a
model, invoke MCP, or modify workspace files.
