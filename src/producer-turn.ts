import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { TrueForgeProducerRuntime, TrueForgeRequestOptions } from './trueforge-contract';

/** The short-lived, receipt-only authority boundary for one start request. */
export interface StartTurnInput {
  /** Native Reply uses the same short-lived receipt coordinator as Ask. */
  readonly kind?: 'start' | 'question';
  readonly requestId: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly mcpUrl: string;
  /** Production supplies the extension-owned receipt validator; fixture-only
   * coordinators may omit it. */
  readonly acceptReceipt?: (receipt: StartReceipt) => boolean;
  readonly rollbackTentativeStart?: () => void;
  readonly rollbackTentativeQuestion?: () => void;
}

export type StartTurnResult = { readonly status: 'committed'; readonly receipt: StartReceipt } | { readonly status: 'failed'; readonly diagnostic: string };
export interface StartReceipt { readonly schemaVersion: 1; readonly requestId: string; readonly sessionId: string; readonly revision: number; readonly attentionStopId: string; }

const allowedReads = new Set(['codealongai_get_walkthrough_request', 'codealongai_get_walkthrough', 'codealongai_list_workspace_files', 'codealongai_read_workspace_file', 'codealongai_search_workspace']);
const startTool = 'codealongai_start_walkthrough';
const questionTool = 'codealongai_commit_question_outcome';
const permittedTools = [...allowedReads, startTool];

/** Build an inline, capability-minimal native AgentSpec. It deliberately has no
 * shell, approval, user-question, download, retry, or subagent capability. */
export function startProducerAgentSpec(input: StartTurnInput): TrueForgeApi.AgentSpec {
  const question = input.kind === 'question';
  return {
    model: { name: input.model, params: { reasoningEffort: input.reasoningEffort, parallelToolCalls: false } },
    skills: [{ name: 'codealongai' }],
    mcpServers: [{ name: 'codealongai-mcp', enableTools: question ? [...allowedReads, questionTool] : permittedTools, requireApprovalForTools: [] }],
    config: { sandbox: { enabled: true, fileDownloads: false }, dynamicSubAgents: { enabled: false }, askUserQuestions: { enabled: false }, iterationLimit: 9 },
    instructions: question ? 'Produce exactly one CodeAlongAI question outcome. First read the exact authorized question, then read the active walkthrough, then use only bounded supplemental context before one matching question-outcome transition. Use only the registered codealongai skill and MCP tools. Do not run sandbox commands, skill files, downloads, ask for approval, ask the user, retry, or create subagents.' : 'Produce exactly one CodeAlongAI start transition. Use only the registered codealongai skill and MCP tools. Do not run sandbox commands, download files, ask for approval, ask the user, retry, or create subagents.'
  };
}

/** Normalizes native and system tool events without trusting their prose. */
export class StartTurnReducer {
  private readonly seenEvents = new Set<string>();
  private pending: { id: string; name: string } | undefined;
  private readonly deferredResults = new Map<string, unknown>();
  private callsUsed = 0;
  private origin: { path: string; startLine: number; endLine: number } | undefined;
  private activeWalkthroughRead = false;
  private activeSession: { id: string; revision: number } | undefined;
  private questionRead: { path: string; startLine: number; endLine: number } | undefined;
  private receipt: StartReceipt | undefined;
  private failure: string | undefined;
  public constructor(private readonly requestId: string, private readonly acceptReceipt?: (receipt: StartReceipt) => boolean, private readonly kind: 'start' | 'question' = 'start') {}
  public accept(event: unknown): void {
    if (this.receipt || this.failure) return;
    const record = object(event); if (!record) return;
    const eventId = string(record.id);
    if (eventId !== undefined) { if (this.seenEvents.has(eventId)) return; this.seenEvents.add(eventId); }
    const type = string(record.type);
    if ((type === 'model.message' || type === 'tool.response') && (typeof record.id !== 'string' || record.threadId !== 'main')) { this.failure = 'tool_provenance'; return; }
    if (type === 'sandbox.command' || type === 'command' || type === 'approval.request' || type === 'tool.approval_required' || type === 'tool.response_required' || type === 'ask_user') { this.failure = 'unexpected_command'; return; }
    if (type === 'model.message') { const rawCalls = record.toolCalls; const calls = modelToolCalls(record); if (!Array.isArray(rawCalls) || rawCalls.length !== 1 || calls.length !== 1) { this.failure = 'tool_provenance'; return; } this.acceptCall(calls[0]); return; }
    const result = toolResult(record); if (result) this.acceptResult(result.id, result.content);
  }
  public get result(): StartTurnResult | undefined { return this.receipt ? { status: 'committed', receipt: this.receipt } : this.failure ? { status: 'failed', diagnostic: this.failure } : undefined; }
  public fail(diagnostic: string): void { if (!this.receipt) this.failure = diagnostic; }
  private acceptCall(call: ProducerCall): void {
    if (!call.provenance || this.pending) { this.failure = this.pending ? 'result_required' : 'tool_provenance'; return; }
    const { id, name, arguments: args } = call;
    const transitionTool = this.kind === 'question' ? questionTool : startTool;
    if (name !== transitionTool && ++this.callsUsed > 8) { this.failure = 'call_budget_exceeded'; return; }
    if (this.callsUsed === 1 && (name !== 'codealongai_get_walkthrough_request' || args.requestId !== this.requestId)) { this.failure = 'request_authority_required'; return; }
    if (this.callsUsed > 1 && name === 'codealongai_get_walkthrough_request') { this.failure = 'request_authority_required'; return; }
    if (name === 'codealongai_list_workspace_files' && this.listed) { this.failure = 'workspace_list_repeated'; return; }
    if (name === 'codealongai_search_workspace' && (typeof args.query !== 'string' || /[\r\n]/.test(args.query))) { this.failure = 'search_invalid'; return; }
    if (this.kind === 'start' && name === 'codealongai_read_workspace_file' && (!this.origin || args.path !== this.origin.path || args.startLine !== this.origin.startLine || args.endLine !== this.origin.endLine)) { this.failure = 'origin_range_required'; return; }
    if (this.kind === 'question' && name === 'codealongai_read_workspace_file') {
      const startLine = args.startLine; const endLine = args.endLine;
      if (typeof args.path !== 'string' || typeof startLine !== 'number' || typeof endLine !== 'number' || !Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 0 || endLine < startLine || endLine - startLine > 200) { this.failure = 'context_range_required'; return; }
      this.questionRead = { path: args.path, startLine, endLine };
    }
    if (name !== transitionTool && !allowedReads.has(name)) { this.failure = 'tool_not_allowed'; return; }
    if (this.kind === 'question' && name !== transitionTool && this.callsUsed === 2 && name !== 'codealongai_get_walkthrough') { this.failure = 'active_walkthrough_required'; return; }
    if (name === transitionTool && (args.requestId !== this.requestId || this.transitioned || this.callsUsed === 0 || (this.kind === 'start' ? !this.originRead : !this.activeWalkthroughRead) || (this.kind === 'question' && (args.expectedSessionId !== this.activeSession?.id || args.expectedRevision !== this.activeSession?.revision)))) { this.failure = this.callsUsed === 0 ? 'request_authority_required' : 'transition_invalid'; return; }
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
    if (pending.name === 'codealongai_get_walkthrough_request') { this.origin = this.kind === 'question' ? authorizedQuestion(result, this.requestId) : authorizedOrigin(result, this.requestId); if (!this.origin) { this.failure = 'request_authority_invalid'; return; } }
    if (this.kind === 'question' && pending.name === 'codealongai_get_walkthrough') { const active = activeWalkthrough(result, this.origin); if (!active) { this.failure = 'active_walkthrough_invalid'; return; } this.activeSession = active; this.activeWalkthroughRead = true; }
    if (pending.name === 'codealongai_read_workspace_file') {
      const expected = this.kind === 'question' ? this.questionRead : this.origin;
      if (!expected || !exactOriginRead(result, expected)) { this.failure = this.kind === 'question' ? 'context_read_invalid' : 'origin_read_invalid'; return; }
      this.originRead = true;
    }
    if (pending.name !== (this.kind === 'question' ? questionTool : startTool)) return;
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

/** One fresh session and one unchained turn. A receipt, not terminal prose, is success. */
export class ReceiptBackedStartCoordinator {
  private active: Promise<StartTurnResult> | undefined;
  private cleanup: Promise<StartTurnResult> | undefined;
  private publish: ((result: StartTurnResult) => void) | undefined;
  private activeSessionId: string | undefined;
  private cancelled = false;
  private cancelWaiter: (() => void) | undefined;
  private readonly cancelledSignal = new Promise<void>((resolve) => { this.cancelWaiter = resolve; });
  private readonly abort = new AbortController();
  private nativeCancel: Promise<void> | undefined;
  private teardown: { readonly controller: AbortController; readonly timer: ReturnType<typeof setTimeout> } | undefined;
  public constructor(private readonly runtime: TrueForgeProducerRuntime, private readonly timeoutMs = 180_000, private readonly waitForGrace: (milliseconds: number, signal?: AbortSignal) => Promise<void> = gracePeriod, private readonly teardownTimeoutMs = 5_000) {}
  public start(input: StartTurnInput): Promise<StartTurnResult> {
    if (this.active) return this.active;
    let publish!: (result: StartTurnResult) => void;
    const visible = new Promise<StartTurnResult>((resolve) => { publish = resolve; });
    this.publish = publish;
    const cleanup = this.run(input, publish);
    this.active = visible; this.cleanup = cleanup;
    void cleanup.then(publish, () => publish({ status: 'failed', diagnostic: 'producer_error' })).finally(() => {
      if (this.cleanup === cleanup) { this.active = undefined; this.cleanup = undefined; this.publish = undefined; }
    });
    return visible;
  }
  /** Completion of the bounded ownership/cleanup lease, not user-visible success. */
  public get settled(): Promise<StartTurnResult> | undefined { return this.cleanup; }
  /** Wake every producer wait immediately. Cleanup remains owned by run(). */
  public cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.publish?.({ status: 'failed', diagnostic: 'cancelled' });
    this.cancelWaiter?.();
    this.abort.abort();
    if (this.activeSessionId) this.beginTeardown(this.activeSessionId);
  }
  private async run(input: StartTurnInput, publish: (result: StartTurnResult) => void): Promise<StartTurnResult> {
    let sessionId: string | undefined;
    const deadline = Date.now() + this.timeoutMs;
    try {
      const creating = this.runtime.createSession({ agent: { spec: startProducerAgentSpec(input) } }, teardownOptions(this.abort.signal, this.timeoutMs));
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
      sessionId = idOf(session.value); this.activeSessionId = sessionId;
      if (this.cancelled) return { status: 'failed', diagnostic: 'cancelled' };
      if (!sessionId) return { status: 'failed', diagnostic: 'session_unavailable' };
      const turn = await beforeDeadline(this.runtime.runTurn({ sessionId, request: { input: [{ type: 'user.message', content: `${input.kind ?? 'start'}\n${input.requestId}` }], previousTurnId: 'none' }, options: requestOptions(this.abort.signal, deadline) }), deadline, this.cancelledSignal);
      if (!turn.completed) { if (!turn.cancelled) this.abort.abort(); return { status: 'failed', diagnostic: turn.cancelled ? 'cancelled' : 'deadline_exceeded' }; }
      const turnId = idOf(turn.value);
      if (!turnId) return { status: 'failed', diagnostic: 'turn_unavailable' };
      const reducer = new StartTurnReducer(input.requestId, input.acceptReceipt, input.kind ?? 'start');
      let lastSequence = -1;
      const seenSequences = new Set<number>();
      let receipt: Extract<StartTurnResult, { status: 'committed' }> | undefined;
      let receiptGrace: Promise<{ completed: true; value: void } | { completed: false; cancelled: boolean }> | undefined;
      let reconciliationCutoff: number | undefined;
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
          const nextEvent = beforeDeadline(iterator.next(), eventDeadline, this.cancelledSignal).then((value) => ({ kind: 'event' as const, value })).catch(() => interrupted);
          const next = await (receiptGrace ? Promise.race([nextEvent, receiptGrace.then((value) => ({ kind: 'grace' as const, value }))]) : nextEvent);
          if ('interrupted' in next) {
            if (this.cancelled) return { status: 'failed', diagnostic: 'cancelled' };
            if (Date.now() >= deadline) { this.abort.abort(); return { status: 'failed', diagnostic: 'deadline_exceeded' }; }
            if (subscription === 0) { recoverableEof = true; break; }
            return { status: 'failed', diagnostic: 'producer_error' };
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
          const envelope = eventEnvelope(next.value.value.value);
          if (envelope.sequence !== undefined) { if (seenSequences.has(envelope.sequence)) continue; seenSequences.add(envelope.sequence); lastSequence = Math.max(lastSequence, envelope.sequence); }
          reducer.accept(envelope.event);
          const result = reducer.result;
          if (result?.status === 'failed') return result;
          if (result?.status === 'committed') { receipt = result; publish(receipt); receiptGrace ??= beforeDeadline(this.waitForGrace(5_000, this.abort.signal), deadline, this.cancelledSignal); }
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
        const result = reducer.result; if (result?.status === 'failed') return result; if (result?.status === 'committed') { receipt = result; publish(receipt); }
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
            const envelope = eventEnvelope(event);
            if (envelope.sequence !== undefined) { if (seenSequences.has(envelope.sequence)) continue; seenSequences.add(envelope.sequence); lastSequence = Math.max(lastSequence, envelope.sequence); }
            reducer.accept(envelope.event);
            const reconciled = reducer.result;
            if (reconciled?.status === 'failed') return reconciled;
            if (reconciled?.status === 'committed') { receipt = reconciled; publish(receipt); receiptGrace ??= beforeDeadline(this.waitForGrace(5_000, this.abort.signal), deadline, this.cancelledSignal); }
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
        const envelope = eventEnvelope(event);
        if (envelope.sequence !== undefined) { if (seenSequences.has(envelope.sequence)) continue; seenSequences.add(envelope.sequence); }
        reducer.accept(envelope.event);
        const reconciled = reducer.result;
        if (reconciled?.status === 'failed') return reconciled;
        if (reconciled?.status === 'committed') {
          publish(reconciled);
          const grace = await beforeDeadline(this.waitForGrace(5_000, this.abort.signal), deadline, this.cancelledSignal);
          return grace.completed ? reconciled : { status: 'failed', diagnostic: grace.cancelled ? 'cancelled' : 'deadline_exceeded' };
        }
      }
      return { status: 'failed', diagnostic: 'missing_receipt' };
    } catch { return { status: 'failed', diagnostic: 'producer_error' }; }
    finally {
      // The MCP command may have committed just before a lost response,
      // cancellation, or malformed receipt. The authority itself decides
      // whether this request still owns a tentative session.
      if (input.kind === 'question') input.rollbackTentativeQuestion?.(); else input.rollbackTentativeStart?.();
      this.activeSessionId = undefined;
      if (sessionId) {
        // A session is never deleted while its one native cancellation is in
        // flight. Owner disposal therefore cannot stop its runtime early.
        const teardown = this.beginTeardown(sessionId);
        try {
          // The pinned SDK receives this AbortSignal on its actual HTTP request.
          // Do not start deletion when cancellation did not settle in teardown.
          const cancelled = await untilTeardown(this.nativeCancel!, teardown.controller.signal);
          if (cancelled && !teardown.controller.signal.aborted) await untilTeardown(this.runtime.deleteSession(sessionId, teardownOptions(teardown.controller.signal, this.teardownTimeoutMs)), teardown.controller.signal);
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
function receiptFrom(value: unknown): StartReceipt | undefined { const item = object(value); const candidate = object(item?.structuredContent) ?? item; return candidate?.schemaVersion === 1 && typeof candidate.requestId === 'string' && typeof candidate.sessionId === 'string' && typeof candidate.revision === 'number' && typeof candidate.attentionStopId === 'string' ? candidate as unknown as StartReceipt : undefined; }
function authorizedOrigin(value: unknown, requestId: string): { path: string; startLine: number; endLine: number } | undefined {
  const item = object(value); const request = object(item?.structuredContent) ?? item; const input = object(request?.input); const origin = object(input?.origin); const path = string(origin?.path); const range = object(origin?.range); const start = object(range?.start); const end = object(range?.end); const startLine = finite(start?.line); const endLine = finite(end?.line);
  const startCharacter = finite(start?.character); const endCharacter = finite(end?.character);
  return request?.schemaVersion === 1 && request?.requestId === requestId && request?.kind === 'start' && request?.authorizedAction === 'start' && request?.status === 'pending' && path !== undefined && startLine !== undefined && startCharacter !== undefined && endLine !== undefined && endCharacter !== undefined ? { path, startLine, endLine: endCharacter === 0 ? endLine : endLine + 1 } : undefined;
}
/** Question authority is intentionally narrower than a start origin: the
 * producer may only use the immutable request identity and must subsequently
 * prove it read the currently active session before committing. */
function authorizedQuestion(value: unknown, requestId: string): { path: string; startLine: number; endLine: number } | undefined {
  const item = object(value); const request = object(item?.structuredContent) ?? item; const input = object(request?.input);
  return request?.schemaVersion === 1 && request?.requestId === requestId && request?.kind === 'question' && request?.authorizedAction === 'question' && request?.status === 'pending' && typeof input?.sessionId === 'string' && typeof input?.sourceStopId === 'string' ? { path: input.sessionId, startLine: 0, endLine: 0 } : undefined;
}
function activeWalkthrough(value: Record<string, unknown>, question: { path: string; startLine: number; endLine: number } | undefined): { id: string; revision: number } | undefined {
  const snapshot = object(value.structuredContent) ?? value;
  return snapshot?.schemaVersion === 1 && snapshot?.status === 'active' && typeof snapshot.sessionId === 'string' && snapshot.sessionId === question?.path && typeof snapshot.revision === 'number' ? { id: snapshot.sessionId, revision: snapshot.revision } : undefined;
}
function exactOriginRead(value: Record<string, unknown>, origin: { path: string; startLine: number; endLine: number }): boolean {
  const result = object(value.structuredContent) ?? value;
  return result?.schemaVersion === 1 && result.path === origin.path && result.startLine === origin.startLine && result.endLine === origin.endLine && typeof result.text === 'string' && result.text.length > 0;
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
async function untilTeardown(operation: Promise<unknown>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise<boolean>((resolve) => {
    const finish = (value: boolean): void => { signal.removeEventListener('abort', aborted); resolve(value); };
    const aborted = (): void => finish(false);
    signal.addEventListener('abort', aborted, { once: true });
    operation.then(() => finish(true), () => finish(!signal.aborted));
  });
}
