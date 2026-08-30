import type { TrueForgeProducerReadinessResult, TrueForgeProducerRuntime, TrueForgeRuntime, TrueForgeStartOptions } from '../trueforge';
import type { DaytonaProbeResult } from '../daytona';
import type { WalkthroughSession } from '../walkthrough';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { deterministicQuestionOutcome } from './question-outcome-fixture';

export const emptyTrueForgeProducer: TrueForgeProducerRuntime = {
  discoverConfiguration: async () => [], discoverProviders: async () => [], discoverModels: async () => [], discoverSkills: async () => [],
  createSession: async () => ({}), runTurn: async () => ({}), events: async function* () { yield {}; }, listTurnEvents: async () => [], cancelTurn: async () => undefined, deleteSession: async () => undefined
  , probeDaytona: async () => ({ provider: 'daytona', phase: 'provider', outcome: 'failed' }), prepareProducer: async () => ({ phase: 'model', outcome: 'failed' })
};

/** Contract-faithful external-runtime double for public Configure command tests. */
export class TrueForgeRuntimeDouble implements TrueForgeRuntime {
  public readonly calls: string[] = [];
  public healthy = true;
  public owned = true;
  public failStart = false;
  public probeCalls = 0;
  public prepareCalls = 0;
  public concurrentPrepares = 0;
  public maximumConcurrentPrepares = 0;
  public prepareWait: Promise<void> | undefined;
  public daytonaProbe: DaytonaProbeResult = { provider: 'daytona', phase: 'ready', outcome: 'ready' };
  public producerReadiness: TrueForgeProducerReadinessResult = { phase: 'ready', outcome: 'ready' };
  public readonly producerTurnCalls: { readonly producer: TrueForgeProducerRuntime; readonly kind: 'session' | 'turn' | 'events' }[] = [];
  /** Deferred only by Extension Host ownership tests; production-shaped events
   * still follow once it is released. */
  public producerEventWait: Promise<void> | undefined;
  public producerCancelWait: Promise<void> | undefined;
  public producerCancelCalls = 0;
  public producerCancelled = false;
  public producerEventError: Error | undefined;
  public mcpPort: number | undefined;
  public reportUnexpectedExitForTests: ((message: string) => void) | undefined;
  private producerIdentity: TrueForgeProducerRuntime | undefined;
  public get producer(): TrueForgeProducerRuntime {
    const runtime = this;
    let spec: Record<string, unknown> | undefined;
    let turn: Record<string, unknown> | undefined;
    const producer: TrueForgeProducerRuntime = {
      ...emptyTrueForgeProducer,
      createSession: async (request) => { runtime.producerCancelled = false; runtime.producerTurnCalls.push({ producer, kind: 'session' }); spec = request as Record<string, unknown>; return { data: { id: 'test-session' } }; },
      runTurn: async (input) => { runtime.producerTurnCalls.push({ producer, kind: 'turn' }); turn = input.request as Record<string, unknown>; return { data: { id: 'test-turn' } }; },
      events: async function* () {
        runtime.producerTurnCalls.push({ producer, kind: 'events' });
        await runtime.producerEventWait;
        if (runtime.producerEventError) throw runtime.producerEventError;
        if (runtime.producerCancelled) return;
        const text = (((turn?.input as readonly { content?: unknown }[] | undefined)?.[0])?.content);
        const question = typeof text === 'string' && text.includes('follow-up question');
        const replacement = typeof text === 'string' && text.includes('replace a walkthrough');
        const requestId = typeof text === 'string' ? /^.*?ID "([^"]+)"/.exec(text)?.[1] : undefined;
        if (!requestId || runtime.mcpPort === undefined) return;
        if (question) {
          const agent = ((spec?.agent as { spec?: { skills?: { name?: string }[]; mcpServers?: { enableTools?: string[] }[]; config?: { sandbox?: { fileDownloads?: boolean }; dynamicSubAgents?: { enabled?: boolean }; askUserQuestions?: { enabled?: boolean } }; model?: { params?: { parallelToolCalls?: boolean } } } } | undefined)?.spec);
          const tools = agent?.mcpServers?.[0]?.enableTools ?? [];
          if (agent?.skills?.[0]?.name !== 'codealongai' || !tools.includes('codealongai_commit_question_outcome') || tools.includes('codealongai_start_walkthrough') || agent.config?.sandbox?.fileDownloads !== false || agent.config?.dynamicSubAgents?.enabled !== false || agent.config?.askUserQuestions?.enabled !== false || agent.model?.params?.parallelToolCalls !== false) throw new Error('question_agent_spec_invalid');
        }
        const port = runtime.mcpPort;
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
        const client = new Client({ name: 'TrueForge runtime double', version: '0.0.1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(transport);
        try {
          const call = (id: string, name: string, args: object, at: string) => ({ type: 'model.message', id: `call-${id}`, threadId: 'main', createdAt: at, toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) }, toolInfo: { type: 'mcp', name, serverId: 'test', serverName: 'codealongai-mcp' } }] });
          const response = (id: string, result: unknown, at: string) => ({ type: 'tool.response', id: `response-${id}`, threadId: 'main', createdAt: at, toolCallId: id, content: JSON.stringify(result) });
          yield call('authority', 'codealongai_get_walkthrough_request', { schemaVersion: 1, requestId }, '2026-01-01T00:00:00.000Z');
          const authority = await client.callTool({ name: 'codealongai_get_walkthrough_request', arguments: { schemaVersion: 1, requestId } });
          yield response('authority', authority, '2026-01-01T00:00:01.000Z');
          if (question) {
            yield call('walkthrough', 'codealongai_get_walkthrough', {}, '2026-01-01T00:00:02.000Z');
            const walkthrough = await client.callTool({ name: 'codealongai_get_walkthrough', arguments: {} });
            yield response('walkthrough', walkthrough, '2026-01-01T00:00:03.000Z');
            yield call('context', 'codealongai_read_workspace_file', { schemaVersion: 1, path: 'checkout.ts', startLine: 2, endLine: 3 }, '2026-01-01T00:00:03.250Z');
            const context = await client.callTool({ name: 'codealongai_read_workspace_file', arguments: { schemaVersion: 1, path: 'checkout.ts', startLine: 2, endLine: 3 } });
            yield response('context', context, '2026-01-01T00:00:03.500Z');
            const snapshot = walkthrough.structuredContent as { sessionId?: string; revision?: number } | undefined;
            const request = authority.structuredContent as { input?: { sourceStopId?: string } } | undefined;
            if (!snapshot?.sessionId || typeof snapshot.revision !== 'number' || !request?.input?.sourceStopId) return;
            const source = request.input.sourceStopId;
            const outcome = deterministicQuestionOutcome({ stops: (walkthrough.structuredContent as { stops?: WalkthroughSession['stops'] }).stops ?? [] });
            const commit = { schemaVersion: 1, requestId, expectedSessionId: snapshot.sessionId, expectedRevision: snapshot.revision, outcome };
            yield call('question', 'codealongai_commit_question_outcome', commit, '2026-01-01T00:00:04.000Z');
            const committed = await client.callTool({ name: 'codealongai_commit_question_outcome', arguments: commit });
            yield response('question', committed, '2026-01-01T00:00:05.000Z');
            yield { type: 'turn.done', id: 'done', state: { status: 'done' } };
          return;
        }
        if (replacement) {
          const agent = ((spec?.agent as { spec?: { mcpServers?: { enableTools?: string[] }[] } } | undefined)?.spec);
          const tools = agent?.mcpServers?.[0]?.enableTools ?? [];
          if (!tools.includes('codealongai_replace_walkthrough') || tools.includes('codealongai_start_walkthrough')) throw new Error('replacement_agent_spec_invalid');
        }
          const origin = (authority.structuredContent as { input?: { origin?: { path?: string; range?: unknown } } } | undefined)?.input?.origin;
          if (!origin?.path || !origin.range) return;
          const interval = origin.range as { start: { line: number }; end: { line: number; character: number } };
          const endLine = interval.end.character === 0 ? interval.end.line : interval.end.line + 1;
          yield call('origin', 'codealongai_read_workspace_file', { schemaVersion: 1, path: origin.path, startLine: interval.start.line, endLine }, '2026-01-01T00:00:02.000Z');
          const read = await client.callTool({ name: 'codealongai_read_workspace_file', arguments: { schemaVersion: 1, path: origin.path, startLine: interval.start.line, endLine } });
          yield response('origin', read, '2026-01-01T00:00:03.000Z');
          const transition = replacement ? { schemaVersion: 1, requestId, expectedSessionId: (authority.structuredContent as { input?: { expectedSessionId?: string } } | undefined)?.input?.expectedSessionId, expectedRevision: (authority.structuredContent as { input?: { expectedRevision?: number } } | undefined)?.input?.expectedRevision, origin: { stopId: 'checkout-origin', displayName: 'Origin', explanation: 'What would you like to understand about this code?', document: origin.path, range: origin.range } } : { schemaVersion: 1, requestId, origin: { stopId: 'checkout-origin', displayName: 'Origin', explanation: 'What would you like to understand about this code?', document: origin.path, range: origin.range } };
          const tool = replacement ? 'codealongai_replace_walkthrough' : 'codealongai_start_walkthrough';
          yield call('transition', tool, transition, '2026-01-01T00:00:04.000Z');
          const committed = await client.callTool({ name: tool, arguments: transition });
          yield response('transition', committed, '2026-01-01T00:00:05.000Z');
          yield { type: 'turn.done', id: 'done', state: { status: 'done' } };
        } finally { await transport.close(); }
      },
      cancelTurn: async () => { runtime.producerCancelCalls += 1; runtime.producerCancelled = true; await runtime.producerCancelWait; },
      probeDaytona: async () => { this.probeCalls += 1; return this.daytonaProbe; }, prepareProducer: async () => { this.prepareCalls += 1; this.concurrentPrepares += 1; this.maximumConcurrentPrepares = Math.max(this.maximumConcurrentPrepares, this.concurrentPrepares); try { await this.prepareWait; return this.producerReadiness; } finally { this.concurrentPrepares -= 1; } }
    };
    return this.producerIdentity ??= producer;
  }
  public replaceProducerForTests(): void { this.producerIdentity = undefined; }
  /** Simulates the owned child dying; the production callback decides recovery. */
  public crashForTests(): void { this.reportUnexpectedExitForTests?.('TrueForge sidecar exited unexpectedly (code 1).'); }
  public async start(options: TrueForgeStartOptions): Promise<void> { this.calls.push(`start:${options.port}`); if (this.failStart) throw new Error('configured test sidecar failure'); }
  public async health(): Promise<boolean> { return this.healthy; }
  public async verifyCapability(): Promise<boolean> { return this.healthy; }
  public hasExited(): boolean { return false; }
  public async ownsRunningChild(): Promise<boolean> { return this.owned; }
  public async open(url: string): Promise<void> { this.calls.push(`open:${url}`); }
  public async stop(): Promise<void> { this.calls.push('stop'); }
}
