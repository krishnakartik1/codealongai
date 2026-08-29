import type { TrueForgeProducerReadinessInput, TrueForgeProducerReadinessResult, TrueForgeProducerRuntime } from './trueforge-contract';

export type ProducerReadinessAction = 'none' | 'configure-node' | 'open-setup' | 'retry-setup' | 'retry-trueforge' | 'show-output';
export interface ProducerReadinessResult extends TrueForgeProducerReadinessResult { readonly action: ProducerReadinessAction; }

/** Serializes the opaque external-runtime check so a request can never race readiness. */
export class ProducerReadiness {
  private queue: Promise<void> = Promise.resolve();
  public constructor(private readonly runtime: TrueForgeProducerRuntime) {}

  public check(input: TrueForgeProducerReadinessInput): Promise<ProducerReadinessResult> {
    const operation = this.queue.catch(() => undefined).then(async () => this.checkOwned(input));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async checkOwned(input: TrueForgeProducerReadinessInput): Promise<ProducerReadinessResult> {
    try {
      const result = await this.runtime.prepareProducer(input);
      return { ...result, action: actionFor(result.phase, result.outcome) };
    } catch { return { phase: 'network', outcome: 'failed', action: 'retry-trueforge' }; }
  }
}

function actionFor(phase: ProducerReadinessResult['phase'], outcome: ProducerReadinessResult['outcome']): ProducerReadinessAction {
  if (outcome === 'ready') return 'none';
  if (phase === 'node') return 'configure-node';
  if (phase === 'architecture') return 'show-output';
  if (phase === 'sidecar' || phase === 'network') return 'retry-trueforge';
  if (phase === 'authentication' || phase === 'model' || phase === 'alias' || phase === 'reasoning' || phase === 'skill' || phase === 'connector') return 'open-setup';
  return 'show-output';
}
