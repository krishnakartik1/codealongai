import { ReplayController, type DocumentRange, type ReplayEvent } from './replay';
import type { ProposalAcceptanceResult } from './proposalAcceptance';

export interface AiAttention {
  name: 'CodeAlongAI';
  target: DocumentRange;
}
export interface AnchoredExplanation {
  message: string;
  target: DocumentRange;
}
export interface ProposalCapture {
  target: DocumentRange;
  baseDocumentVersion: number;
  baseContents: string;
  replacement: string;
  stagedContents: string;
}
export interface StagedProposal extends ProposalCapture {
  review: 'ready' | 'accept-requested' | 'stale';
}
export interface ProposalMutationRequest extends ProposalCapture {
  requestId: number;
}
export interface ProposalAcceptanceEffect {
  message: string | undefined;
  closeReview: boolean;
}
export interface ProposalAcceptanceCompletion {
  state: InteractionState;
  effect: ProposalAcceptanceEffect;
}
export interface InteractionState {
  humanSelection: DocumentRange | undefined;
  aiAttention: AiAttention | undefined;
  explanations: readonly AnchoredExplanation[];
  follow: 'not-following' | 'awaiting-consent' | 'following';
  followTarget: DocumentRange | undefined;
  proposalCaptureTarget: DocumentRange | undefined;
  proposal: StagedProposal | undefined;
  mutationRequest: ProposalMutationRequest | undefined;
  proposalAcceptance: ProposalAcceptanceEffect;
}

export const staleProposalMessage = 'The proposal is stale. Replay or restage it before accepting.';
const noProposalAcceptanceEffect: ProposalAcceptanceEffect = { message: undefined, closeReview: false };

function clearAiCues(state: InteractionState): InteractionState {
  return {
    ...state,
    aiAttention: undefined,
    explanations: [],
    follow: 'not-following',
    followTarget: undefined,
    proposalCaptureTarget: undefined,
    proposal: undefined,
    mutationRequest: undefined,
    proposalAcceptance: noProposalAcceptanceEffect
  };
}

function clearProposal(state: InteractionState): InteractionState {
  return {
    ...state,
    proposalCaptureTarget: undefined,
    proposal: undefined,
    mutationRequest: undefined,
    proposalAcceptance: noProposalAcceptanceEffect
  };
}

function sameDocumentRange(first: DocumentRange, second: DocumentRange | undefined): boolean {
  return first.document === second?.document
    && first.range.start.line === second.range.start.line
    && first.range.start.character === second.range.start.character
    && first.range.end.line === second.range.end.line
    && first.range.end.character === second.range.end.character;
}

function stageForTarget(
  capture: ProposalCapture,
  target: DocumentRange | undefined
): StagedProposal | undefined {
  if (!sameDocumentRange(capture.target, target)) {
    return undefined;
  }

  return { ...capture, review: 'ready' };
}

function stageInteractionProposal(
  current: InteractionState,
  capture: ProposalCapture
): InteractionState {
  const proposal = stageForTarget(capture, current.proposalCaptureTarget);
  return proposal
    ? { ...current, proposalCaptureTarget: undefined, proposal }
    : current;
}

function requestAcceptance(
  proposal: StagedProposal | undefined,
  requestId: number
): { proposal: StagedProposal; mutationRequest: ProposalMutationRequest } | undefined {
  if (proposal?.review !== 'ready') {
    return undefined;
  }

  const { review: _review, ...mutationRequest } = proposal;
  return { proposal: { ...proposal, review: 'accept-requested' }, mutationRequest: { ...mutationRequest, requestId } };
}

function humanSelectionDocument(state: InteractionState): string | undefined {
  return state.humanSelection?.document;
}

function advanceState(
  state: InteractionState,
  event: ReplayEvent,
  pendingExplanation: AnchoredExplanation | undefined
): { state: InteractionState; pendingExplanation: AnchoredExplanation | undefined } {
  const aiAttention = { name: 'CodeAlongAI' as const, target: event.target };
  if (event.kind === 'propose') {
    return {
      state: { ...state, aiAttention, proposalCaptureTarget: event.target },
      pendingExplanation
    };
  }

  if (event.kind !== 'explain') {
    return { state: { ...state, aiAttention }, pendingExplanation };
  }

  const explanation = { message: event.message, target: event.target };
  if (event.target.document !== humanSelectionDocument(state)) {
    return {
      state: { ...state, aiAttention, follow: 'awaiting-consent', followTarget: event.target },
      pendingExplanation: explanation
    };
  }

  return {
    state: { ...state, aiAttention, explanations: [...state.explanations, explanation] },
    pendingExplanation
  };
}

export class InteractionController {
  private readonly replay: ReplayController;
  private pendingExplanation: AnchoredExplanation | undefined;
  private nextMutationRequestId = 1;
  private current: InteractionState = {
    humanSelection: undefined,
    aiAttention: undefined,
    explanations: [],
    follow: 'not-following',
    followTarget: undefined,
    proposalCaptureTarget: undefined,
    proposal: undefined,
    mutationRequest: undefined,
    proposalAcceptance: noProposalAcceptanceEffect
  };

  public constructor(events: readonly ReplayEvent[]) {
    this.replay = new ReplayController(events);
  }

  public start(humanSelection: DocumentRange): InteractionState {
    this.replay.reset();
    this.replay.start();
    this.pendingExplanation = undefined;
    this.current = {
      humanSelection,
      aiAttention: { name: 'CodeAlongAI', target: humanSelection },
      explanations: [],
      follow: 'not-following',
      followTarget: undefined,
      proposalCaptureTarget: undefined,
      proposal: undefined,
      mutationRequest: undefined,
      proposalAcceptance: noProposalAcceptanceEffect
    };
    return this.current;
  }

  public advance(): InteractionState {
    if (this.current.follow === 'awaiting-consent') {
      return this.current;
    }

    const event = this.replay.advance();
    if (!event) {
      return this.current;
    }

    const transition = advanceState(this.current, event, this.pendingExplanation);
    this.current = transition.state;
    this.pendingExplanation = transition.pendingExplanation;
    return this.current;
  }

  public acceptFollow(): InteractionState {
    if (this.current.follow === 'awaiting-consent') {
      this.current = {
        ...this.current,
        explanations: this.pendingExplanation ? [this.pendingExplanation] : [],
        follow: 'following'
      };
      this.pendingExplanation = undefined;
    }
    return this.current;
  }

  public refuseFollow(): InteractionState {
    if (this.current.follow === 'awaiting-consent') {
      this.current = clearAiCues(this.current);
      this.pendingExplanation = undefined;
    }
    return this.current;
  }

  public breakAway(): InteractionState {
    this.current = clearAiCues(this.current);
    this.pendingExplanation = undefined;
    return this.current;
  }

  public stageProposal(capture: ProposalCapture): InteractionState {
    this.current = stageInteractionProposal(this.current, capture);
    return this.current;
  }

  public rejectProposal(): InteractionState {
    this.current = clearProposal(this.current);
    return this.current;
  }

  public completeProposalAcceptance(
    request: ProposalMutationRequest,
    acceptanceResult: ProposalAcceptanceResult
  ): ProposalAcceptanceCompletion {
    if (this.current.mutationRequest?.requestId !== request.requestId) {
      return { state: this.current, effect: noProposalAcceptanceEffect };
    }
    let effect = noProposalAcceptanceEffect;
    if (acceptanceResult.outcome === 'applied') {
      effect = { message: undefined, closeReview: true };
      this.current = { ...clearProposal(this.current), proposalAcceptance: effect };
    }
    if (acceptanceResult.outcome === 'stale' && this.current.proposal) {
      effect = { message: staleProposalMessage, closeReview: false };
      this.current = {
        ...this.current,
        mutationRequest: undefined,
        proposal: { ...this.current.proposal, review: 'stale' },
        proposalAcceptance: effect
      };
    }
    if (acceptanceResult.outcome === 'cancelled') {
      this.current = clearProposal(this.current);
    }
    if (acceptanceResult.outcome === 'failed') {
      effect = { message: 'CodeAlongAI could not accept the proposal. Restage it and try again.', closeReview: false };
      this.current = {
        ...clearProposal(this.current),
        proposalAcceptance: effect
      };
    }
    return { state: this.current, effect };
  }

  public releaseProposalAcceptance(request: ProposalMutationRequest): ProposalAcceptanceCompletion {
    const proposal = this.proposalForCurrentMutationRequest(request);
    let effect = noProposalAcceptanceEffect;
    if (proposal !== undefined) {
      effect = {
        message: 'CodeAlongAI is finishing the previous proposal. Try acceptance again.',
        closeReview: false
      };
      this.current = {
        ...this.current,
        proposal: { ...proposal, review: 'ready' },
        mutationRequest: undefined,
        proposalAcceptance: effect
      };
    }
    return { state: this.current, effect };
  }

  private proposalForCurrentMutationRequest(
    request: ProposalMutationRequest
  ): StagedProposal | undefined {
    const mutationRequest = this.current.mutationRequest;
    return mutationRequest?.requestId === request.requestId ? this.current.proposal : undefined;
  }

  public requestProposalAcceptance(): InteractionState {
    const request = requestAcceptance(this.current.proposal, this.nextMutationRequestId);
    if (request) {
      this.nextMutationRequestId += 1;
      this.current = { ...this.current, ...request, proposalAcceptance: noProposalAcceptanceEffect };
    }
    return this.current;
  }

  public reset(): InteractionState {
    this.replay.reset();
    this.pendingExplanation = undefined;
    this.current = clearAiCues({ ...this.current, humanSelection: undefined });
    return this.current;
  }
}
