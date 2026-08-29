# PROTOTYPE — TrueForge producer turn

This throwaway spike answers one question: can TrueForge `0.1.4`, through the
TypeScript SDK `0.1.3`, load the exact public CodeAlongAI skill and commit one
authorized walkthrough start through a dynamic loopback MCP fixture on the same
Ubuntu host?

It is evidence for the Wayfinder decision ticket, not production sidecar code.
It deliberately launches the real Extension Development Host and TrueForge UI,
then asks the operator to confirm both windows and choose one already-configured
`provider/model` name before it spends a model turn.

Run from the repository root:

```bash
bash prototypes/trueforge-producer-turn/run.sh
```

Prerequisites:

- Ubuntu Linux x86-64 and Node `>=22.14.0 <23`
- `bwrap`, `rg`, `socat`, Python 3, Firefox, and the cached VS Code test build
- one model provider configured through the TrueForge UI

If `socat` is not installed system-wide, set
`CODEALONGAI_SPIKE_SOCAT_DIR` to a directory containing its executable. The
current spike session uses `/tmp/codealongai-spike-socat/usr/bin`.

TrueForge configuration persists only in
`/tmp/codealongai-trueforge-producer-turn/state.sqlite` so setup can be reused.
The runner never reads that database and never prints credentials, request
snapshots, model reasoning, source contents, or complete MCP payloads. Sanitized
evidence is written to `/tmp/codealongai-trueforge-producer-turn/evidence.json`.

To run the distinct walkthrough-generation spike through a configured Daytona
provider while reusing the visible UI:

```bash
CODEALONGAI_SPIKE_KIND=generate \
CODEALONGAI_SPIKE_SKIP_SKILL_READ=1 \
CODEALONGAI_SPIKE_REUSE_UI=1 \
CODEALONGAI_SPIKE_TRUEFORGE_URL=http://127.0.0.1:4111 \
CODEALONGAI_SPIKE_MODEL=openai/gpt-5-6-luna \
CODEALONGAI_SPIKE_REASONING_EFFORT=medium \
bash prototypes/trueforge-producer-turn/run.sh
```

That mode seeds one origin stop, authorizes a question requesting a grounded
walkthrough, requires a `generated-walkthrough` outcome, and prints the complete
committed graph state. Its separate evidence file is
`/tmp/codealongai-trueforge-producer-turn/evidence-generation.json`.

After generation evidence exists and Daytona plus a model are configured in the
TrueForge UI at port 4111, run the live native-comment follow-up with one command:

```bash
bash prototypes/trueforge-producer-turn/live-followup.sh
```

The runner opens a fresh Extension Development Host, loads the generated graph,
and waits for one native comment Reply. That Reply captures a real question
request, starts one TrueForge producer turn, commits through the extension-owned
loopback MCP endpoint, and renders the receipt-backed model answer in the same
thread. Sanitized evidence is written to
`/tmp/codealongai-trueforge-producer-turn/evidence-live-followup.json`.
