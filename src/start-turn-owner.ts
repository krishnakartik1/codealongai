import type { TrueForgeProducerRuntime } from './trueforge-contract';
import { ReceiptBackedProducerCoordinator, type ProducerTurnInput, type ProducerTurnResult } from './producer-turn';

/** One window-owned producer operation. It deliberately survives adapter swaps
 * until the active turn is cleaned up, and never queues a second learner ask. */
export class ProducerTurnOwner {
  private active: { readonly requestId: string; readonly coordinator: ReceiptBackedProducerCoordinator; readonly operation: Promise<ProducerTurnResult> } | undefined;
  public constructor(private readonly createCoordinator: (runtime: TrueForgeProducerRuntime) => ReceiptBackedProducerCoordinator = (runtime) => new ReceiptBackedProducerCoordinator(runtime)) {}
  public start(runtime: TrueForgeProducerRuntime, input: ProducerTurnInput): Promise<ProducerTurnResult> {
    if (this.active) return this.active.requestId === input.requestId ? this.active.operation : Promise.resolve({ status: 'failed', diagnostic: 'start_busy' });
    const coordinator = this.createCoordinator(runtime);
    const operation = coordinator.start(input);
    this.active = { requestId: input.requestId, coordinator, operation };
    const cleanup = coordinator.settled ?? operation;
    void cleanup.finally(() => { if (this.active?.operation === operation) this.active = undefined; });
    return operation;
  }
  public get requestId(): string | undefined { return this.active?.requestId; }
  public get activeRequestId(): string | undefined { return this.active?.requestId; }
  public get settled(): Promise<ProducerTurnResult> | undefined { return this.active?.coordinator.settled; }
  /** Cancellation is intentionally not a release. The active operation keeps
   * ownership until its cleanup has finished, so an adapter replacement cannot
   * overlap a still-running native turn. */
  public async cancel(): Promise<void> { this.active?.coordinator.cancel(); }
  /** Shutdown waits for the coordinator's bounded cancellation and cleanup. */
  public async dispose(): Promise<void> {
    const active = this.active;
    active?.coordinator.cancel();
    await (active?.coordinator.settled ?? active?.operation);
  }
}
