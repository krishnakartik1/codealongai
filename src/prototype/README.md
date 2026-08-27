# Native Comment-thread validation prototype

> PROTOTYPE ONLY — throw this branch away after the ticket records its verdict.

This single Extension Development Host prototype answers: does a branching
walkthrough remain understandable when stable native Comment-thread title
actions drive graph-defined Back, deterministic Next, and a Destinations picker?

It deliberately creates two distinct stop instances on the same source range.
The prototype has one design, not visual variants, because substituting HTML for
the native VS Code surface would not answer the API and interaction question.

Run it from the repository root:

```bash
npm run prototype:comments
```

In the Extension Development Host:

1. Run **CodeAlongAI Prototype: Start native Comment walkthrough**. If the
   thread-title icons are not obvious, hover them and confirm they read **Next**
   and **Destinations**.
2. Choose **Destinations**. Confirm the flat picker shows all three root
   destinations and marks each as not visited. Cancel it and confirm nothing
   changes.
3. Choose **Next**, cancel the cross-file confirmation once, then accept it.
   Confirm `checkout.ts` remains on the left, `pricing.ts` opens on the right,
   the origin collapses, and the function-definition thread expands.
4. Use **Next** twice. The last transition creates a second distinct thread on
   the exact same `total - price` range. Judge whether their labels, collapsed
   markers, and separate conversations make the duplicate stops understandable.
5. Use **Back** on the second reducer thread. Confirm it follows the graph edge
   to the first reducer thread without another confirmation.
6. Open VS Code's **Comments** view and judge whether the visited graph history
   and duplicate-range stops are discoverable and distinguishable.
7. Reopen the historical origin thread and choose **Destinations** from that
   thread. Confirm the picker is rooted at the origin and marks visited entries.
   Choose the same-file cart branch, then use **Next** to rejoin the graph.
8. Ask a question in a historical thread. Confirm its conversation grows but
   CodeAlongAI attention does not move in the prototype-state output.
9. Run **CodeAlongAI Prototype: Show prototype state** to inspect the complete
   in-memory graph, visits, requested expansion state, and attention.

Please report a verdict for each category: title actions, deterministic Next,
Destinations picker, graph-defined Back, Comments-view history,
current-versus-prior expansion, and duplicate-range stops. Note any category
that is acceptable only with a product constraint.

The prototype intentionally does not use proposed APIs, persist state, call a
model, invoke MCP, or modify workspace files.
