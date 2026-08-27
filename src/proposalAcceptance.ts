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

export class ProposalAcceptanceAuthority {
  private active: {
    request: ProposalMutationRequest;
    completion: Promise<ProposalAcceptanceResult> | undefined;
    applicationSubmitted: boolean;
  } | undefined;
  private completed: { requestId: number; result: Promise<ProposalAcceptanceResult> } | undefined;

  public constructor(private readonly documents: LiveProposalDocument) {}

  public beginAcceptance(request: ProposalMutationRequest): boolean {
    if (this.completed?.requestId === request.requestId) return true;
    if (this.active !== undefined) return this.active.request.requestId === request.requestId;
    this.active = { request, completion: undefined, applicationSubmitted: false };
    return true;
  }

  public async cancelAcceptance(): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    if (active.completion !== undefined && active.applicationSubmitted) {
      await active.completion;
      return;
    }
    if (active.completion === undefined) {
      this.completed = { requestId: active.request.requestId, result: Promise.resolve({ outcome: 'cancelled' }) };
    }
    if (this.active === active) this.active = undefined;
  }

  public accept(request: ProposalMutationRequest): Promise<ProposalAcceptanceResult> {
    if (this.completed?.requestId === request.requestId) return this.completed.result;
    const active = this.active;
    if (active === undefined || active.request.requestId !== request.requestId) {
      return Promise.resolve({ outcome: 'cancelled' });
    }
    if (active.completion !== undefined) return active.completion;
    active.completion = this.apply(active);
    this.completed = { requestId: request.requestId, result: active.completion };
    return active.completion;
  }

  private async apply(active: NonNullable<ProposalAcceptanceAuthority['active']>): Promise<ProposalAcceptanceResult> {
    try {
      const acceptanceResult = await this.documents.applyIfVersionMatches(
        active.request,
        () => this.active === active,
        () => {
          if (this.active !== active) {
            return false;
          }
          active.applicationSubmitted = true;
          return true;
        }
      );
      if (this.active !== active) {
        return { outcome: 'cancelled' };
      }
      this.active = undefined;
      return acceptanceResult;
    } catch {
      if (this.active !== active) return { outcome: 'cancelled' };
      this.active = undefined;
      return { outcome: 'failed' };
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }
}
