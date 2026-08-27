# CodeAlongAI walkthrough UI specification

Status: implementation-ready

Scope: stable VS Code Extension APIs, model-free, read-only, session-memory only

This document is the normative UI contract for the CodeAlongAI walkthrough. It
synthesizes the approved interaction contract, stable-API research, and the two
live native-Comment prototypes. If a prototype differs from this document, this
document wins.

## Product boundary

The walkthrough lets a person start from code, read an anchored explanation,
ask questions at any visited stop, and navigate a finite graph of code ranges.
The human origin and CodeAlongAI attention are separate named concepts.

This specification does not include a model or provider, MCP integration,
workspace mutation, code proposals, persistence, authentication, or proposed
VS Code APIs. The implementation must not edit files.

The only UI primitives are stable native VS Code Comment threads and a native
Quick Pick. In particular, do not use editor webview insets, proposed Comment
reveal/focus APIs, the workbench DOM, or a custom imitation of Peek or Inline
Chat.

## Vocabulary and state

A **walkthrough stop** is one graph node with:

- an opaque, session-unique `id`;
- a concise, producer-owned `displayName`;
- a document URI and range;
- producer-owned Markdown explanation content;
- an ordered list of destination stop IDs;
- zero or one producer-selected recommended Next ID;
- zero or one graph-defined Back ID; and
- its own ordered conversation.

Distinct stop IDs are distinct stops even when every other field, including the
document and range, is the same. Their conversations must never be merged.

A **walkthrough graph** is finite. Every referenced stop ID must resolve within
the graph at the boundary where producer data is accepted. Destination order is
significant. A recommended Next and Back, when present, must refer to known
stops; recommended Next must also be one of the source's destinations.

A **session** owns:

- the graph;
- one immutable human-origin stop ID;
- exactly one CodeAlongAI-attention stop ID;
- the conversation for each stop;
- the stop-to-native-thread mapping for visited stops; and
- no durable state outside extension memory.

A stop is **visited** when its native thread has been created. Unvisited known
stops exist in the graph and picker but do not yet have threads.

The producer supplies stop names, explanations, edges, recommendations, Back
edges, destination order, answer Markdown, and generated graph patches. The UI
must not infer semantic names or reorder producer choices.

## Commands and contribution contract

The extension contributes these public commands:

| Command | Display title | Surfaces | Default keybinding |
| --- | --- | --- | --- |
| `codealongai.walkthrough.ask` | `CodeAlongAI: Ask about this code` | Editor context menu, Command Palette, Keyboard Shortcuts | None |
| `codealongai.walkthrough.back` | `Back` | Comment-thread title, Keyboard Shortcuts | None |
| `codealongai.walkthrough.next` | `Next` | Comment-thread title, Keyboard Shortcuts | None |
| `codealongai.walkthrough.destinations` | `Destinations` | Comment-thread title, Keyboard Shortcuts | None |
| `codealongai.walkthrough.reset` | `CodeAlongAI: Reset walkthrough` | Command Palette | None |

Back, Next, and Destinations are registered commands but hidden from the
Command Palette. They remain discoverable and manually bindable in VS Code's
Keyboard Shortcuts editor. Reset is enabled only while a session exists.

Thread-title buttons are ordered Back, Next, Destinations. For a particular
thread, show Back only when that stop has a Back edge, show Next only when it has
a recommended Next, and always show Destinations. Menu context must be derived
from that thread's stop, not from the attention stop.

When Back or Next is invoked by a user keybinding without a thread argument, it
uses the attention stop and is enabled only when that attention stop has the
corresponding edge. Destinations without a thread argument opens from the
attention stop and is enabled whenever a session exists. An implementation may
combine attention context keys with per-thread `contextValue` clauses so global
command enablement does not disable a valid action on a historical thread.

The native Comment reply submission command is an implementation detail. It
must be restricted to this controller, hidden from the Command Palette, and
receive the native `CommentReply`. Native Ctrl+Enter submission remains
unchanged.

## Starting a session

Ask requires an active text editor.

1. If the editor has a non-empty selection, normalize and use that exact range.
2. Otherwise, use the complete cursor line from column zero through the end of
   its text, provided the line contains at least one non-whitespace character.
3. With no active text editor or a blank cursor line, show exactly:
   **Select code or place the cursor on a nonblank line to start a walkthrough.**
   Do not change state or editor UI.

Only one session may exist. If Ask is invoked during a session, show a modal
warning that starting a new walkthrough clears all walkthrough conversations.
Its actions are **Start new walkthrough** and **Cancel**. Cancel changes
nothing. Confirming disposes the old threads and session before creating the new
one; creation must otherwise succeed atomically.

A successful start:

- preserves the real cursor and selection;
- asks the deterministic producer for an origin descriptor at that exact range;
- creates a session whose graph initially contains only that origin and whose
  origin and attention both identify it;
- creates the origin thread in the expanded state; and
- displays this CodeAlongAI invitation above the native reply box:
  **What would you like to understand about this code?**

Before a question generates more stops, Next is absent and Destinations contains
only the origin. The user types the question that can generate the first
walkthrough in this origin thread's native reply box. The same generated-patch
mechanism is used for the first walkthrough and for later branches.

## Native thread contract

Create one Comment controller with the label **CodeAlongAI walkthrough**. Native
comment authors are **You** and **CodeAlongAI**. The reply prompt is
**Ask CodeAlongAI about this walkthrough stop**.

Each visited stop owns one native Comment thread at its document range. Its
label is `CodeAlongAI · <displayName>`. When two or more stop IDs share the same
display name, document, and range, assign stable one-based collision ordinals in
stop insertion order (`CodeAlongAI · Reducer · 1`,
`CodeAlongAI · Reducer · 2`) for disambiguation in the Comments view. If a later
graph patch creates the first collision, update the already-created sibling
label as well as later sibling labels. Do not apply an ordinal to collisions
that differ by name, document, or range.

The initial explanation or invitation and all later question/answer turns are
ordinary Markdown comments. Visited threads remain anchored in the editor and
listed in the native Comments view until reset, replacement, deactivation, or
window close.

## Questions and generated walkthroughs

Trim the submitted reply. An empty value does nothing. For a non-empty value,
ask the injected deterministic responder using the source stop ID, submitted
text, and a read-only session snapshot. The responder returns exactly one of:

- explanation-only;
- destination-offer;
- generated-walkthrough; or
- explicit-unsupported.

Every outcome contains CodeAlongAI Markdown to render. Generated-walkthrough
also contains an append-only graph patch. The UI treats outcome content as
opaque producer data; it does not infer intent from prose.

Commit the human question and CodeAlongAI answer to state and the native thread
as one transition. A generated graph patch is part of that same transition. It
may append stops and edges and select the resulting recommended Next, but it
must not delete a stop, edge, or conversation. Reject an invalid patch before
changing state or comments.

A valid generated patch immediately changes the source thread's Next
availability and the whole-graph picker. It never navigates automatically. A
question asked in a historical thread uses that historical stop as source,
attaches any patch there, leaves attention unchanged, and leaves that manually
opened thread expanded. Unsupported answers are comments, not notifications.

The deterministic responder used in this effort is synchronous or otherwise
infallible after its input has been accepted. Model/provider latency and
responder failures are outside this specification. Tests must inject all four
outcome variants directly rather than depend on natural-language keyword
matching.

## Attention, expansion, and editor placement

Exactly one stop holds CodeAlongAI attention. None of these actions moves it:

- editor focus changes;
- real cursor or selection changes;
- manual thread expansion or collapse;
- opening a historical thread; or
- asking a question in a historical thread.

A successful Back, Next, or Destinations selection performs one atomic
transition:

1. resolve the target stop, document, and range;
2. create or reuse its native thread;
3. arrange and reveal its editor;
4. move attention to it;
5. request every other visited thread collapsed; and
6. request the target thread expanded.

The implementation requests Comment thread expansion through stable
`collapsibleState`; it does not promise reply-box focus or proposed reveal
behavior. A historical thread manually expanded by the user remains expanded
while they ask and receive an answer. The next successful navigation again
requests all threads except its target collapsed.

The extension must never assign or impersonate the user's cursor or selection.
For same-file navigation, reveal the target in that file's current editor
column. Keep the immutable human-origin document visible in the left editor.
When navigating across files, open the target directly in the right editor with
no confirmation. When the target is the origin, reveal it in the left editor.
Do not modify any document.

## Back, Next, and Destinations

A thread-title action uses the clicked thread as its source, even when it is
historical. A command invoked without a thread argument uses the attention stop.

- Back follows the source's fixed graph Back edge. It is not visit history.
- Next follows the source's producer-selected recommendation.
- Neither action asks for same-file or cross-file confirmation.
- A terminal stop has no Next but remains active for questions and
  Destinations. A later generated patch may make it nonterminal.

Destinations is a direct navigator over every known stop, visited or unvisited,
and is available from every visited thread. Its title is **Walkthrough graph**
and its placeholder is **Select a walkthrough stop**. Canceling it changes
nothing.

### Picker projection

Project the graph as a deterministic recommended-first depth-first spanning tree
rooted at the human origin:

1. Emit the origin once.
2. At each stop, traverse its recommended destination first when present, then
   traverse its remaining destinations in producer order.
3. The first encounter with a stop emits one row and recursively traverses it.
4. A later edge to an already-emitted stop does not duplicate the target row;
   append a concise `↗ <displayName>` rejoin marker to the source row. Preserve
   one marker per such edge in producer traversal order.

Every stop ID appears as exactly one selectable row, including distinct IDs
that share one range. Each row contains only tree connectors, `displayName`,
any rejoin marker, and one-based start coordinates formatted `L<line>:C<column>`.
Only the attention stop gets the native location icon.

Do not add recommended/alternative prose, arrows before node names,
Current/History/Future labels, visited counts, file or range descriptions, or
secondary descriptions. Selecting a row uses the same atomic navigation
transition as Back and Next.

## Failure atomicity

Navigation first prepares all fallible work without mutating the session or
existing threads. If the source edge, target stop, document, or range cannot be
resolved, or the editor cannot be opened, show one concise VS Code error
notification and do not retry automatically.

On failure preserve:

- human origin and CodeAlongAI attention;
- graph and conversations;
- the set and requested expansion state of threads;
- editor layout and visible documents; and
- every existing real cursor and selection.

If editor preparation partly changed VS Code before a later operation failed,
restore the captured editor layout and visible documents as far as stable APIs
permit before reporting the error. No new thread becomes visible unless the
entire transition commits.

## Reset and lifetime

Reset shows this modal confirmation exactly:

**Reset this walkthrough? All walkthrough conversations will be cleared.**

Its actions are **Reset walkthrough** and **Cancel**. Cancel changes nothing.
Confirming disposes every walkthrough thread and clears the session without
changing files, visible editors, cursor, or selection. Do not show a success
notification; the disappearing walkthrough UI is the feedback.

Extension deactivation, VS Code reload, or VS Code close silently disposes the
in-memory session. The next activation starts without restoration or a cleanup
prompt.

## Implementation seams

Keep the domain transition logic independent of VS Code objects. The following
roles may use different TypeScript names, but their boundaries are normative:

- **Session core:** owns immutable state snapshots, validates producer data and
  graph patches, selects Back/Next sources, and commits question and navigation
  transitions.
- **Walkthrough producer/responder:** supplies the initial graph and the four
  question outcomes. The deterministic fixture implements this role now; a
  future model can replace it without changing UI state or commands.
- **Comment view adapter:** maps stop IDs to native threads and renders snapshots.
- **Editor navigator:** resolves documents/ranges, captures editor state,
  prepares same-file or split-editor navigation, reveals a range, and restores
  preparation failures.
- **Quick Pick adapter:** renders items returned by a pure graph-projection
  function and returns a selected stop ID or cancellation.
- **Message/confirmation adapter:** owns exact user-facing errors and modal
  actions.

No pure domain type should import `vscode`. Convert between domain URIs/ranges
and VS Code values only in adapters. Expose a read-only extension test API from
activation (or an equivalent non-command seam) that reports the current session
snapshot and stop-to-thread render state. Do not add production-only “show
state” commands.

## Acceptance behavior

Automated acceptance consists of pure unit tests plus Extension Development
Host tests against the deterministic two-file workspace.

### Pure tests

1. Selection and complete-line origin derivation reject only the specified
   missing-editor/blank-line cases.
2. Starting, replacing, canceling replacement, reset confirmation, and silent
   disposal obey the session rules.
3. Stop IDs, graph references, recommended Next, and append-only patches are
   validated before commit.
4. Two same-range stop IDs keep separate conversations and receive stable
   collision labels.
5. A reply appends question and each of the four outcome kinds atomically;
   historical replies and patches do not move attention.
6. Back uses the graph edge, Next uses the recommendation, and command source
   resolution prefers an explicit thread over attention.
7. The picker projection is recommended-first DFS, emits every stop ID once,
   keeps duplicate-range IDs, annotates rejoins, and marks only attention.
8. Cancel and every injected navigation failure leave the complete before-state
   equal to the after-state.

### Extension Development Host tests

1. The manifest exposes the exact commands, titles, menus, ordering, palette
   visibility, enablement, and absence of default keybindings specified above.
2. Ask from a selection and from an empty selection on a nonblank line creates
   one expanded native origin thread without changing the real selection.
3. Native reply submission renders a `You` question and `CodeAlongAI` answer in
   order; Ctrl+Enter remains native behavior.
4. Same-file Next reuses the current column. Cross-file Next opens the target on
   the right while the origin remains left. Returning to origin uses the left.
   Pre-existing selections remain unchanged.
5. Navigation from a historical thread uses that thread's graph edges. A
   historical question leaves attention and editor placement unchanged.
6. Destinations remains available at a terminal stop and can visit any known
   unvisited, visited, rejoined, or duplicate-range stop.
7. Reset cancel preserves threads; reset confirmation disposes them without a
   success toast or editor/cursor/selection change.
8. Missing-document, invalid-range, and editor-open failures each produce one
   error and no committed state/thread change.

Use the approved prototype shape as the integration fixture. Starting creates
only the origin. Submitting the fixture question **Walk me through this code**
returns a generated-walkthrough outcome that appends the other four stops and
the listed edges atomically:

| ID | Display name | Document and anchor | Destinations | Next | Back |
| --- | --- | --- | --- | --- | --- |
| `checkout-origin` | `Origin` | The selected range in `checkout.ts` | `pricing-function`, `checkout-cart` | `pricing-function` | None |
| `pricing-function` | `Definition` | `subtotal(prices: readonly number[])` in `pricing.ts` | `pricing-reducer` | `pricing-reducer` | `checkout-origin` |
| `pricing-reducer` | `Reducer` | `total - price` in `pricing.ts` | `pricing-reducer-revisit` | `pricing-reducer-revisit` | `pricing-function` |
| `pricing-reducer-revisit` | `Reducer` | The same `total - price` range | None | None | `pricing-reducer` |
| `checkout-cart` | `Cart input` | `const cart = [12, 18]` in `checkout.ts` | `pricing-function` | `pricing-function` | `checkout-origin` |

The cart branch rejoins the existing Definition stop. Fixture prose beyond the
required invitation and question may remain deterministic test data; assertions
should verify producer payload identity rather than couple domain logic to its
wording. Pure tests inject the other three question outcome variants directly.

## Decision sources

- [Specify the stable walkthrough UI](https://github.com/krishnakartik1/codealongai/issues/24)
- [Define the walkthrough interaction contract](https://github.com/krishnakartik1/codealongai/issues/23)
- [Validate a native anchored walkthrough conversation](https://github.com/krishnakartik1/codealongai/issues/26)
- [Validate native walkthrough graph navigation and history](https://github.com/krishnakartik1/codealongai/issues/36)
- [Research stable VS Code surfaces for anchored walkthrough conversations](https://github.com/krishnakartik1/codealongai/issues/35)
