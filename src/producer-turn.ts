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
  }
  private acceptResult(id: string, content: unknown): void {
    if (!this.pending || this.pending.id !== id) { this.failure = 'result_correlation'; return; }
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
}

/** One fresh session and one unchained turn. A receipt, not terminal prose, is success. */
export class ReceiptBackedStartCoordinator {
  private active: Promise<StartTurnResult> | undefined;
  public constructor(private readonly runtime: TrueForgeProducerRuntime, private readonly timeoutMs = 180_000) {}
  public start(input: StartTurnInput): Promise<StartTurnResult> {
    if (this.active) return this.active;
    const operation = this.run(input); this.active = operation;
    void operation.finally(() => { if (this.active === operation) this.active = undefined; });
    return operation;
  }
  private async run(input: StartTurnInput): Promise<StartTurnResult> {
    let sessionId: string | undefined;
    const deadline = Date.now() + this.timeoutMs;
    try {
      const creating = this.runtime.createSession({ agent: { spec: startProducerAgentSpec(input) } });
      const session = await beforeDeadline(creating, deadline);
      if (!session.completed) {
        // A timed-out create may still succeed after the caller has gone away.
        // Dispose that late session without retaining it in extension memory.
        void creating.then((value) => { const lateId = idOf(value); return lateId ? this.runtime.deleteSession(lateId).catch(() => undefined) : undefined; }).catch(() => undefined);
        return { status: 'failed', diagnostic: 'deadline_exceeded' };
      }
      sessionId = idOf(session.value);
      if (!sessionId) return { status: 'failed', diagnostic: 'session_unavailable' };
      const turn = await beforeDeadline(this.runtime.runTurn({ sessionId, request: { input: [{ type: 'user.message', content: `Start a walkthrough for request ID ${input.requestId}.` }], previousTurnId: 'none' } }), deadline);
      if (!turn.completed) return { status: 'failed', diagnostic: 'deadline_exceeded' };
      const turnId = idOf(turn.value);
      if (!turnId) return { status: 'failed', diagnostic: 'turn_unavailable' };
      const reducer = new StartTurnReducer(input.requestId);
      // A native stream can close between a persisted call and response. Subscribe
      // once more to the same turn; the reducer's sequence set makes that safe.
      for (let subscription = 0; subscription < 2; subscription += 1) {
        const iterator = this.runtime.events(sessionId, turnId)[Symbol.asyncIterator]();
        while (true) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) return { status: 'failed', diagnostic: 'deadline_exceeded' };
          const next = await beforeDeadline(iterator.next(), deadline);
          if (!next.completed) return { status: 'failed', diagnostic: 'deadline_exceeded' };
          if (next.value.done) break;
          reducer.accept(next.value.value);
          const result = reducer.result; if (result) return result;
        }
        const result = reducer.result; if (result) return result;
      }
      return { status: 'failed', diagnostic: 'missing_receipt' };
    } catch { return { status: 'failed', diagnostic: 'producer_error' }; }
    finally {
      if (sessionId) {
        // Start each best-effort cleanup action, but never let cleanup extend the
        // request's absolute deadline or retain the coordinator indefinitely.
        await beforeDeadline(this.runtime.cancelTurn(sessionId).catch(() => undefined), deadline);
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
function jsonValue(value: string): unknown { try { return JSON.parse(value); } catch { return undefined; } }
function jsonObject(value: unknown): Record<string, unknown> | undefined { return typeof value === 'string' ? object(jsonValue(value)) : object(value); }
async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<{ completed: true; value: T } | { completed: false }> {
  const remaining = deadline - Date.now(); if (remaining <= 0) return { completed: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation.then((value) => ({ completed: true as const, value })), new Promise<{ completed: false }>((resolve) => { timer = setTimeout(() => resolve({ completed: false }), remaining); })]); }
  finally { if (timer) clearTimeout(timer); }
}
