import type { ProposalMutationRequest } from './interaction';

export interface LiveProposalDocument {
  applyIfVersionMatches(
    proposal: ProposalMutationRequest,
    isAcceptanceCurrent: () => boolean,
    beginApplication: () => boolean
  ): Promise<ProposalAcceptanceResult>;
}

export type ProposalAcceptanceResult =
  | { outcome: 'applied' }
  | { outcome: 'stale' }
  | { outcome: 'cancelled' }
  | { outcome: 'failed' };

type AcceptanceCancellation =
  | { kind: 'cancelled'; requestId: number }
  | { kind: 'application-submitted'; completion: Promise<ProposalAcceptanceResult> };

class AcceptanceSession {
  private completion: Promise<ProposalAcceptanceResult> | undefined;
  private applicationSubmitted = false;

  public constructor(private readonly request: ProposalMutationRequest) {}

  public matches(request: ProposalMutationRequest): boolean {
    return this.request.requestId === request.requestId;
  }

  public requestId(): number {
    return this.request.requestId;
  }

  public accept(
    documents: LiveProposalDocument,
    isCurrent: () => boolean
  ): Promise<ProposalAcceptanceResult> {
    if (this.completion === undefined) {
      this.completion = this.apply(documents, isCurrent);
    }
    return this.completion;
  }

  public cancel(): AcceptanceCancellation {
    if (this.completion !== undefined && this.applicationSubmitted) {
      return { kind: 'application-submitted', completion: this.completion };
    }
    return { kind: 'cancelled', requestId: this.request.requestId };
  }

  private async apply(
    documents: LiveProposalDocument,
    isCurrent: () => boolean
  ): Promise<ProposalAcceptanceResult> {
    try {
      return await documents.applyIfVersionMatches(
        this.request,
        isCurrent,
        () => {
          if (!isCurrent()) return false;
          this.applicationSubmitted = true;
          return true;
        }
      );
    } catch {
      return { outcome: 'failed' };
    }
  }
}

export class ProposalAcceptanceAuthority {
  private active: AcceptanceSession | undefined;
  private completed: { requestId: number; result: Promise<ProposalAcceptanceResult> } | undefined;

  public constructor(private readonly documents: LiveProposalDocument) {}

  public beginAcceptance(request: ProposalMutationRequest): boolean {
    if (this.completed?.requestId === request.requestId) return true;
    if (this.active !== undefined) return this.activeMatches(request);
    this.active = new AcceptanceSession(request);
    return true;
  }

  private activeMatches(request: ProposalMutationRequest): boolean {
    return this.active?.matches(request) ?? false;
  }

  public async cancelAcceptance(): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    const cancellation = active.cancel();
    if (cancellation.kind === 'application-submitted') {
      await cancellation.completion;
      return;
    }
    this.completed = { requestId: cancellation.requestId, result: Promise.resolve({ outcome: 'cancelled' }) };
    if (this.active === active) this.active = undefined;
  }

  public accept(request: ProposalMutationRequest): Promise<ProposalAcceptanceResult> {
    if (this.completed?.requestId === request.requestId) return this.completed.result;
    const active = this.active;
    if (active === undefined || !active.matches(request)) {
      return Promise.resolve({ outcome: 'cancelled' });
    }
    const completion = this.apply(active);
    this.completed = { requestId: request.requestId, result: completion };
    return completion;
  }

  private async apply(active: AcceptanceSession): Promise<ProposalAcceptanceResult> {
    const acceptanceResult = await active.accept(this.documents, () => this.active === active);
    if (this.active !== active) return { outcome: 'cancelled' };
    this.active = undefined;
    return acceptanceResult;
  }
}
