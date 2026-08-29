import type { TrueForgeProducerReadinessResult, TrueForgeProducerRuntime, TrueForgeRuntime, TrueForgeStartOptions } from '../trueforge';
import type { DaytonaProbeResult } from '../daytona';

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
  public get producer(): TrueForgeProducerRuntime { return this.producerIdentity ??= { ...emptyTrueForgeProducer, probeDaytona: async () => { this.probeCalls += 1; return this.daytonaProbe; }, prepareProducer: async () => { this.prepareCalls += 1; this.concurrentPrepares += 1; this.maximumConcurrentPrepares = Math.max(this.maximumConcurrentPrepares, this.concurrentPrepares); try { await this.prepareWait; return this.producerReadiness; } finally { this.concurrentPrepares -= 1; } } }; }
  public replaceProducerForTests(): void { this.producerIdentity = undefined; }
  public async start(options: TrueForgeStartOptions): Promise<void> { this.calls.push(`start:${options.port}`); if (this.failStart) throw new Error('configured test sidecar failure'); }
  public async health(): Promise<boolean> { return this.healthy; }
  public async verifyCapability(): Promise<boolean> { return this.healthy; }
  public hasExited(): boolean { return false; }
  public async ownsRunningChild(): Promise<boolean> { return this.owned; }
  public async open(url: string): Promise<void> { this.calls.push(`open:${url}`); }
  public async stop(): Promise<void> { this.calls.push('stop'); }
}
