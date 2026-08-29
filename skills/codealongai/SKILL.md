---
name: codealongai
description: Produce one grounded CodeAlongAI walkthrough transition for an authorized start, replacement, or question request through CodeAlongAI MCP.
---

# Produce one walkthrough transition

Serve exactly the walkthrough request named in the producer turn. CodeAlongAI
owns the walkthrough session; this skill supplies grounded content for one
validated transition.

## 1. Establish authority

Call `codealongai_get_walkthrough_request` with `schemaVersion: 1` and the exact
request ID from the turn. Continue only when the returned request is `pending`
and its kind is `start`, `replace`, or `question`.

Treat the request as the authority for the action:

- For `start`, use the exact authorized origin path and range.
- For `replace`, use the exact authorized origin, `expectedSessionId`, and
  `expectedRevision`.
- For `question`, also call `codealongai_get_walkthrough`. Require an active
  walkthrough with the request's `sessionId` and `sourceStopId`. Use the current
  walkthrough revision when committing, because a pending question may be
  retried after CodeAlongAI attention has moved.

Never infer a missing request ID, session ID, revision, source stop, origin, or
authorization. If the request is unavailable, stale, canceled, committed, or a
different kind, finish without a transition and state the reason briefly.

## 2. Ground the response

Use only CodeAlongAI MCP to inspect workspace text. Start with the request
snapshot and its stop excerpts. Read more only when the response needs it:

- Use `codealongai_read_workspace_file` with the smallest useful line interval
  when the path is known.
- Use literal `codealongai_search_workspace` to locate an exact construct, and
  follow `nextCursor` only while relevant matches remain unresolved.
- Use `codealongai_list_workspace_files` only when the relevant path is unknown.

Paths are normalized workspace-relative paths. Positions are zero-based UTF-16
code-unit offsets, and ranges are end-exclusive. Prefer ranges returned by MCP
search. For a range built from a bounded read, verify the exact text and count
UTF-16 code units rather than bytes or Unicode code points. Treat `dirty: true`
text as the current editor buffer, not as proof of saved disk contents.

Every display name and explanation must describe the anchored source text. If
the available MCP evidence cannot ground the needed descriptor or stop, do not
invent it.

## 3. Build the authorized result

### Start or replacement

Construct one origin descriptor:

- copy the authorized path into `document` and copy its range exactly;
- choose a concise semantic `stopId` and `displayName` grounded in the anchor;
- write a self-contained `explanation` of that anchored code.

Commit a start with `codealongai_start_walkthrough`. Commit a replacement with
`codealongai_replace_walkthrough` and the exact expected session and revision
from the request. Insufficient grounding means no commit.

### Question

Answer the question at `sourceStopId` without changing the immutable human
origin or the named `attentionStopId`. Choose exactly one outcome:

- `explanation-only`: the grounded answer is complete and needs no graph
  change.
- `destination-offer`: the answer points to one or more already-known stops
  reachable from the source stop.
- `generated-walkthrough`: the answer needs new grounded stops or edges.
- `explicit-unsupported`: the request is outside walkthrough explanation and
  generation, or the bounded evidence is insufficient. Explain the limitation
  honestly in `answerMarkdown`.

For a destination offer, provide a non-empty, duplicate-free list of existing
stop IDs. Exclude the source stop, and include only stops reachable from it by
following `destinationIds`. An offer describes choices; it does not move
CodeAlongAI attention.

For a generated walkthrough, make a non-empty append-only graph patch:

- Give every added stop a new unique ID, grounded workspace-relative path,
  verified UTF-16 range, display name, and explanation.
- Make every `destinationId`, `recommendedNextId`, and `backId` resolve after
  the patch. Keep each destination list duplicate-free.
- Connect every added stop to the graph from the immutable human origin by
  directed destination edges. A `backId` alone does not make a stop reachable.
- Append destinations without removing or repeating an existing edge.
- Set `recommendedNextId` only when it is one of that stop's destinations. Use
  `recommendedNextUpdates` only for an existing stop that has no recommendation
  yet.
- Leave every existing stop, explanation, anchor, conversation, edge, and
  recommendation unchanged except for the two permitted appends:
  `appendedDestinations` and a previously unset recommended next.

Commit the chosen outcome with `codealongai_commit_question_outcome`, the exact
request ID, the current matching session ID, and the current walkthrough
revision.

## 4. Stop at the receipt

Issue MCP calls sequentially. Make only the transition call matching the
authorized request. A successful result is one CodeAlongAI receipt whose
`requestId` matches this turn; after receiving it, stop immediately.

If a tool reports a domain error or the expected receipt is absent, finish
without another commit attempt. Recovery belongs to CodeAlongAI and the human.

The producer surface is limited to request and walkthrough reads, bounded
workspace reads, and the matching transition. Use no walkthrough navigation or
reset call, no workspace mutation, no additional sandbox command, and no
general-purpose execution, subagent, approval flow, or provider credential.
