import type { TrueForgeProducerReadinessResult, TrueForgeProducerRuntime, TrueForgeRuntime, TrueForgeStartOptions } from '../trueforge';
import type { DaytonaProbeResult } from '../daytona';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

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
        const question = typeof text === 'string' && text.startsWith('question\n');
        const requestId = typeof text === 'string' && (text.startsWith('start\n') || question) ? text.slice(text.indexOf('\n') + 1) : undefined;
        if (!requestId || runtime.mcpPort === undefined) return;
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
            const knownStops = (walkthrough.structuredContent as { stops?: { id: string }[] }).stops?.map((stop) => stop.id) ?? [];
            const outcome = knownStops.includes('initial-value') ? { kind: 'explanation-only', answerMarkdown: 'This follow-up stays attached to the current walkthrough stop.' } : knownStops.includes('pricing-function') ? { kind: 'generated-walkthrough', answerMarkdown: 'The reducer begins with its initial value.', patch: { addedStops: [{ id: 'initial-value', displayName: 'Initial value', explanationMarkdown: 'The reduction starts from its initial value.', path: 'pricing.ts', range: { start: { line: 1, character: 41 }, end: { line: 1, character: 42 } }, destinationIds: [], backId: 'pricing-reducer-revisit' }], appendedDestinations: [{ sourceStopId: 'pricing-reducer-revisit', destinationIds: ['initial-value'] }], recommendedNextUpdates: [] } } : { kind: 'generated-walkthrough', answerMarkdown: 'Follow the value through the subtotal function and its reducer.', patch: { addedStops: [{ id: 'pricing-function', displayName: 'Definition', explanationMarkdown: 'This defines the subtotal calculation.', path: 'pricing.ts', range: { start: { line: 0, character: 16 }, end: { line: 0, character: 51 } }, destinationIds: ['pricing-reducer'], recommendedNextId: 'pricing-reducer', backId: 'checkout-origin' }, { id: 'pricing-reducer', displayName: 'Reducer', explanationMarkdown: 'The reducer subtracts each price.', path: 'pricing.ts', range: { start: { line: 1, character: 41 }, end: { line: 1, character: 54 } }, destinationIds: ['pricing-reducer-revisit'], recommendedNextId: 'pricing-reducer-revisit', backId: 'pricing-function' }, { id: 'pricing-reducer-revisit', displayName: 'Reducer', explanationMarkdown: 'Revisit the same reduction expression.', path: 'pricing.ts', range: { start: { line: 1, character: 41 }, end: { line: 1, character: 54 } }, destinationIds: [], backId: 'pricing-reducer' }, { id: 'checkout-cart', displayName: 'Cart input', explanationMarkdown: 'The cart supplies the prices.', path: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 22 } }, destinationIds: ['pricing-function'], recommendedNextId: 'pricing-function', backId: 'checkout-origin' }], appendedDestinations: [{ sourceStopId: 'checkout-origin', destinationIds: ['pricing-function', 'checkout-cart'] }], recommendedNextUpdates: [{ sourceStopId: 'checkout-origin', targetStopId: 'pricing-function' }] } };
            const commit = { schemaVersion: 1, requestId, expectedSessionId: snapshot.sessionId, expectedRevision: snapshot.revision, outcome };
            yield call('question', 'codealongai_commit_question_outcome', commit, '2026-01-01T00:00:04.000Z');
            const committed = await client.callTool({ name: 'codealongai_commit_question_outcome', arguments: commit });
            yield response('question', committed, '2026-01-01T00:00:05.000Z');
            yield { type: 'turn.done', id: 'done', state: { status: 'done' } };
            return;
          }
          const origin = (authority.structuredContent as { input?: { origin?: { path?: string; range?: unknown } } } | undefined)?.input?.origin;
          if (!origin?.path || !origin.range) return;
          const interval = origin.range as { start: { line: number }; end: { line: number; character: number } };
          const endLine = interval.end.character === 0 ? interval.end.line : interval.end.line + 1;
          yield call('origin', 'codealongai_read_workspace_file', { schemaVersion: 1, path: origin.path, startLine: interval.start.line, endLine }, '2026-01-01T00:00:02.000Z');
          const read = await client.callTool({ name: 'codealongai_read_workspace_file', arguments: { schemaVersion: 1, path: origin.path, startLine: interval.start.line, endLine } });
          yield response('origin', read, '2026-01-01T00:00:03.000Z');
          const start = { schemaVersion: 1, requestId, origin: { stopId: 'checkout-origin', displayName: 'Origin', explanation: 'What would you like to understand about this code?', document: origin.path, range: origin.range } };
          yield call('start', 'codealongai_start_walkthrough', start, '2026-01-01T00:00:04.000Z');
          const committed = await client.callTool({ name: 'codealongai_start_walkthrough', arguments: start });
          yield response('start', committed, '2026-01-01T00:00:05.000Z');
          yield { type: 'turn.done', id: 'done', state: { status: 'done' } };
        } finally { await transport.close(); }
      },
      cancelTurn: async () => { runtime.producerCancelCalls += 1; runtime.producerCancelled = true; },
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
