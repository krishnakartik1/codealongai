import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { TrueForgeProducerRuntime } from './trueforge-contract';

/** The short-lived, receipt-only authority boundary for one start request. */
export interface StartTurnInput {
  readonly requestId: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly mcpUrl: string;
}

export type StartTurnResult = { readonly status: 'committed'; readonly receipt: StartReceipt } | { readonly status: 'failed'; readonly diagnostic: string };
export interface StartReceipt { readonly schemaVersion: 1; readonly requestId: string; readonly sessionId: string; readonly revision: number; readonly attentionStopId: string; }

const allowedReads = new Set(['codealongai_get_walkthrough_request', 'codealongai_get_walkthrough', 'codealongai_list_workspace_files', 'codealongai_read_workspace_file', 'codealongai_search_workspace']);
const startTool = 'codealongai_start_walkthrough';

/** Build an inline, capability-minimal native AgentSpec. It deliberately has no
 * shell, approval, user-question, download, retry, or subagent capability. */
export function startProducerAgentSpec(input: StartTurnInput): TrueForgeApi.AgentSpec {
  return {
    model: { name: input.model, params: { reasoningEffort: input.reasoningEffort, parallelToolCalls: false } },
    skills: [{ name: 'codealongai' }],
    mcpServers: [{ name: 'codealongai-mcp', enableTools: ['@all'], requireApprovalForTools: [] }],
    config: { sandbox: { enabled: true, fileDownloads: false }, dynamicSubAgents: { enabled: false }, askUserQuestions: { enabled: false }, iterationLimit: 8 },
    instructions: 'Produce exactly one CodeAlongAI start transition. Use only the registered codealongai skill and MCP tools. Do not run sandbox commands, download files, ask for approval, ask the user, retry, or create subagents.'
  };
}

/** Normalizes native and system tool events without trusting their prose. */
export class StartTurnReducer {
  private readonly seenEvents = new Set<string>();
  private pending: { id: string; name: string } | undefined;
  private readonly deferredResults = new Map<string, unknown>();
  private callsUsed = 0;
  private origin: { path: string; startLine: number; endLine: number } | undefined;
  private receipt: StartReceipt | undefined;
  private failure: string | undefined;
  public constructor(private readonly requestId: string) {}
  public accept(event: unknown): void {
    if (this.receipt || this.failure) return;
    const record = object(event); if (!record) return;
    const eventId = string(record.id);
    if (eventId !== undefined) { if (this.seenEvents.has(eventId)) return; this.seenEvents.add(eventId); }
    const type = string(record.type);
    if (type === 'sandbox.command' || type === 'command' || type === 'approval.request' || type === 'ask_user') { this.failure = 'unexpected_command'; return; }
    if (type === 'model.message') { const calls = modelToolCalls(record); if (calls.length !== 1) { if (Array.isArray(record.toolCalls) && record.toolCalls.length > 0) this.failure = 'tool_provenance'; return; } this.acceptCall(calls[0]); return; }
    const result = toolResult(record); if (result) this.acceptResult(result.id, result.content);
  }
  public get result(): StartTurnResult | undefined { return this.receipt ? { status: 'committed', receipt: this.receipt } : this.failure ? { status: 'failed', diagnostic: this.failure } : undefined; }
  public fail(diagnostic: string): void { if (!this.receipt) this.failure = diagnostic; }
  private acceptCall(call: ProducerCall): void {
    if (!call.provenance || this.pending) { this.failure = this.pending ? 'result_required' : 'tool_provenance'; return; }
    const { id, name, arguments: args } = call;
    if (++this.callsUsed > 8) { this.failure = 'call_budget_exceeded'; return; }
    if (this.callsUsed === 1 && (name !== 'codealongai_get_walkthrough_request' || args.requestId !== this.requestId)) { this.failure = 'request_authority_required'; return; }
    if (this.callsUsed > 1 && name === 'codealongai_get_walkthrough_request') { this.failure = 'request_authority_required'; return; }
    if (name === 'codealongai_list_workspace_files' && this.listed) { this.failure = 'workspace_list_repeated'; return; }
    if (name === 'codealongai_search_workspace' && (typeof args.query !== 'string' || /[\r\n]/.test(args.query))) { this.failure = 'search_invalid'; return; }
    if (name === 'codealongai_read_workspace_file' && (!this.origin || args.path !== this.origin.path || args.startLine !== this.origin.startLine || args.endLine !== this.origin.endLine)) { this.failure = 'origin_range_required'; return; }
    if (name !== startTool && !allowedReads.has(name)) { this.failure = 'tool_not_allowed'; return; }
    if (name === startTool && (args.requestId !== this.requestId || this.transitioned)) { this.failure = 'transition_invalid'; return; }
    if (name === 'codealongai_list_workspace_files') this.listed = true;
    if (name === startTool) this.transitioned = true;
    this.pending = { id, name };
    const deferred = this.deferredResults.get(id);
    if (deferred !== undefined) { this.deferredResults.delete(id); this.acceptResult(id, deferred); }
  }
  private acceptResult(id: string, content: unknown): void {
    if (!this.pending) { this.deferredResults.set(id, content); return; }
    if (this.pending.id !== id) { this.failure = 'result_correlation'; return; }
    const pending = this.pending; this.pending = undefined;
    const result = object(content); if (!result || result.isError === true) { this.failure = 'tool_result_invalid'; return; }
    if (pending.name === 'codealongai_get_walkthrough_request') { this.origin = authorizedOrigin(result); if (!this.origin) { this.failure = 'request_authority_invalid'; return; } }
    if (pending.name !== startTool) return;
    const receipt = receiptFrom(content);
    if (!receipt || receipt.requestId !== this.requestId) { this.failure = 'missing_receipt'; return; }
    this.receipt = receipt;
  }
  private listed = false;
  private transitioned = false;
  public get hasReceipt(): boolean { return this.receipt !== undefined; }
}

/** One fresh session and one unchained turn. A receipt, not terminal prose, is success. */
export class ReceiptBackedStartCoordinator {
  private active: Promise<StartTurnResult> | undefined;
  private activeSessionId: string | undefined;
  private cancelled = false;
  private cancelWaiter: (() => void) | undefined;
  private readonly cancelledSignal = new Promise<void>((resolve) => { this.cancelWaiter = resolve; });
  public constructor(private readonly runtime: TrueForgeProducerRuntime, private readonly timeoutMs = 180_000, private readonly waitForGrace: (milliseconds: number) => Promise<void> = gracePeriod) {}
  public start(input: StartTurnInput): Promise<StartTurnResult> {
    if (this.active) return this.active;
    const operation = this.run(input); this.active = operation;
    void operation.finally(() => { if (this.active === operation) this.active = undefined; });
    return operation;
  }
  /** Wake every producer wait immediately. Cleanup remains owned by run(). */
  public cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.cancelWaiter?.();
    if (this.activeSessionId) void this.runtime.cancelTurn(this.activeSessionId).catch(() => undefined);
  }
  private async run(input: StartTurnInput): Promise<StartTurnResult> {
    let sessionId: string | undefined;
    const deadline = Date.now() + this.timeoutMs;
    try {
      const creating = this.runtime.createSession({ agent: { spec: startProducerAgentSpec(input) } });
      const session = await beforeDeadline(creating, deadline, this.cancelledSignal);
      if (!session.completed) {
        // A timed-out create may still succeed after the caller has gone away.
        // Dispose that late session without retaining it in extension memory.
        void creating.then((value) => { const lateId = idOf(value); return lateId ? this.runtime.deleteSession(lateId).catch(() => undefined) : undefined; }).catch(() => undefined);
        return { status: 'failed', diagnostic: session.cancelled ? 'cancelled' : 'deadline_exceeded' };
      }
      sessionId = idOf(session.value); this.activeSessionId = sessionId;
      if (this.cancelled) return { status: 'failed', diagnostic: 'cancelled' };
      if (!sessionId) return { status: 'failed', diagnostic: 'session_unavailable' };
      const turn = await beforeDeadline(this.runtime.runTurn({ sessionId, request: { input: [{ type: 'user.message', content: `Start a walkthrough for request ID ${input.requestId}.` }], previousTurnId: 'none' } }), deadline, this.cancelledSignal);
      if (!turn.completed) return { status: 'failed', diagnostic: turn.cancelled ? 'cancelled' : 'deadline_exceeded' };
      const turnId = idOf(turn.value);
      if (!turnId) return { status: 'failed', diagnostic: 'turn_unavailable' };
      const reducer = new StartTurnReducer(input.requestId);
      let lastSequence = -1;
      let receipt: Extract<StartTurnResult, { status: 'committed' }> | undefined;
      // A native stream can close between a persisted call and response. Subscribe
      // once more to the same turn; the reducer's sequence set makes that safe.
      for (let subscription = 0; subscription < 2; subscription += 1) {
        const iterator = this.runtime.events(sessionId, turnId, lastSequence < 0 ? undefined : lastSequence)[Symbol.asyncIterator]();
        while (true) {
          if (this.cancelled) return { status: 'failed', diagnostic: 'cancelled' };
          const remaining = deadline - Date.now();
          if (remaining <= 0) return { status: 'failed', diagnostic: 'deadline_exceeded' };
          const next = await beforeDeadline(iterator.next(), deadline, this.cancelledSignal);
          if (!next.completed) return { status: 'failed', diagnostic: next.cancelled ? 'cancelled' : 'deadline_exceeded' };
          // Cancellation may have arrived while the native iterator was
          // blocked. Do not let its subsequently delivered receipt commit.
          if (this.cancelled) return { status: 'failed', diagnostic: 'cancelled' };
          if (next.value.done) break;
          const envelope = eventEnvelope(next.value.value);
          if (envelope.sequence !== undefined) { if (envelope.sequence <= lastSequence) continue; lastSequence = envelope.sequence; }
          reducer.accept(envelope.event);
          const result = reducer.result;
          if (result?.status === 'failed') return result;
          if (result?.status === 'committed') receipt = result;
          const terminal = terminalState(envelope.event);
          if (terminal === 'failed') return { status: 'failed', diagnostic: 'terminal_error' };
          if (terminal === 'done' && receipt) return receipt;
        }
        const result = reducer.result; if (result?.status === 'failed') return result; if (result?.status === 'committed') receipt = result;
        // The stream may have ended between persisted events. Reconcile once
        // before the one permitted cursor-resubscription.
        if (subscription === 0) {
          const persisted = await beforeDeadline(this.runtime.listTurnEvents(sessionId, turnId).catch(() => []), deadline, this.cancelledSignal);
          if (!persisted.completed) return { status: 'failed', diagnostic: persisted.cancelled ? 'cancelled' : 'deadline_exceeded' };
          // Persisted history is authoritative for causality, not merely a
          // cursor continuation: it can contain a call missed before a live
          // response with a higher sequence. Stable event ids make replay safe.
          for (const event of [...persisted.value].sort((left, right) => (eventEnvelope(left).sequence ?? Number.MAX_SAFE_INTEGER) - (eventEnvelope(right).sequence ?? Number.MAX_SAFE_INTEGER))) {
            const envelope = eventEnvelope(event);
            if (envelope.sequence !== undefined) lastSequence = Math.max(lastSequence, envelope.sequence);
            reducer.accept(envelope.event);
            const reconciled = reducer.result;
            if (reconciled?.status === 'failed') return reconciled;
            if (reconciled?.status === 'committed') receipt = reconciled;
            const terminal = terminalState(envelope.event);
            if (terminal === 'failed') return { status: 'failed', diagnostic: 'terminal_error' };
            if (terminal === 'done' && receipt) return receipt;
          }
        }
      }
      if (receipt) { await this.waitForGrace(Math.min(5_000, Math.max(0, deadline - Date.now()))); return receipt; }
      return { status: 'failed', diagnostic: 'missing_receipt' };
    } catch { return { status: 'failed', diagnostic: 'producer_error' }; }
    finally {
      this.activeSessionId = undefined;
      if (sessionId) {
        // Start each best-effort cleanup action, but never let cleanup extend the
        // request's absolute deadline or retain the coordinator indefinitely.
        if (!this.cancelled) await beforeDeadline(this.runtime.cancelTurn(sessionId).catch(() => undefined), deadline);
        await beforeDeadline(this.runtime.deleteSession(sessionId).catch(() => undefined), deadline);
      }
    }
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
function authorizedOrigin(value: unknown): { path: string; startLine: number; endLine: number } | undefined {
  const item = object(value); const request = object(item?.structuredContent) ?? item; const input = object(request?.input); const origin = object(input?.origin); const path = string(origin?.path); const range = object(origin?.range); const start = object(range?.start); const end = object(range?.end); const startLine = finite(start?.line); const endLine = finite(end?.line);
  return path !== undefined && startLine !== undefined && endLine !== undefined ? { path, startLine, endLine: endLine + 1 } : undefined;
}
function finite(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function eventEnvelope(value: unknown): { sequence: number | undefined; event: unknown } { const record = object(value); const sequence = finite(record?.sequenceNumber ?? record?.sequence_number ?? record?.sequence); return { sequence, event: object(record?.event) ?? value }; }
function terminalState(value: unknown): 'done' | 'failed' | undefined { const record = object(value); if (record?.type !== 'turn.done') return undefined; const state = object(record.state); return state?.status === 'done' ? 'done' : 'failed'; }
async function gracePeriod(milliseconds: number): Promise<void> { if (milliseconds <= 0) return; await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)); }
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
