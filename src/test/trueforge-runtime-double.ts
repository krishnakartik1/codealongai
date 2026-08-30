import type { TrueForgeProducerReadinessResult, TrueForgeProducerRuntime, TrueForgeRuntime, TrueForgeStartOptions } from '../trueforge';
import type { DaytonaProbeResult } from '../daytona';
import { commitDeterministicOrigin } from '../mcp';

export const emptyTrueForgeProducer: TrueForgeProducerRuntime = {
  discoverConfiguration: async () => [], discoverProviders: async () => [], discoverModels: async () => [], discoverSkills: async () => [],
  createSession: async () => ({}), runTurn: async () => ({}), events: async function* () { yield {}; }, cancelTurn: async () => undefined, deleteSession: async () => undefined
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
  private producerIdentity: TrueForgeProducerRuntime | undefined;
  public get producer(): TrueForgeProducerRuntime {
    const runtime = this;
    let spec: Record<string, unknown> | undefined;
    let turn: Record<string, unknown> | undefined;
    const producer: TrueForgeProducerRuntime = {
      ...emptyTrueForgeProducer,
      createSession: async (request) => { runtime.producerTurnCalls.push({ producer, kind: 'session' }); spec = request as Record<string, unknown>; return { data: { id: 'test-session' } }; },
      runTurn: async (input) => { runtime.producerTurnCalls.push({ producer, kind: 'turn' }); turn = input.request as Record<string, unknown>; return { data: { id: 'test-turn' } }; },
      events: async function* () {
        runtime.producerTurnCalls.push({ producer, kind: 'events' });
        const text = (((turn?.input as readonly { content?: unknown }[] | undefined)?.[0])?.content);
        const requestId = typeof text === 'string' ? text.match(/request ID ([^.]*)\./)?.[1] : undefined;
        const mcpUrl = ((((spec?.agent as Record<string, unknown> | undefined)?.spec as Record<string, unknown> | undefined)?.mcpServers as readonly { url?: unknown }[] | undefined)?.[0])?.url;
        if (!requestId || typeof mcpUrl !== 'string') return;
        const port = Number(new URL(mcpUrl).port);
        yield { type: 'model.message', id: 'call-authority', threadId: 'main', createdAt: '2026-01-01T00:00:00.000Z', toolCalls: [{ id: 'authority', type: 'function', function: { name: 'codealongai_get_walkthrough_request', arguments: JSON.stringify({ schemaVersion: 1, requestId }) }, toolInfo: { type: 'mcp', name: 'codealongai_get_walkthrough_request', serverId: 'test', serverName: 'codealongai-mcp' } }] };
        yield { type: 'tool.response', id: 'response-authority', threadId: 'main', createdAt: '2026-01-01T00:00:01.000Z', toolCallId: 'authority', content: JSON.stringify({ schemaVersion: 1, input: { origin: { path: 'checkout.ts', range: { start: { line: 2 }, end: { line: 2 } } } } }) };
        await commitDeterministicOrigin(port, requestId, { stopId: 'checkout-origin', displayName: 'Origin', explanation: 'What would you like to understand about this code?', document: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 22 } } });
        yield { type: 'model.message', id: 'call-start', threadId: 'main', createdAt: '2026-01-01T00:00:02.000Z', toolCalls: [{ id: 'start', type: 'function', function: { name: 'codealongai_start_walkthrough', arguments: JSON.stringify({ schemaVersion: 1, requestId }) }, toolInfo: { type: 'mcp', name: 'codealongai_start_walkthrough', serverId: 'test', serverName: 'codealongai-mcp' } }] };
        yield { type: 'tool.response', id: 'response-start', threadId: 'main', createdAt: '2026-01-01T00:00:03.000Z', toolCallId: 'start', content: JSON.stringify({ schemaVersion: 1, requestId, sessionId: 'test-session', revision: 1, attentionStopId: 'checkout-origin' }) };
      },
      probeDaytona: async () => { this.probeCalls += 1; return this.daytonaProbe; }, prepareProducer: async () => { this.prepareCalls += 1; this.concurrentPrepares += 1; this.maximumConcurrentPrepares = Math.max(this.maximumConcurrentPrepares, this.concurrentPrepares); try { await this.prepareWait; return this.producerReadiness; } finally { this.concurrentPrepares -= 1; } }
    };
    return this.producerIdentity ??= producer;
  }
  public replaceProducerForTests(): void { this.producerIdentity = undefined; }
  public async start(options: TrueForgeStartOptions): Promise<void> { this.calls.push(`start:${options.port}`); if (this.failStart) throw new Error('configured test sidecar failure'); }
  public async health(): Promise<boolean> { return this.healthy; }
  public async verifyCapability(): Promise<boolean> { return this.healthy; }
  public hasExited(): boolean { return false; }
  public async ownsRunningChild(): Promise<boolean> { return this.owned; }
  public async open(url: string): Promise<void> { this.calls.push(`open:${url}`); }
  public async stop(): Promise<void> { this.calls.push('stop'); }
}
