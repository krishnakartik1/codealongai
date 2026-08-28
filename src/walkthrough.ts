export interface Position { line: number; character: number; }
export interface Range { start: Position; end: Position; }
export interface OriginAnchor { document: string; range: Range; }
export interface OriginDescriptor extends OriginAnchor {
  stopId: string;
  displayName: string;
  explanation: string;
}
export interface StartRequest {
  id: string;
  readonly kind: 'start';
  readonly origin: OriginAnchor;
  readonly snapshot: { readonly capturedAt: string; readonly origin: OriginAnchor };
  status: 'pending' | 'consumed' | 'cancelled';
}
export interface WalkthroughSession {
  readonly id: string;
  readonly revision: 1;
  readonly origin: OriginDescriptor;
  readonly attentionStopId: string;
}

let nextId = 1;
const identifier = (prefix: string): string => `${prefix}-${nextId++}`;
const copyAnchor = (origin: OriginAnchor): OriginAnchor => ({ document: origin.document, range: { start: { ...origin.range.start }, end: { ...origin.range.end } } });

export function deriveOrigin(document: string, selection: Range, lineText: string): OriginAnchor | undefined {
  if (selection.start.line !== selection.end.line || selection.start.character !== selection.end.character) {
    return { document, range: selection };
  }
  if (lineText.trim().length === 0) return undefined;
  return {
    document,
    range: {
      start: { line: selection.start.line, character: 0 },
      end: { line: selection.start.line, character: lineText.length }
    }
  };
}

export class WalkthroughAuthority {
  private request: StartRequest | undefined;
  private session: WalkthroughSession | undefined;

  public captureStart(origin: OriginAnchor): StartRequest {
    const request: StartRequest = {
      id: identifier('request'), kind: 'start', origin: copyAnchor(origin),
      snapshot: { capturedAt: new Date().toISOString(), origin: copyAnchor(origin) }, status: 'pending'
    };
    this.request = request;
    return request;
  }

  public getStartRequest(id: string): StartRequest | undefined {
    const request = this.request?.id === id ? this.request : undefined;
    return request && { ...request, origin: copyAnchor(request.origin), snapshot: { ...request.snapshot, origin: copyAnchor(request.snapshot.origin) } };
  }

  public getSession(): WalkthroughSession | undefined { return this.session; }

  public start(requestId: string, origin: OriginDescriptor): WalkthroughSession {
    const request = this.request?.id === requestId ? this.request : undefined;
    if (!request || request.status !== 'pending') throw new Error('start request is unavailable');
    if (!sameAnchor(request.origin, origin)) throw new Error('origin does not match the authorized request');
    const session: WalkthroughSession = {
      id: identifier('walkthrough'), revision: 1, origin, attentionStopId: origin.stopId
    };
    request.status = 'consumed';
    this.session = session;
    return session;
  }

  public discardStart(): void { if (this.request?.status === 'pending') this.request.status = 'cancelled'; }
}

export function sameAnchor(left: OriginAnchor, right: OriginAnchor): boolean {
  return left.document === right.document && JSON.stringify(left.range) === JSON.stringify(right.range);
}
