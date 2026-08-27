import { ReplayController, type DocumentRange, type ReplayEvent } from './replay';

export interface AiAttention { name: 'CodeAlongAI'; target: DocumentRange; }
export interface AnchoredExplanation { message: string; target: DocumentRange; }
export interface ProposalCapture { target: DocumentRange; baseDocumentVersion: number; stagedContents: string; }
export interface StagedProposal extends ProposalCapture { review: 'ready' | 'accept-requested'; }
export interface InteractionState {
  humanSelection: DocumentRange | undefined; aiAttention: AiAttention | undefined;
  explanations: readonly AnchoredExplanation[]; follow: 'not-following' | 'awaiting-consent' | 'following'; followTarget: DocumentRange | undefined;
  proposalCaptureTarget: DocumentRange | undefined; proposal: StagedProposal | undefined; mutationRequest: ProposalCapture | undefined;
}
function clearAiCues(state: InteractionState): InteractionState { return { ...state, aiAttention: undefined, explanations: [], follow: 'not-following', followTarget: undefined, proposalCaptureTarget: undefined, proposal: undefined, mutationRequest: undefined }; }
function sameDocumentRange(first: DocumentRange, second: DocumentRange | undefined): boolean { return first.document === second?.document && first.range.start.line === second.range.start.line && first.range.start.character === second.range.start.character && first.range.end.line === second.range.end.line && first.range.end.character === second.range.end.character; }
export class InteractionController {
  private readonly replay: ReplayController; private pendingExplanation: AnchoredExplanation | undefined;
  private current: InteractionState = { humanSelection: undefined, aiAttention: undefined, explanations: [], follow: 'not-following', followTarget: undefined, proposalCaptureTarget: undefined, proposal: undefined, mutationRequest: undefined };
  public constructor(events: readonly ReplayEvent[]) { this.replay = new ReplayController(events); }
  public start(humanSelection: DocumentRange): InteractionState { this.replay.reset(); this.replay.start(); this.pendingExplanation = undefined; this.current = { humanSelection, aiAttention: { name: 'CodeAlongAI', target: humanSelection }, explanations: [], follow: 'not-following', followTarget: undefined, proposalCaptureTarget: undefined, proposal: undefined, mutationRequest: undefined }; return this.current; }
  public advance(): InteractionState { if (this.current.follow === 'awaiting-consent') return this.current; const event = this.replay.advance(); if (!event) return this.current; const aiAttention = { name: 'CodeAlongAI' as const, target: event.target }; if (event.kind === 'propose') { this.current = { ...this.current, aiAttention, proposalCaptureTarget: event.target }; return this.current; } if (event.kind === 'explain' && event.target.document !== this.current.humanSelection?.document) { this.pendingExplanation = { message: event.message, target: event.target }; this.current = { ...this.current, aiAttention, follow: 'awaiting-consent', followTarget: event.target }; return this.current; } this.current = { ...this.current, aiAttention }; return this.current; }
  public acceptFollow(): InteractionState { if (this.current.follow === 'awaiting-consent') { this.current = { ...this.current, explanations: this.pendingExplanation ? [this.pendingExplanation] : [], follow: 'following' }; this.pendingExplanation = undefined; } return this.current; }
  public refuseFollow(): InteractionState { if (this.current.follow === 'awaiting-consent') { this.current = clearAiCues(this.current); this.pendingExplanation = undefined; } return this.current; }
  public breakAway(): InteractionState { this.current = clearAiCues(this.current); this.pendingExplanation = undefined; return this.current; }
  public stageProposal(capture: ProposalCapture): InteractionState { if (sameDocumentRange(capture.target, this.current.proposalCaptureTarget)) this.current = { ...this.current, proposalCaptureTarget: undefined, proposal: { ...capture, review: 'ready' } }; return this.current; }
  public rejectProposal(): InteractionState { this.current = { ...this.current, proposalCaptureTarget: undefined, proposal: undefined, mutationRequest: undefined }; return this.current; }
  public requestProposalAcceptance(): InteractionState { const proposal = this.current.proposal; if (proposal?.review === 'ready') { const { review: _review, ...mutationRequest } = proposal; this.current = { ...this.current, proposal: { ...proposal, review: 'accept-requested' }, mutationRequest }; } return this.current; }
  public reset(): InteractionState { this.replay.reset(); this.pendingExplanation = undefined; this.current = clearAiCues({ ...this.current, humanSelection: undefined }); return this.current; }
}
