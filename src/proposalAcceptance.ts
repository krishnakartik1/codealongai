import type { ProposalCapture } from './interaction';

export interface LiveProposalDocument {
  applyIfVersionMatches(
    proposal: ProposalCapture,
    isAcceptanceCurrent: () => boolean
  ): Promise<ProposalAcceptanceResult>;
}

export type ProposalAcceptanceResult =
  | { outcome: 'applied' }
  | { outcome: 'stale' }
  | { outcome: 'cancelled' };

export class ProposalAcceptanceAuthority {
  private proposal: ProposalCapture | undefined;

  public constructor(private readonly documents: LiveProposalDocument) {}

  public beginAcceptance(proposal: ProposalCapture): void {
    this.proposal = proposal;
  }

  public cancelAcceptance(): void {
    this.proposal = undefined;
  }

  public async accept(): Promise<ProposalAcceptanceResult> {
    const proposal = this.proposal;
    if (proposal === undefined) {
      return { outcome: 'cancelled' };
    }
    const result = await this.documents.applyIfVersionMatches(
      proposal,
      () => this.proposal === proposal
    );
    if (this.proposal !== proposal) {
      return { outcome: 'cancelled' };
    }
    this.proposal = undefined;
    return result;
  }
}
