import { mergeEventDelta, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { TrueForgeStreamFailure, type TrueForgeProducerRuntime, type TrueForgeRequestOptions } from './trueforge-contract';
import type { QuestionReceipt } from './walkthrough';

/** The short-lived, receipt-only authority boundary for one start request. */
export interface ProducerConfiguration {
  readonly model: string;
  readonly reasoningEffort: string;
  readonly mcpUrl: string;
}

export interface ProducerTurnInput {
  /** Native Reply and replacement use the same short-lived receipt coordinator as Ask. */
  readonly kind?: 'start' | 'question' | 'replacement';
  readonly requestId: string;
  readonly configuration: ProducerConfiguration;
  /** Production supplies the extension-owned receipt validator; fixture-only
   * coordinators may omit it. */
  readonly acceptReceipt?: (receipt: ProducerReceipt) => boolean;
  readonly rollbackTentativeStart?: () => void;
  readonly rollbackTentativeReplacement?: () => void;
  readonly rollbackTentativeQuestion?: () => void;
  /** Acceptance-only, normalized event summary. It never receives IDs, text, paths, or payloads. */
  readonly observe?: (event: ProducerTurnObservation) => void;
  /** Operator-only raw TrueForge/MCP trace. It is never used for acceptance. */
  readonly trace?: (label: string, value: unknown) => void;
}

export interface ProducerAgentSpecSummary { readonly kind: 'start' | 'question' | 'replacement'; readonly model: string; readonly reasoningEffort: string; readonly skill: 'codealongai'; readonly connector: 'codealongai-mcp'; readonly preload: true; readonly sandbox: 'daytona'; readonly parallelToolCalls: false; readonly downloads: false; readonly subagents: false; readonly userQuestions: false; readonly iterationLimit: 14; }
export type ProducerTurnObservation = { readonly kind: 'session-created' | 'turn-created' | 'sandbox-created' | 'call' | 'receipt-matched' | 'terminal-done' | 'terminal-failed' | 'session-deleted' | 'forbidden' | 'agent-spec'; readonly name?: string; readonly spec?: ProducerAgentSpecSummary; };

export type ProducerReceipt = StartReceipt | QuestionReceipt;
export type ProducerTurnResult = { readonly status: 'committed'; readonly receipt: ProducerReceipt } | { readonly status: 'failed'; readonly diagnostic: string };
export interface StartReceipt { readonly schemaVersion: 1; readonly requestId: string; readonly sessionId: string; readonly revision: number; readonly attentionStopId: string; }

const allowedReads = new Set(['codealongai_get_walkthrough_request', 'codealongai_get_walkthrough', 'codealongai_list_workspace_files', 'codealongai_read_workspace_file', 'codealongai_search_workspace']);
const startTool = 'codealongai_start_walkthrough';
const replacementTool = 'codealongai_replace_walkthrough';
const questionTool = 'codealongai_commit_question_outcome';
const permittedTools = [...allowedReads, startTool];

const providerDiagnostic = (value: unknown): string => {
  if (!(value instanceof Error)) return String(value);
  const cause = (value as Error & { cause?: unknown }).cause;
  return cause === undefined ? value.message : `${value.message}: ${providerDiagnostic(cause)}`;
};

const rawDiagnostic = (condition: string, value: unknown): string => {
  try { return `${condition}; received=${JSON.stringify(value)}`; }
  catch (error) { return `${condition}; received=${String(value)}; serialization_error=${String(error)}`; }
};

const producerTurnMessage = (input: ProducerTurnInput): string => {
  if (input.kind === 'question') return `A CodeAlongAI user asked a follow-up question in the editor. Retrieve the authorized question request with ID "${input.requestId}" using CodeAlongAI MCP, answer exactly that request, commit the matching question outcome, and stop at its receipt.`;
  if (input.kind === 'replacement') return `A CodeAlongAI user asked to replace a walkthrough. Retrieve the authorized request with ID "${input.requestId}" using CodeAlongAI MCP, create and commit exactly that replacement, and stop at its receipt.`;
  return `A CodeAlongAI user has asked to start a walkthrough. Retrieve the authorized request with ID "${input.requestId}" using CodeAlongAI MCP, create exactly that walkthrough, commit it, and stop at the matching receipt.`;
};

const commonProducerInstructions = 'Work on only the named authorized request. The selected CodeAlongAI skill is already available: do not read or load its file and do not call any command or exec tool; proceed directly with CodeAlongAI MCP. Use no other skill, command, subagent, approval, code execution, workspace mutation, download, provider credential, navigation, or reset; do not ask the user or retry. Call CodeAlongAI MCP tools sequentially. Read the authorized request and only the bounded context needed to produce it. Commit exactly the matching authorized transition and stop immediately after its matching receipt. Do not reveal source text, request snapshots, MCP payloads, credentials, or reasoning in final prose.';
const exactAuthorizedOriginInstructions = 'Read exactly its authorized origin interval: use range.start.line as startLine and one past its last occupied line as endLine. Never widen or guess a larger interval.';
const producerInstructions = (kind: ProducerTurnInput['kind']): string => kind === 'question'
  ? `Produce exactly one CodeAlongAI question outcome. First read the exact authorized question, then use its captured walkthrough and snapshot. Read the active walkthrough and additional bounded workspace context only if needed. For questions about what code does, how it works or is used, control or data flow, or relationships, choose generated-walkthrough with a non-empty grounded append-only graph patch. Use explanation-only only for narrow factual questions where no additional grounded stop would help. ${commonProducerInstructions}`
  : kind === 'replacement'
    ? `Produce exactly one CodeAlongAI replacement transition. First read the exact authorized replacement request. ${exactAuthorizedOriginInstructions} ${commonProducerInstructions}`
    : `Produce exactly one CodeAlongAI start transition. First read the exact authorized request. ${exactAuthorizedOriginInstructions} ${commonProducerInstructions}`;

/** Build an inline, capability-minimal native AgentSpec. It deliberately has no
 * shell, approval, user-question, download, retry, or subagent capability. */
export function producerAgentSpec(input: ProducerTurnInput): TrueForgeApi.AgentSpec {
  const question = input.kind === 'question';
  const replacement = input.kind === 'replacement';
  return {
    model: { name: input.configuration.model, params: { reasoningEffort: input.configuration.reasoningEffort, parallelToolCalls: false } },
    skills: [{ name: 'codealongai' }],
    mcpServers: [{ name: 'codealongai-mcp', enableTools: question ? [...allowedReads, questionTool] : replacement ? [...allowedReads, replacementTool] : permittedTools, requireApprovalForTools: [], preload: true }],
    config: { sandbox: { enabled: true, fileDownloads: false }, dynamicSubAgents: { enabled: false }, askUserQuestions: { enabled: false }, iterationLimit: 14 },
    instructions: producerInstructions(input.kind)
  };
}

/** Derives a whitelist-only policy record from the exact request handed to createSession. */
export function producerSessionRequestSummary(request: unknown, kind: 'start' | 'question' | 'replacement'): ProducerAgentSpecSummary | undefined {
  const spec = (request as { agent?: { spec?: { model?: { name?: unknown; params?: { reasoningEffort?: unknown; parallelToolCalls?: unknown } }; skills?: { name?: unknown }[]; mcpServers?: { name?: unknown; preload?: unknown }[]; config?: { sandbox?: { enabled?: unknown; fileDownloads?: unknown }; dynamicSubAgents?: { enabled?: unknown }; askUserQuestions?: { enabled?: unknown }; iterationLimit?: unknown } } } }).agent?.spec;
  const model = spec?.model?.name; const reasoningEffort = spec?.model?.params?.reasoningEffort;
  if (typeof model !== 'string' || typeof reasoningEffort !== 'string' || spec?.skills?.length !== 1 || spec.skills[0]?.name !== 'codealongai' || spec.mcpServers?.length !== 1 || spec.mcpServers[0]?.name !== 'codealongai-mcp' || spec.mcpServers[0]?.preload !== true || spec.model?.params?.parallelToolCalls !== false || spec.config?.sandbox?.enabled !== true || spec.config.sandbox.fileDownloads !== false || spec.config.dynamicSubAgents?.enabled !== false || spec.config.askUserQuestions?.enabled !== false || spec.config.iterationLimit !== 14) return undefined;
  return { kind, model, reasoningEffort, skill: 'codealongai', connector: 'codealongai-mcp', preload: true, sandbox: 'daytona', parallelToolCalls: false, downloads: false, subagents: false, userQuestions: false, iterationLimit: 14 };
}

/** Normalizes native and system tool events without trusting their prose. */
export class ProducerTurnReducer {
  private readonly seenEvents = new Set<string>();
  private readonly streamingMessages = new Map<string, Record<string, unknown>>();
  private readonly completedMessages = new Set<string>();
  private pending: { id: string; name: string } | undefined;
  private readonly deferredResults = new Map<string, unknown>();
  private callsUsed = 0;
  private origin: { path: string; startLine: number; endLine: number; sessionId?: string; revision?: number } | undefined;
  private questionRead: { path: string; startLine: number; endLine: number } | undefined;
  private receipt: ProducerReceipt | undefined;
  private failure: string | undefined;
  public constructor(private readonly requestId: string, private readonly acceptReceipt?: (receipt: ProducerReceipt) => boolean, private readonly kind: 'start' | 'question' | 'replacement' = 'start') {}
  public accept(event: unknown): void {
    if (this.receipt || this.failure) return;
    const record = object(event); if (!record) return;
    const type = string(record.type);
    const eventId = string(record.id);
    if (type !== 'model.message.delta' && eventId !== undefined) { if (this.seenEvents.has(eventId)) return; this.seenEvents.add(eventId); }
    if ((type === 'model.message' || type === 'tool.response') && (typeof record.id !== 'string' || record.threadId !== 'main')) { this.failure = rawDiagnostic('tool provenance requires a string event id and main thread', event); return; }
    if (type === 'sandbox.command' || type === 'command' || type === 'approval.request' || type === 'tool.approval_required' || type === 'tool.response_required' || type === 'ask_user') { this.failure = 'unexpected_command'; return; }
    if (type === 'model.message') {
      if (!eventId) { this.failure = rawDiagnostic('tool provenance requires a string event id', event); return; }
      this.streamingMessages.set(eventId, record);
      if (record.finishReason != null || (Array.isArray(record.toolCalls) && record.toolCalls.length > 0)) this.acceptCompletedMessage(record);
      return;
    }
    if (type === 'model.message.delta') {
      if (!eventId) { this.failure = rawDiagnostic('model message delta requires a matching base message id', event); return; }
      const base = this.streamingMessages.get(eventId);
      if (!base) { this.failure = rawDiagnostic('model message delta arrived without a retained base message', event); return; }
      mergeEventDelta(base as never, record as never);
      if (record.finishReason != null) this.acceptCompletedMessage(base);
      return;
    }
    const result = toolResult(record); if (result) this.acceptResult(result.id, result.content);
  }
  public get result(): ProducerTurnResult | undefined { return this.receipt ? { status: 'committed', receipt: this.receipt } : this.failure ? { status: 'failed', diagnostic: this.failure } : undefined; }
  public fail(diagnostic: string): void { if (!this.receipt) this.failure = diagnostic; }
  private acceptCompletedMessage(record: Record<string, unknown>): void {
    const eventId = string(record.id);
    if (!eventId || this.completedMessages.has(eventId)) return;
    this.completedMessages.add(eventId);
    const rawCalls = record.toolCalls; const calls = modelToolCalls(record);
    if (!Array.isArray(rawCalls) || rawCalls.length !== 1 || calls.length !== 1) { this.failure = rawDiagnostic('tool provenance requires exactly one valid completed tool call', record); return; }
    this.acceptCall(calls[0]);
  }
  private acceptCall(call: ProducerCall): void {
    if (!call.provenance || this.pending) { this.failure = this.pending ? 'result_required' : rawDiagnostic('tool provenance requires CodeAlongAI MCP tool metadata', call); return; }
    const { id, name, arguments: args } = call;
    const transitionTool = this.kind === 'question' ? questionTool : this.kind === 'replacement' ? replacementTool : startTool;
    if (name !== transitionTool && ++this.callsUsed > 12) { this.failure = 'call_budget_exceeded'; return; }
    if (!this.origin && (name !== 'codealongai_get_walkthrough_request' || args.requestId !== this.requestId)) { this.failure = 'request_authority_required'; return; }
    if (this.origin && name === 'codealongai_get_walkthrough_request') { this.failure = 'request_authority_required'; return; }
    if (name === 'codealongai_list_workspace_files' && this.listed) { this.failure = 'workspace_list_repeated'; return; }
    if (name === 'codealongai_search_workspace' && (typeof args.query !== 'string' || /[\r\n]/.test(args.query))) { this.failure = 'search_invalid'; return; }
    if (this.kind !== 'question' && name === 'codealongai_read_workspace_file' && (!this.origin || args.path !== this.origin.path || args.startLine !== this.origin.startLine || args.endLine !== this.origin.endLine)) { this.failure = 'origin_range_required'; return; }
    if (this.kind === 'question' && name === 'codealongai_read_workspace_file') {
      const startLine = args.startLine; const endLine = args.endLine;
      if (typeof args.path !== 'string' || typeof startLine !== 'number' || typeof endLine !== 'number' || !Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 0 || endLine < startLine || endLine - startLine > 200) { this.failure = 'context_range_required'; return; }
      this.questionRead = { path: args.path, startLine, endLine };
    }
    if (name !== transitionTool && !allowedReads.has(name)) { this.failure = 'tool_not_allowed'; return; }
    if (name === transitionTool && (args.requestId !== this.requestId || this.transitioned || (this.kind !== 'question' && !this.originRead) || (this.kind === 'question' && (args.expectedSessionId !== this.origin?.sessionId || args.expectedRevision !== this.origin?.revision)) || (this.kind === 'replacement' && (args.expectedSessionId !== this.origin?.sessionId || args.expectedRevision !== this.origin?.revision)))) { this.failure = this.origin ? 'transition_invalid' : 'request_authority_required'; return; }
    if (name === 'codealongai_list_workspace_files') this.listed = true;
    if (name === transitionTool) this.transitioned = true;
    this.pending = { id, name };
    const deferred = this.deferredResults.get(id);
    if (deferred !== undefined) { this.deferredResults.delete(id); this.acceptResult(id, deferred); }
  }
  private acceptResult(id: string, content: unknown): void {
    if (!this.pending) { this.deferredResults.set(id, content); return; }
    if (this.pending.id !== id) { this.failure = 'result_correlation'; return; }
    const pending = this.pending; this.pending = undefined;
    const result = object(content); if (!result || result.isError === true || Array.isArray(result.error)) { this.failure = safeToolError(result); return; }
    if (pending.name === 'codealongai_get_walkthrough_request') { this.origin = this.kind === 'question' ? authorizedQuestion(result, this.requestId) : authorizedOrigin(result, this.requestId, this.kind); if (!this.origin) { this.failure = 'request_authority_invalid'; return; } }
    if (this.kind === 'question' && pending.name === 'codealongai_get_walkthrough' && !activeWalkthrough(result, this.origin)) { this.failure = 'active_walkthrough_invalid'; return; }
    if (pending.name === 'codealongai_read_workspace_file') {
      const expected = this.kind === 'question' ? this.questionRead : this.origin;
      if (!expected || !(this.kind === 'question' ? questionContextRead(result, expected) : exactOriginRead(result, expected))) { this.failure = this.kind === 'question' ? 'context_read_invalid' : 'origin_read_invalid'; return; }
      this.originRead = true;
    }
    if (pending.name !== (this.kind === 'question' ? questionTool : this.kind === 'replacement' ? replacementTool : startTool)) return;
    const receipt = receiptFrom(content);
    if (!receipt || receipt.requestId !== this.requestId) { this.failure = 'missing_receipt'; return; }
    if (this.acceptReceipt && !this.acceptReceipt(receipt)) { this.failure = 'receipt_invalid'; return; }
    this.receipt = receipt;
  }
  private listed = false;
  private transitioned = false;
  private originRead = false;
  public get hasReceipt(): boolean { return this.receipt !== undefined; }
}

/** Converts live adapter events into a bounded acceptance vocabulary before any test seam can observe them. */
function observeProducerEvent(observe: ProducerTurnInput['observe'], event: unknown): void {
  if (!observe) return;
  const record = object(event); if (!record) return;
  const type = string(record.type);
  if (type === 'sandbox.created') { observe({ kind: 'sandbox-created' }); return; }
  if (type === 'model.message') { const calls = modelToolCalls(record); if (calls.length === 1) observe({ kind: 'call', name: calls[0].name }); return; }
  if (terminalState(event) === 'done') observe({ kind: 'terminal-done' });
  else if (terminalState(event) === 'failed') observe({ kind: 'terminal-failed' });
  else if (type === 'sandbox.command' || type === 'command' || type === 'approval.request' || type === 'tool.approval_required' || type === 'tool.response_required' || type === 'ask_user') observe({ kind: 'forbidden' });
}

function traceProducerEvent(trace: ProducerTurnInput['trace'], source: 'streamed' | 'persisted', event: unknown): void {
  trace?.(`TrueForge ${source} event`, event);
  const record = object(eventEnvelope(event).event);
  if (record?.type === 'model.message' && modelToolCalls(record).some((call) => call.provenance)) trace?.('CodeAlongAI MCP call', event);
  if (record?.type === 'tool.response') trace?.('CodeAlongAI MCP response', event);
}

/** One fresh session and one unchained turn. A receipt, not terminal prose, is success. */
export class ReceiptBackedProducerCoordinator {
  private active: Promise<ProducerTurnResult> | undefined;
  private cleanup: Promise<ProducerTurnResult> | undefined;
  private publish: ((result: ProducerTurnResult) => void) | undefined;
  private activeSessionId: string | undefined;
  private cancelled = false;
  private cancelWaiter: (() => void) | undefined;
  private readonly cancelledSignal = new Promise<void>((resolve) => { this.cancelWaiter = resolve; });
  private readonly abort = new AbortController();
  private nativeCancel: Promise<void> | undefined;
  private teardown: { readonly controller: AbortController; readonly timer: ReturnType<typeof setTimeout> } | undefined;
  public constructor(private readonly runtime: TrueForgeProducerRuntime, private readonly timeoutMs = 180_000, private readonly waitForGrace: (milliseconds: number, signal?: AbortSignal) => Promise<void> = gracePeriod, private readonly teardownTimeoutMs = 5_000) {}
  public start(input: ProducerTurnInput): Promise<ProducerTurnResult> {
    if (this.active) return this.active;
    let publish!: (result: ProducerTurnResult) => void;
    const visible = new Promise<ProducerTurnResult>((resolve) => { publish = resolve; });
    this.publish = publish;
    const cleanup = this.run(input, publish);
    this.active = visible; this.cleanup = cleanup;
    void cleanup.then(publish, () => publish({ status: 'failed', diagnostic: 'producer_error' })).finally(() => {
      if (this.cleanup === cleanup) { this.active = undefined; this.cleanup = undefined; this.publish = undefined; }
    });
    return visible;
  }
  /** Completion of the bounded ownership/cleanup lease, not user-visible success. */
  public get settled(): Promise<ProducerTurnResult> | undefined { return this.cleanup; }
  /** Wake every producer wait immediately. Cleanup remains owned by run(). */
  public cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.publish?.({ status: 'failed', diagnostic: 'cancelled' });
    this.cancelWaiter?.();
    this.abort.abort();
    if (this.activeSessionId) this.beginTeardown(this.activeSessionId);
  }
  private async run(input: ProducerTurnInput, publish: (result: ProducerTurnResult) => void): Promise<ProducerTurnResult> {
    let sessionId: string | undefined;
    const observedEventIds = new Set<string>();
    const observeOnce = (event: unknown): void => { const id = object(event)?.id; if (typeof id === 'string') { if (observedEventIds.has(id)) return; observedEventIds.add(id); } observeProducerEvent(input.observe, event); };
    const deadline = Date.now() + this.timeoutMs;
    try {
      const spec = producerAgentSpec(input);
      // The acceptance observer sees only which minimal policy was installed,
      // never the AgentSpec, model, URL, request, or instructions.
      const sessionRequest = { agent: { spec } };
      input.observe?.({ kind: 'agent-spec', name: input.kind ?? 'start', spec: producerSessionRequestSummary(sessionRequest, input.kind ?? 'start') });
      const creating = this.runtime.createSession(sessionRequest, teardownOptions(this.abort.signal, this.timeoutMs));
      const session = await beforeDeadline(creating, deadline, this.cancelledSignal);
      if (!session.completed) {
        if (session.cancelled) {
          // Cancellation may not detach a session creation: retain ownership
          // until it materializes (or the same absolute deadline expires).
          const cancelledCreation = await beforeDeadline(creating.then((value) => ({ value }), () => undefined), Date.now() + this.teardownTimeoutMs);
          if (cancelledCreation.completed && cancelledCreation.value) {
            sessionId = idOf(cancelledCreation.value.value);
            this.activeSessionId = sessionId;
          }
        }
        if (!session.cancelled) this.abort.abort();
        return { status: 'failed', diagnostic: session.cancelled ? 'cancelled' : 'deadline_exceeded' };
      }
      input.trace?.('TrueForge session response', session.value);
      sessionId = idOf(session.value); this.activeSessionId = sessionId; input.observe?.({ kind: 'session-created' });
      if (this.cancelled) return { status: 'failed', diagnostic: 'cancelled' };
      if (!sessionId) return { status: 'failed', diagnostic: 'session_unavailable' };
      const turn = await beforeDeadline(this.runtime.runTurn({ sessionId, request: { input: [{ type: 'user.message', content: producerTurnMessage(input) }], previousTurnId: 'none' }, options: requestOptions(this.abort.signal, deadline) }), deadline, this.cancelledSignal);
      if (!turn.completed) { if (!turn.cancelled) this.abort.abort(); return { status: 'failed', diagnostic: turn.cancelled ? 'cancelled' : 'deadline_exceeded' }; }
      input.trace?.('TrueForge turn response', turn.value);
      const turnId = idOf(turn.value); input.observe?.({ kind: 'turn-created' });
      if (!turnId) return { status: 'failed', diagnostic: 'turn_unavailable' };
      const reducer = new ProducerTurnReducer(input.requestId, input.acceptReceipt, input.kind ?? 'start');
      let lastSequence = -1;
      const seenSequences = new Set<number>();
      let receipt: Extract<ProducerTurnResult, { status: 'committed' }> | undefined;
      let receiptGrace: Promise<{ completed: true; value: void } | { completed: false; cancelled: boolean }> | undefined;
      let reconciliationCutoff: number | undefined;
      const commitReceipt = (result: Extract<ProducerTurnResult, { status: 'committed' }>): void => {
        if (receipt) return;
        receipt = result;
        input.observe?.({ kind: 'receipt-matched' });
        publish(receipt);
        receiptGrace = beforeDeadline(this.waitForGrace(5_000, this.abort.signal), deadline, this.cancelledSignal);
      };
      // A native stream can close between a persisted call and response. Subscribe
      // once more to the same turn; the reducer's sequence set makes that safe.
      for (let subscription = 0; subscription < 2; subscription += 1) {
        const eventsAbort = new AbortController();
        const abortEvents = (): void => eventsAbort.abort();
        if (this.abort.signal.aborted) abortEvents(); else this.abort.signal.addEventListener('abort', abortEvents, { once: true });
        const iterator = this.runtime.events(sessionId, turnId, lastSequence < 0 ? undefined : lastSequence, requestOptions(eventsAbort.signal, deadline))[Symbol.asyncIterator]();
        let recoverableEof = false;
        try { while (true) {
          if (this.cancelled) return { status: 'failed', diagnostic: 'cancelled' };
          const remaining = deadline - Date.now();
          if (remaining <= 0) { this.abort.abort(); return { status: 'failed', diagnostic: 'deadline_exceeded' }; }
          const eventDeadline = receipt ? deadline : reconciliationCutoff ?? deadline;
          const interrupted = { interrupted: true } as const;
          const nextEvent = beforeDeadline(iterator.next(), eventDeadline, this.cancelledSignal).then((value) => ({ kind: 'event' as const, value })).catch((error) => ({ ...interrupted, category: error instanceof TrueForgeStreamFailure ? error.category : 'unknown' as const }));
          const next = await (receiptGrace ? Promise.race([nextEvent, receiptGrace.then((value) => ({ kind: 'grace' as const, value }))]) : nextEvent);
          if ('interrupted' in next) {
            if (this.cancelled) return { status: 'failed', diagnostic: 'cancelled' };
            if (Date.now() >= deadline) { this.abort.abort(); return { status: 'failed', diagnostic: 'deadline_exceeded' }; }
            if (subscription === 0) { recoverableEof = true; break; }
            return { status: 'failed', diagnostic: `stream_${next.category}` };
          }
          if (next.kind === 'grace') {
            if (!next.value.completed) { if (!next.value.cancelled) this.abort.abort(); return { status: 'failed', diagnostic: next.value.cancelled ? 'cancelled' : 'deadline_exceeded' }; }
            return receipt!;
          }
          if (!next.value.completed) { if (!next.value.cancelled) this.abort.abort(); return { status: 'failed', diagnostic: next.value.cancelled ? 'cancelled' : 'deadline_exceeded' }; }
          // Cancellation may have arrived while the native iterator was
          // blocked. Do not let its subsequently delivered receipt commit.
          if (this.cancelled) return { status: 'failed', diagnostic: 'cancelled' };
          if (next.value.value.done) { recoverableEof = true; break; }
          traceProducerEvent(input.trace, 'streamed', next.value.value.value);
          const envelope = eventEnvelope(next.value.value.value);
          if (envelope.sequence !== undefined) { if (seenSequences.has(envelope.sequence)) continue; seenSequences.add(envelope.sequence); lastSequence = Math.max(lastSequence, envelope.sequence); }
          reducer.accept(envelope.event);
          observeOnce(envelope.event);
          const result = reducer.result;
          if (result?.status === 'failed') return result;
          if (result?.status === 'committed') commitReceipt(result);
          const terminal = terminalState(envelope.event);
          if (terminal === 'failed' && !receipt) return { status: 'failed', diagnostic: 'terminal_error' };
          if (terminal === 'done' && receipt) return receipt;
        } } finally {
          this.abort.signal.removeEventListener('abort', abortEvents);
          // EOF is recoverable. Final exits abort the blocked stream read and
          // bound return() by the same teardown lease as cancel/delete.
          if (recoverableEof) {
            if (iterator.return) await iterator.return().catch(() => undefined);
          } else {
            eventsAbort.abort();
            this.beginTeardown(sessionId);
            // return() may be queued behind the outstanding next(). The
            // teardown lease owns native cancel/delete; never hold it here.
            void iterator.return?.().catch(() => undefined);
          }
        }
        const result = reducer.result; if (result?.status === 'failed') return result; if (result?.status === 'committed') commitReceipt(result);
        // The stream may have ended between persisted events. Reconcile once
        // before the one permitted cursor-resubscription.
        if (subscription === 0) {
          reconciliationCutoff ??= Math.min(deadline, Date.now() + 5_000);
          const reconciliationDeadline = reconciliationCutoff;
          const persisted = await beforeDeadline(this.runtime.listTurnEvents(sessionId, turnId, requestOptions(this.abort.signal, reconciliationDeadline)).catch(() => []), reconciliationDeadline, this.cancelledSignal);
          if (!persisted.completed) { if (!persisted.cancelled) this.abort.abort(); return { status: 'failed', diagnostic: persisted.cancelled ? 'cancelled' : 'deadline_exceeded' }; }
          // Persisted history is authoritative for causality, not merely a
          // cursor continuation: it can contain a call missed before a live
          // response with a higher sequence. Stable event ids make replay safe.
          for (const event of [...persisted.value].sort((left, right) => (eventEnvelope(left).sequence ?? Number.MAX_SAFE_INTEGER) - (eventEnvelope(right).sequence ?? Number.MAX_SAFE_INTEGER))) {
            traceProducerEvent(input.trace, 'persisted', event);
            const envelope = eventEnvelope(event);
            if (envelope.sequence !== undefined) { if (seenSequences.has(envelope.sequence)) continue; seenSequences.add(envelope.sequence); lastSequence = Math.max(lastSequence, envelope.sequence); }
            reducer.accept(envelope.event); observeOnce(envelope.event);
            const reconciled = reducer.result;
            if (reconciled?.status === 'failed') return reconciled;
            if (reconciled?.status === 'committed') commitReceipt(reconciled);
            const terminal = terminalState(envelope.event);
            if (terminal === 'failed' && !receipt) return { status: 'failed', diagnostic: 'terminal_error' };
            if (terminal === 'done' && receipt) return receipt;
          }
        }
      }
      if (receipt) {
        const grace = await receiptGrace!;
        if (!grace.completed) { if (!grace.cancelled) this.abort.abort(); return { status: 'failed', diagnostic: grace.cancelled ? 'cancelled' : 'deadline_exceeded' }; }
        if (this.cancelled) return { status: 'failed', diagnostic: 'cancelled' };
        return receipt;
      }
      // A terminal/no-receipt stream can lag its persisted call/response pair.
      // Keep this reconciliation lease short and separate from the request's
      // three-minute operation deadline.
      const reconciliationDeadline = reconciliationCutoff ?? Math.min(deadline, Date.now() + 5_000);
      const persisted = await beforeDeadline(this.runtime.listTurnEvents(sessionId, turnId, requestOptions(this.abort.signal, reconciliationDeadline)).catch(() => []), reconciliationDeadline, this.cancelledSignal);
      if (!persisted.completed) { if (!persisted.cancelled) this.abort.abort(); return { status: 'failed', diagnostic: persisted.cancelled ? 'cancelled' : 'missing_receipt' }; }
      for (const event of [...persisted.value].sort((left, right) => (eventEnvelope(left).sequence ?? Number.MAX_SAFE_INTEGER) - (eventEnvelope(right).sequence ?? Number.MAX_SAFE_INTEGER))) {
        traceProducerEvent(input.trace, 'persisted', event);
        const envelope = eventEnvelope(event);
        if (envelope.sequence !== undefined) { if (seenSequences.has(envelope.sequence)) continue; seenSequences.add(envelope.sequence); }
        reducer.accept(envelope.event); observeOnce(envelope.event);
        const reconciled = reducer.result;
        if (reconciled?.status === 'failed') return reconciled;
        if (reconciled?.status === 'committed') {
          commitReceipt(reconciled);
          const grace = await receiptGrace!;
          return grace.completed ? receipt! : { status: 'failed', diagnostic: grace.cancelled ? 'cancelled' : 'deadline_exceeded' };
        }
      }
      return { status: 'failed', diagnostic: 'missing_receipt' };
    } catch (error) { return { status: 'failed', diagnostic: providerDiagnostic(error) }; }
    finally {
      // The MCP command may have committed just before a lost response,
      // cancellation, or malformed receipt. The authority itself decides
      // whether this request still owns a tentative session.
      if (input.kind === 'question') input.rollbackTentativeQuestion?.(); else if (input.kind === 'replacement') input.rollbackTentativeReplacement?.(); else input.rollbackTentativeStart?.();
      this.activeSessionId = undefined;
      if (sessionId) {
        // A session is never deleted while its one native cancellation is in
        // flight. Owner disposal therefore cannot stop its runtime early.
        const teardown = this.beginTeardown(sessionId);
        try {
          // The pinned SDK receives this AbortSignal on its actual HTTP request.
          // Do not start deletion when cancellation did not settle in teardown.
          const cancelled = await untilTeardown(this.nativeCancel!, teardown.controller.signal);
          if (cancelled === 'fulfilled' && !teardown.controller.signal.aborted) {
            const deleted = await untilTeardown(this.runtime.deleteSession(sessionId, teardownOptions(teardown.controller.signal, this.teardownTimeoutMs)), teardown.controller.signal);
            if (deleted === 'fulfilled') input.observe?.({ kind: 'session-deleted' });
          }
        } finally { clearTimeout(teardown.timer); }
      }
    }
  }
  private beginTeardown(sessionId: string): { readonly controller: AbortController; readonly timer: ReturnType<typeof setTimeout> } {
    if (this.teardown) return this.teardown;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.teardownTimeoutMs);
    this.teardown = { controller, timer };
    this.nativeCancel = this.runtime.cancelTurn(sessionId, teardownOptions(controller.signal, this.teardownTimeoutMs)).catch(() => undefined);
    return this.teardown;
  }
}

function object(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined; }
function string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function idOf(value: unknown): string | undefined { const item = object(value); return string(object(item?.data)?.id) ?? string(item?.id); }
interface ProducerCall { readonly id: string; readonly name: string; readonly arguments: Record<string, unknown>; readonly provenance: boolean; }
function modelToolCalls(value: Record<string, unknown>): readonly ProducerCall[] {
  const calls = Array.isArray(value.toolCalls) ? value.toolCalls : [];
  return calls.flatMap((call) => {
    const item = object(call); const functionCall = object(item?.function); const id = string(item?.id); const name = string(functionCall?.name); const args = jsonObject(functionCall?.arguments);
    if (!id || !name || !args) return [];
    // Pinned SDK represents system tools as regular ToolCall values. Their
    // payload names the underlying MCP tool and has no independent authority.
    if (name === 'call_tool' && object(item?.toolInfo)?.type === 'truefoundry-system') {
      const server = string(args.mcp_server); const nestedName = string(args.tool_name); const nestedArgs = jsonObject(args.input);
      return nestedName && nestedArgs ? [{ id, name: nestedName, arguments: nestedArgs, provenance: server === 'codealongai-mcp' }] : [];
    }
    const toolInfo = object(item?.toolInfo);
    return [{ id, name, arguments: args, provenance: toolInfo?.type === 'mcp' && toolInfo.serverName === 'codealongai-mcp' }];
  });
}
function toolResult(value: Record<string, unknown>): { id: string; content: unknown } | undefined {
  const id = string(value.toolCallId); const content = string(value.content);
  return value.type === 'tool.response' && id && content !== undefined ? { id, content: jsonValue(content) } : undefined;
}
function receiptFrom(value: unknown): ProducerReceipt | undefined { const item = object(value); const candidate = object(item?.structuredContent) ?? item; return candidate?.schemaVersion === 1 && typeof candidate.requestId === 'string' && typeof candidate.sessionId === 'string' && typeof candidate.revision === 'number' && typeof candidate.attentionStopId === 'string' ? candidate as unknown as ProducerReceipt : undefined; }
function authorizedOrigin(value: unknown, requestId: string, kind: 'start' | 'replacement'): { path: string; startLine: number; endLine: number; sessionId?: string; revision?: number } | undefined {
  const item = object(value); const request = object(item?.structuredContent) ?? item; const input = object(request?.input); const origin = object(input?.origin); const path = string(origin?.path); const range = object(origin?.range); const start = object(range?.start); const end = object(range?.end); const startLine = finite(start?.line); const endLine = finite(end?.line);
  const startCharacter = finite(start?.character); const endCharacter = finite(end?.character);
  const expectedSessionId = string(input?.expectedSessionId); const expectedRevision = finite(input?.expectedRevision);
  const authorized = kind === 'start' ? request?.kind === 'start' && request?.authorizedAction === 'start' : request?.kind === 'replace' && request?.authorizedAction === 'replace' && expectedSessionId !== undefined && expectedRevision !== undefined;
  return request?.schemaVersion === 1 && request?.requestId === requestId && authorized && request?.status === 'pending' && path !== undefined && startLine !== undefined && startCharacter !== undefined && endLine !== undefined && endCharacter !== undefined ? { path, startLine, endLine: endCharacter === 0 ? endLine : endLine + 1, ...(kind === 'replacement' ? { sessionId: expectedSessionId, revision: expectedRevision } : {}) } : undefined;
}
/** Question authority is intentionally narrower than a start origin: the
 * producer may use only the immutable request identity and its captured
 * session version when committing. */
function authorizedQuestion(value: unknown, requestId: string): { path: string; startLine: number; endLine: number; sessionId: string; revision: number } | undefined {
  const item = object(value); const request = object(item?.structuredContent) ?? item; const input = object(request?.input);
  const sessionId = string(input?.sessionId); const revision = finite(input?.revision);
  return request?.schemaVersion === 1 && request?.requestId === requestId && request?.kind === 'question' && request?.authorizedAction === 'question' && request?.status === 'pending' && sessionId !== undefined && revision !== undefined && typeof input?.sourceStopId === 'string' ? { path: sessionId, startLine: 0, endLine: 0, sessionId, revision } : undefined;
}
function activeWalkthrough(value: Record<string, unknown>, question: { path: string; startLine: number; endLine: number } | undefined): { id: string; revision: number } | undefined {
  const snapshot = object(value.structuredContent) ?? value;
  return snapshot?.schemaVersion === 1 && snapshot?.status === 'active' && typeof snapshot.sessionId === 'string' && snapshot.sessionId === question?.path && typeof snapshot.revision === 'number' ? { id: snapshot.sessionId, revision: snapshot.revision } : undefined;
}
function exactOriginRead(value: Record<string, unknown>, origin: { path: string; startLine: number; endLine: number }): boolean {
  const result = object(value.structuredContent) ?? value;
  return result?.schemaVersion === 1 && result.path === origin.path && result.startLine === origin.startLine && result.endLine === origin.endLine && typeof result.text === 'string' && result.text.length > 0;
}
function questionContextRead(value: Record<string, unknown>, request: { path: string; startLine: number; endLine: number }): boolean {
  const result = object(value.structuredContent) ?? value;
  return result?.schemaVersion === 1 && result.path === request.path && result.startLine === request.startLine && typeof result.endLine === 'number' && result.endLine > request.startLine && result.endLine <= request.endLine && typeof result.text === 'string' && result.text.length > 0;
}
function safeToolError(value: Record<string, unknown> | undefined): string {
  const errors = Array.isArray(value?.error) ? value.error : [];
  const structured = errors.map(object).map((error) => error?.type === 'text' ? jsonObject(error.text) : undefined).find((error) => string(error?.code) === 'path_invalid' || string(error?.code) === 'range_invalid') ?? object(value?.structuredContent) ?? value;
  const code = string(structured?.code);
  return code === 'path_invalid' || code === 'range_invalid' ? code : 'tool_result_invalid';
}
function finite(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function eventEnvelope(value: unknown): { sequence: number | undefined; event: unknown } { const record = object(value); const sequence = finite(record?.sequenceNumber ?? record?.sequence_number ?? record?.sequence); return { sequence, event: object(record?.event) ?? value }; }
function terminalState(value: unknown): 'done' | 'failed' | undefined { const record = object(value); if (record?.type !== 'turn.done') return undefined; const state = object(record.state); return state?.status === 'done' ? 'done' : 'failed'; }
async function gracePeriod(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
function jsonValue(value: string): unknown { try { return JSON.parse(value); } catch { return undefined; } }
function jsonObject(value: unknown): Record<string, unknown> | undefined { return typeof value === 'string' ? object(jsonValue(value)) : object(value); }
async function beforeDeadline<T>(operation: Promise<T>, deadline: number, cancelled?: Promise<void>): Promise<{ completed: true; value: T } | { completed: false; cancelled: boolean }> {
  const remaining = deadline - Date.now(); if (remaining <= 0) return { completed: false, cancelled: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then((value) => ({ completed: true as const, value })),
      new Promise<{ completed: false; cancelled: false }>((resolve) => { timer = setTimeout(() => resolve({ completed: false, cancelled: false }), remaining); }),
      cancelled?.then(() => ({ completed: false as const, cancelled: true })) ?? new Promise<never>(() => undefined)
    ]);
  }
  finally { if (timer) clearTimeout(timer); }
}
function teardownOptions(abortSignal: AbortSignal, timeoutMs: number): TrueForgeRequestOptions { return { abortSignal, timeoutInSeconds: Math.max(0.001, timeoutMs / 1_000) }; }
function requestOptions(abortSignal: AbortSignal, deadline: number): TrueForgeRequestOptions { return teardownOptions(abortSignal, Math.max(1, deadline - Date.now())); }
export type TeardownOutcome = 'fulfilled' | 'rejected' | 'aborted';
/** Distinguishes a completed cleanup from a rejected or deadline-aborted attempt. */
export async function untilTeardown(operation: Promise<unknown>, signal: AbortSignal): Promise<TeardownOutcome> {
  if (signal.aborted) return 'aborted';
  return new Promise<TeardownOutcome>((resolve) => {
    const finish = (value: TeardownOutcome): void => { signal.removeEventListener('abort', aborted); resolve(value); };
    const aborted = (): void => finish('aborted');
    signal.addEventListener('abort', aborted, { once: true });
    operation.then(() => finish('fulfilled'), () => finish('rejected'));
  });
}
