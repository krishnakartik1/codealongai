import { ReplayController, type DocumentRange, type ReplayEvent } from './replay';

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
  stagedContents: string;
}
export interface StagedProposal extends ProposalCapture {
  review: 'ready' | 'accept-requested';
}
export interface InteractionState {
  humanSelection: DocumentRange | undefined;
  aiAttention: AiAttention | undefined;
  explanations: readonly AnchoredExplanation[];
  follow: 'not-following' | 'awaiting-consent' | 'following';
  followTarget: DocumentRange | undefined;
  proposalCaptureTarget: DocumentRange | undefined;
  proposal: StagedProposal | undefined;
  mutationRequest: ProposalCapture | undefined;
}

function clearAiCues(state: InteractionState): InteractionState {
  return {
    ...state,
    aiAttention: undefined,
    explanations: [],
    follow: 'not-following',
    followTarget: undefined,
    proposalCaptureTarget: undefined,
    proposal: undefined,
    mutationRequest: undefined
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

function requestAcceptance(
  proposal: StagedProposal | undefined
): { proposal: StagedProposal; mutationRequest: ProposalCapture } | undefined {
  if (proposal?.review !== 'ready') {
    return undefined;
  }

  const { review: _review, ...mutationRequest } = proposal;
  return { proposal: { ...proposal, review: 'accept-requested' }, mutationRequest };
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
  private current: InteractionState = {
    humanSelection: undefined,
    aiAttention: undefined,
    explanations: [],
    follow: 'not-following',
    followTarget: undefined,
    proposalCaptureTarget: undefined,
    proposal: undefined,
    mutationRequest: undefined
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
      mutationRequest: undefined
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
    const proposal = stageForTarget(capture, this.current.proposalCaptureTarget);
    if (proposal) {
      this.current = { ...this.current, proposalCaptureTarget: undefined, proposal };
    }
    return this.current;
  }

  public rejectProposal(): InteractionState {
    this.current = {
      ...this.current,
      proposalCaptureTarget: undefined,
      proposal: undefined,
      mutationRequest: undefined
    };
    return this.current;
  }

  public requestProposalAcceptance(): InteractionState {
    const request = requestAcceptance(this.current.proposal);
    if (request) {
      this.current = { ...this.current, ...request };
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
