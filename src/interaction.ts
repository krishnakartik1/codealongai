import {
  ReplayController,
  type DocumentRange,
  type ReplayEvent
} from './replay';

export interface AiAttention {
  name: 'CodeAlongAI';
  target: DocumentRange;
}

export interface AnchoredExplanation {
  message: string;
  target: DocumentRange;
}

export interface InteractionState {
  humanSelection: DocumentRange | undefined;
  aiAttention: AiAttention | undefined;
  explanations: readonly AnchoredExplanation[];
  follow: 'not-following' | 'awaiting-consent' | 'following';
  followTarget: DocumentRange | undefined;
}

function clearAiCues(state: InteractionState): InteractionState {
  return {
    ...state,
    aiAttention: undefined,
    explanations: [],
    follow: 'not-following',
    followTarget: undefined
  };
}

interface ReplayProgress {
  state: InteractionState;
  pendingExplanation: AnchoredExplanation | undefined;
}

function progressReplay(
  event: ReplayEvent | undefined,
  state: InteractionState
): ReplayProgress {
  if (event === undefined) {
    return { state, pendingExplanation: undefined };
  }

  const aiAttention: AiAttention = { name: 'CodeAlongAI', target: event.target };
  if (event.kind !== 'explain') {
    return { state: { ...state, aiAttention }, pendingExplanation: undefined };
  }

  const explanation = { message: event.message, target: event.target };
  if (event.target.document === state.humanSelection?.document) {
    return {
      state: { ...state, aiAttention, explanations: [...state.explanations, explanation] },
      pendingExplanation: undefined
    };
  }

  return {
    state: { ...state, aiAttention, follow: 'awaiting-consent', followTarget: event.target },
    pendingExplanation: explanation
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
    followTarget: undefined
  };

  public constructor(events: readonly ReplayEvent[]) {
    this.replay = new ReplayController(events);
  }

  public start(humanSelection: DocumentRange): InteractionState {
    this.replay.reset();
    this.replay.start();
    this.current = {
      humanSelection,
      aiAttention: { name: 'CodeAlongAI', target: humanSelection },
      explanations: [],
      follow: 'not-following',
      followTarget: undefined
    };
    this.pendingExplanation = undefined;
    return this.current;
  }

  public advance(): InteractionState {
    if (this.current.follow === 'awaiting-consent') {
      return this.current;
    }
    const progressed = progressReplay(this.replay.advance(), this.current);
    this.current = progressed.state;
    this.pendingExplanation = progressed.pendingExplanation;
    return this.current;
  }

  public acceptFollow(): InteractionState {
    if (this.current.follow === 'awaiting-consent') {
      this.current = {
        ...this.current,
        explanations: this.pendingExplanation === undefined ? [] : [this.pendingExplanation],
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

  public reset(): InteractionState {
    this.replay.reset();
    this.current = clearAiCues({ ...this.current, humanSelection: undefined });
    this.pendingExplanation = undefined;
    return this.current;
  }
}
