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
  public daytonaProbe: DaytonaProbeResult = { provider: 'daytona', phase: 'ready', outcome: 'ready' };
  public producerReadiness: TrueForgeProducerReadinessResult = { phase: 'ready', outcome: 'ready' };
  public get producer(): TrueForgeProducerRuntime { return { ...emptyTrueForgeProducer, probeDaytona: async () => { this.probeCalls += 1; return this.daytonaProbe; }, prepareProducer: async () => this.producerReadiness }; }
  public async start(options: TrueForgeStartOptions): Promise<void> { this.calls.push(`start:${options.port}`); if (this.failStart) throw new Error('configured test sidecar failure'); }
  public async health(): Promise<boolean> { return this.healthy; }
  public async verifyCapability(): Promise<boolean> { return this.healthy; }
  public hasExited(): boolean { return false; }
  public async ownsRunningChild(): Promise<boolean> { return this.owned; }
  public async open(url: string): Promise<void> { this.calls.push(`open:${url}`); }
  public async stop(): Promise<void> { this.calls.push('stop'); }
}
