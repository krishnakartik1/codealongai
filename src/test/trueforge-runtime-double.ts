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
  private producerIdentity: TrueForgeProducerRuntime | undefined;
  public get producer(): TrueForgeProducerRuntime {
    let spec: Record<string, unknown> | undefined;
    let turn: Record<string, unknown> | undefined;
    return this.producerIdentity ??= {
      ...emptyTrueForgeProducer,
      createSession: async (request) => { spec = request as Record<string, unknown>; return { data: { id: 'test-session' } }; },
      runTurn: async (input) => { turn = input.request as Record<string, unknown>; return { data: { id: 'test-turn' } }; },
      events: async function* () {
        const text = (((turn?.input as readonly { content?: unknown }[] | undefined)?.[0])?.content);
        const requestId = typeof text === 'string' ? text.match(/request ID ([^.]*)\./)?.[1] : undefined;
        const mcpUrl = ((((spec?.agent as Record<string, unknown> | undefined)?.spec as Record<string, unknown> | undefined)?.mcpServers as readonly { url?: unknown }[] | undefined)?.[0])?.url;
        if (!requestId || typeof mcpUrl !== 'string') return;
        const port = Number(new URL(mcpUrl).port);
        yield { type: 'truefoundry-system:call_tool', sequence: 1, data: { callId: 'request', name: 'codealongai_get_walkthrough_request', arguments: { schemaVersion: 1, requestId } } };
        await commitDeterministicOrigin(port, requestId, { stopId: 'checkout-origin', displayName: 'Origin', explanation: 'What would you like to understand about this code?', document: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 22 } } });
        yield { type: 'truefoundry-system:call_tool', sequence: 2, data: { callId: 'start', name: 'codealongai_start_walkthrough', arguments: { schemaVersion: 1, requestId } } };
        yield { type: 'tool.response', sequence: 3, data: { callId: 'start', structuredContent: { schemaVersion: 1, requestId, sessionId: 'test-session', revision: 1, attentionStopId: 'checkout-origin' } } };
      },
      probeDaytona: async () => { this.probeCalls += 1; return this.daytonaProbe; }, prepareProducer: async () => { this.prepareCalls += 1; this.concurrentPrepares += 1; this.maximumConcurrentPrepares = Math.max(this.maximumConcurrentPrepares, this.concurrentPrepares); try { await this.prepareWait; return this.producerReadiness; } finally { this.concurrentPrepares -= 1; } }
    };
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
