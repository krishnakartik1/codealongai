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

export class InteractionController {
  private readonly replay: ReplayController;
  private humanSelection: DocumentRange | undefined;
  private aiAttention: AiAttention | undefined;
  private follow: InteractionState['follow'] = 'not-following';
  private followTarget: DocumentRange | undefined;
  private pendingExplanation: AnchoredExplanation | undefined;
  private explanations: AnchoredExplanation[] = [];

  public constructor(events: readonly ReplayEvent[]) {
    this.replay = new ReplayController(events);
  }

  public start(humanSelection: DocumentRange): InteractionState {
    this.replay.reset();
    this.replay.start();
    this.humanSelection = humanSelection;
    this.aiAttention = { name: 'CodeAlongAI', target: humanSelection };
    this.follow = 'not-following';
    this.followTarget = undefined;
    this.pendingExplanation = undefined;
    this.explanations = [];

    return this.state();
  }

  public advance(): InteractionState {
    const event = this.replay.advance();
    if (event === undefined) {
      return this.state();
    }

    this.aiAttention = { name: 'CodeAlongAI', target: event.target };
    if (event.kind === 'explain' && this.isDifferentDocument(event.target)) {
      this.follow = 'awaiting-consent';
      this.followTarget = event.target;
      this.pendingExplanation = { message: event.message, target: event.target };
    }

    return this.state();
  }

  public acceptFollow(): InteractionState {
    if (this.follow === 'awaiting-consent' && this.pendingExplanation !== undefined) {
      this.follow = 'following';
      this.explanations = [this.pendingExplanation];
      this.pendingExplanation = undefined;
    }

    return this.state();
  }

  public refuseFollow(): InteractionState {
    if (this.follow === 'awaiting-consent') {
      this.follow = 'not-following';
      this.followTarget = undefined;
      this.pendingExplanation = undefined;
      this.aiAttention = undefined;
    }

    return this.state();
  }

  public breakAway(): InteractionState {
    this.follow = 'not-following';
    this.followTarget = undefined;
    this.pendingExplanation = undefined;
    this.aiAttention = undefined;
    this.explanations = [];

    return this.state();
  }

  public reset(): InteractionState {
    this.replay.reset();
    this.humanSelection = undefined;
    this.aiAttention = undefined;
    this.follow = 'not-following';
    this.followTarget = undefined;
    this.pendingExplanation = undefined;
    this.explanations = [];

    return this.state();
  }

  private isDifferentDocument(target: DocumentRange): boolean {
    return this.humanSelection?.document !== target.document;
  }

  private state(): InteractionState {
    return {
      humanSelection: this.humanSelection,
      aiAttention: this.aiAttention,
      explanations: this.explanations,
      follow: this.follow,
      followTarget: this.followTarget
    };
  }
}
