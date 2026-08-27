export interface Point {
  line: number;
  character: number;
}

export interface DocumentRange {
  document: string;
  range: {
    start: Point;
    end: Point;
  };
}

interface TargetedEvent {
  target: DocumentRange;
}

export interface PointEvent extends TargetedEvent {
  kind: 'point';
}

export interface WalkthroughEvent extends TargetedEvent {
  kind: 'walkthrough';
  message: string;
}

export interface ExplainEvent extends TargetedEvent {
  kind: 'explain';
  message: string;
}

export interface ProposeEvent extends TargetedEvent {
  kind: 'propose';
  baseDocumentVersion: number;
  replacement: string;
}

export interface AskEvent extends TargetedEvent {
  kind: 'ask';
  question: string;
}

export type ReplayEvent =
  | PointEvent
  | WalkthroughEvent
  | ExplainEvent
  | ProposeEvent
  | AskEvent;

export const deterministicReplayFixture: {
  events: readonly ReplayEvent[];
} = {
  events: [
    {
      kind: 'point',
      target: {
        document: 'checkout.ts',
        range: { start: { line: 4, character: 31 }, end: { line: 4, character: 39 } }
      }
    },
    {
      kind: 'walkthrough',
      message: 'Follow checkout through its subtotal import.',
      target: {
        document: 'checkout.ts',
        range: { start: { line: 0, character: 9 }, end: { line: 0, character: 17 } }
      }
    },
    {
      kind: 'explain',
      message: 'Subtotal subtracts each price instead of adding it.',
      target: {
        document: 'pricing.ts',
        range: { start: { line: 1, character: 47 }, end: { line: 1, character: 48 } }
      }
    },
    {
      kind: 'propose',
      baseDocumentVersion: 1,
      replacement: '+',
      target: {
        document: 'pricing.ts',
        range: { start: { line: 1, character: 47 }, end: { line: 1, character: 48 } }
      }
    },
    {
      kind: 'ask',
      question: 'Would you like to apply this one-character fix?',
      target: {
        document: 'pricing.ts',
        range: { start: { line: 1, character: 47 }, end: { line: 1, character: 48 } }
      }
    }
  ]
};

export class ReplayController {
  private nextEventIndex = 0;
  private isRunning = false;

  public constructor(private readonly events: readonly ReplayEvent[]) {}

  public start(): ReplayEvent | undefined {
    this.isRunning = true;
    return this.advance();
  }

  public advance(): ReplayEvent | undefined {
    if (!this.isRunning) {
      return undefined;
    }

    const event = this.events[this.nextEventIndex];
    this.nextEventIndex += 1;
    return event;
  }

  public cancel(): void {
    this.isRunning = false;
  }

  public reset(): void {
    this.nextEventIndex = 0;
    this.isRunning = false;
  }
}
