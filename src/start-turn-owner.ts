import type { TrueForgeProducerRuntime } from './trueforge-contract';
import { ReceiptBackedStartCoordinator, type StartTurnInput, type StartTurnResult } from './producer-turn';

/** One window-owned producer operation. It deliberately survives adapter swaps
 * until the active turn is cleaned up, and never queues a second learner ask. */
export class StartTurnOwner {
  private active: { readonly requestId: string; readonly coordinator: ReceiptBackedStartCoordinator; readonly operation: Promise<StartTurnResult> } | undefined;
  public start(runtime: TrueForgeProducerRuntime, input: StartTurnInput): Promise<StartTurnResult> {
    if (this.active) return this.active.operation;
    const coordinator = new ReceiptBackedStartCoordinator(runtime);
    const operation = coordinator.start(input);
    this.active = { requestId: input.requestId, coordinator, operation };
    void operation.finally(() => { if (this.active?.operation === operation) this.active = undefined; });
    return operation;
  }
  public get requestId(): string | undefined { return this.active?.requestId; }
  public async dispose(): Promise<void> { const active = this.active; this.active = undefined; await active?.coordinator.cancel(); }
}
