import type { ProposalCapture } from './interaction';

export interface LiveProposalDocument {
  applyIfVersionMatches(
    proposal: ProposalCapture,
    isAcceptanceCurrent: () => boolean,
    beginApplication: () => boolean
  ): Promise<ProposalAcceptanceResult>;
}

export type ProposalAcceptanceResult =
  | { outcome: 'applied' }
  | { outcome: 'stale' }
  | { outcome: 'cancelled' };

export class ProposalAcceptanceAuthority {
  private proposal: ProposalCapture | undefined;
  private acceptanceFinished: Promise<void> | undefined;
  private applicationSubmitted = false;

  public constructor(private readonly documents: LiveProposalDocument) {}

  public beginAcceptance(proposal: ProposalCapture): void {
    this.proposal = proposal;
  }

  public cancelAcceptance(): Promise<void> {
    if (this.acceptanceFinished !== undefined && this.applicationSubmitted) {
      return this.acceptanceFinished;
    }
    this.proposal = undefined;
    return Promise.resolve();
  }

  public async accept(): Promise<ProposalAcceptanceResult> {
    const proposal = this.proposal;
    if (proposal === undefined) {
      return { outcome: 'cancelled' };
    }
    let finishAcceptance: (() => void) | undefined;
    this.applicationSubmitted = false;
    this.acceptanceFinished = new Promise<void>((resolve) => { finishAcceptance = resolve; });
    try {
      const acceptanceResult = await this.documents.applyIfVersionMatches(
        proposal,
        () => this.proposal === proposal,
        () => {
          if (this.proposal !== proposal) {
            return false;
          }
          this.applicationSubmitted = true;
          return true;
        }
      );
      if (this.proposal !== proposal) {
        return { outcome: 'cancelled' };
      }
      this.proposal = undefined;
      return acceptanceResult;
    } finally {
      finishAcceptance?.();
      this.acceptanceFinished = undefined;
      this.applicationSubmitted = false;
    }
  }
}
