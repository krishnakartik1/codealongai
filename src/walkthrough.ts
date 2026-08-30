export interface Position { line: number; character: number; }
export interface Range { start: Position; end: Position; }
export interface OriginAnchor { document: string; range: Range; }
export interface OriginDescriptor extends OriginAnchor { stopId: string; displayName: string; explanation: string; }
export interface ConversationComment { author: 'You' | 'CodeAlongAI'; bodyMarkdown: string; }
export interface WalkthroughStop extends OriginDescriptor { id: string; destinationIds: string[]; recommendedNextId?: string; backId?: string; conversation: ConversationComment[]; }
export interface AddedStop { id: string; displayName: string; explanationMarkdown: string; path: string; range: Range; destinationIds: string[]; recommendedNextId?: string; backId?: string; }
export interface GraphPatch { addedStops: AddedStop[]; appendedDestinations: { sourceStopId: string; destinationIds: string[] }[]; recommendedNextUpdates: { sourceStopId: string; targetStopId: string }[]; }
export type QuestionOutcome = { kind: 'explanation-only'; answerMarkdown: string } | { kind: 'destination-offer'; answerMarkdown: string; destinationIds: string[] } | { kind: 'generated-walkthrough'; answerMarkdown: string; patch: GraphPatch } | { kind: 'explicit-unsupported'; answerMarkdown: string };
export interface StartRequest { id: string; readonly kind: 'start'; readonly origin: OriginAnchor; readonly snapshot: { readonly capturedAt: string; readonly origin: OriginAnchor }; status: 'pending' | 'consumed' | 'cancelled'; }
export interface StartReceipt { schemaVersion: 1; requestId: string; sessionId: string; revision: number; attentionStopId: string; }
export interface ReplacementRequest { id: string; readonly kind: 'replace'; readonly origin: OriginAnchor; readonly expectedSessionId: string; readonly expectedRevision: number; readonly snapshot: { readonly capturedAt: string; readonly session: WalkthroughSession }; status: 'pending' | 'consumed' | 'cancelled'; }
export interface ResetRequest { id: string; readonly kind: 'reset'; readonly sessionId: string; readonly revision: number; status: 'pending' | 'consumed' | 'cancelled'; }
export interface StopExcerpt { stopId: string; path: string; range: Range; text: string; documentVersion?: number; }
export interface QuestionSnapshot { session: WalkthroughSession; stopExcerpts: readonly StopExcerpt[]; editorState: { readonly visibleEditors: readonly string[]; readonly activeVisibleEditorIndex?: number }; }
export interface QuestionRequest { id: string; readonly kind: 'question'; readonly sessionId: string; readonly revision: number; readonly sourceStopId: string; readonly text: string; readonly capturedAt: string; readonly snapshot: QuestionSnapshot; status: 'pending' | 'consumed' | 'cancelled'; }
export interface QuestionCommit { requestId: string; sessionId: string; revision: number; }
export interface QuestionReceipt { schemaVersion: 1; status: 'committed'; requestId: string; sessionId: string; revision: number; attentionStopId: string; }
export interface SessionReceipt { schemaVersion: 1; status: 'committed'; requestId: string; sessionId: string; revision: number; attentionStopId?: string; }
export type NavigationDirection = 'back' | 'next';
export interface NavigationCommit { sessionId: string; revision: number; sourceStopId: string; direction: NavigationDirection; }
export interface DestinationCommit { sessionId: string; revision: number; targetStopId: string; }
export interface NavigationReceipt { schemaVersion: 1; sessionId: string; revision: number; attentionStopId: string; sourceStopId: string; targetStopId: string; }
export interface WalkthroughSession { readonly id: string; readonly revision: number; readonly origin: OriginDescriptor; readonly attentionStopId: string; readonly stops: readonly WalkthroughStop[]; }
let nextId = 1;
const identifier = (prefix: string): string => `${prefix}-${nextId++}`;
// VS Code Position instances serialize their private backing fields (`_line` and
// `_character`) when spread.  Always project coordinates explicitly because
// ranges cross the strict MCP JSON boundary.
const copyPosition = (position: Position): Position => ({ line: position.line, character: position.character });
const copyRange = (range: Range): Range => ({ start: copyPosition(range.start), end: copyPosition(range.end) });
const copyAnchor = (anchor: OriginAnchor): OriginAnchor => ({ document: anchor.document, range: copyRange(anchor.range) });
const copyStop = (stop: WalkthroughStop): WalkthroughStop => ({ ...stop, range: copyRange(stop.range), destinationIds: [...stop.destinationIds], conversation: stop.conversation.map((comment) => ({ ...comment })) });
const copySession = (session: WalkthroughSession): WalkthroughSession => ({ ...session, origin: { ...session.origin, range: copyRange(session.origin.range) }, stops: session.stops.map(copyStop) });
const copyQuestionRequest = (request: QuestionRequest): QuestionRequest => ({ ...request, snapshot: { session: copySession(request.snapshot.session), stopExcerpts: request.snapshot.stopExcerpts.map((excerpt) => ({ ...excerpt, range: copyRange(excerpt.range) })), editorState: { ...request.snapshot.editorState, visibleEditors: [...request.snapshot.editorState.visibleEditors] } } });
const copyOutcome = (outcome: QuestionOutcome): QuestionOutcome => JSON.parse(JSON.stringify(outcome)) as QuestionOutcome;
const copyReceipt = (receipt: QuestionReceipt): QuestionReceipt => ({ ...receipt });
export function deriveOrigin(document: string, selection: Range, lineText: string): OriginAnchor | undefined {
  if (selection.start.line !== selection.end.line || selection.start.character !== selection.end.character) return { document, range: copyRange(selection) };
  if (!lineText.trim()) return undefined;
  return { document, range: { start: { line: selection.start.line, character: 0 }, end: { line: selection.start.line, character: lineText.length } } };
}
export class WalkthroughAuthority {
  private startRequest: StartRequest | undefined;
  /** A start is visible to the MCP caller before its producer receipt is
   * accepted, but remains entirely memory-owned and reversible. */
  private tentativeStart: StartReceipt | undefined;
  private tentativeSession: WalkthroughSession | undefined;
  private acceptedStartReceipt: StartReceipt | undefined;
  private acceptedStartOrigin: OriginDescriptor | undefined;
  private questionRequest: QuestionRequest | undefined;
  private readonly questionRequests = new Map<string, QuestionRequest>();
  private readonly questionReceipts = new Map<string, { commit: QuestionCommit; outcome: QuestionOutcome; receipt: QuestionReceipt }>();
  private replacementRequest: ReplacementRequest | undefined;
  private resetRequest: ResetRequest | undefined;
  private readonly replacementRequests = new Map<string, ReplacementRequest>();
  private readonly resetRequests = new Map<string, ResetRequest>();
  private readonly sessionReceipts = new Map<string, SessionReceipt>();
  private session: WalkthroughSession | undefined;
  public captureStart(origin: OriginAnchor): StartRequest { if (this.startRequest?.status === 'pending') return this.getStartRequest(this.startRequest.id)!; const request: StartRequest = { id: identifier('request'), kind: 'start', origin: copyAnchor(origin), snapshot: { capturedAt: new Date().toISOString(), origin: copyAnchor(origin) }, status: 'pending' }; this.startRequest = request; this.acceptedStartReceipt = undefined; this.acceptedStartOrigin = undefined; return this.getStartRequest(request.id)!; }
  public getStartRequest(id: string): StartRequest | undefined { const request = this.startRequest?.id === id ? this.startRequest : undefined; return request && { ...request, origin: copyAnchor(request.origin), snapshot: { ...request.snapshot, origin: copyAnchor(request.snapshot.origin) } }; }
  public getSession(): WalkthroughSession | undefined { return this.session && copySession(this.session); }
  public getPendingStart(): StartRequest | undefined { return this.startRequest?.status === 'pending' ? this.getStartRequest(this.startRequest.id) : undefined; }
  public start(requestId: string, origin: OriginDescriptor): WalkthroughSession { const request = this.startRequest?.id === requestId ? this.startRequest : undefined; if (!request || request.status !== 'pending' || this.session || this.tentativeStart) throw new Error('start request is unavailable'); if (!sameAnchor(request.origin, origin)) throw new Error('origin does not match the authorized request'); this.session = this.newSession(origin); request.status = 'consumed'; return this.getSession()!; }
  /** The producer MCP transition is intentionally not the general in-process
   * start path: only it waits for a matching external receipt. */
  public startTentative(requestId: string, origin: OriginDescriptor): WalkthroughSession {
    const identical = (session: WalkthroughSession | undefined, receipt: StartReceipt | undefined): WalkthroughSession | undefined => receipt?.requestId === requestId && session && JSON.stringify(session.origin) === JSON.stringify(origin) ? copySession(session) : undefined;
    const retry = identical(this.tentativeSession, this.tentativeStart) ?? identical(this.session, this.acceptedStartReceipt);
    if (retry) return retry;
    const request = this.startRequest?.id === requestId ? this.startRequest : undefined;
    if (!request || request.status !== 'pending' || this.session || this.tentativeStart) throw new Error('start request is unavailable');
    if (!sameAnchor(request.origin, origin)) throw new Error('origin does not match the authorized request');
    const session = this.newSession(origin);
    this.tentativeSession = session;
    this.tentativeStart = { schemaVersion: 1, requestId, sessionId: session.id, revision: session.revision, attentionStopId: session.attentionStopId };
    return copySession(session);
  }
  public cachedStartReceipt(requestId: string, origin: OriginDescriptor): StartReceipt | undefined { return this.acceptedStartReceipt?.requestId === requestId && this.acceptedStartOrigin && JSON.stringify(this.acceptedStartOrigin) === JSON.stringify(origin) ? { ...this.acceptedStartReceipt } : undefined; }
  /** Finalize only the exact receipt produced by the still-current tentative
   * session. Accepted receipts are immutable and cannot be rolled back. */
  public acknowledgeStartReceipt(receipt: StartReceipt): boolean { const request = this.startRequest; const tentative = this.tentativeStart; const session = this.tentativeSession; if (!request || request.status !== 'pending' || !tentative || !session || JSON.stringify(tentative) !== JSON.stringify(receipt) || session.id !== receipt.sessionId || session.revision !== receipt.revision || session.attentionStopId !== receipt.attentionStopId) return false; request.status = 'consumed'; this.session = session; this.tentativeSession = undefined; this.tentativeStart = undefined; this.acceptedStartReceipt = { ...receipt }; this.acceptedStartOrigin = { ...session.origin, range: copyRange(session.origin.range) }; return true; }
  /** Remove only the session still owned by this exact tentative receipt.
   * The original request object was never consumed, so retry sees the same
   * immutable request identity and origin. */
  public rollbackTentativeStart(receipt?: StartReceipt): boolean { const tentative = this.tentativeStart; const session = this.tentativeSession; if (!tentative || !session || (receipt !== undefined && JSON.stringify(tentative) !== JSON.stringify(receipt)) || session.id !== tentative.sessionId || session.revision !== tentative.revision || session.attentionStopId !== tentative.attentionStopId) return false; this.tentativeSession = undefined; this.tentativeStart = undefined; return true; }
  public captureReplacement(origin: OriginAnchor): ReplacementRequest { const session = this.session; if (!session) throw new Error('walkthrough replacement is unavailable'); if (this.replacementRequest?.status === 'pending') return this.getReplacementRequest(this.replacementRequest.id)!; const request: ReplacementRequest = { id: identifier('request'), kind: 'replace', origin: copyAnchor(origin), expectedSessionId: session.id, expectedRevision: session.revision, snapshot: { capturedAt: new Date().toISOString(), session: copySession(session) }, status: 'pending' }; this.replacementRequest = request; this.replacementRequests.set(request.id, request); return this.getReplacementRequest(request.id)!; }
  public getReplacementRequest(id: string): ReplacementRequest | undefined { const request = this.replacementRequests.get(id); return request && { ...request, origin: copyAnchor(request.origin), snapshot: { ...request.snapshot, session: copySession(request.snapshot.session) } }; }
  public getPendingReplacement(): ReplacementRequest | undefined { return this.replacementRequest?.status === 'pending' ? this.getReplacementRequest(this.replacementRequest.id) : undefined; }
  public discardReplacement(requestId?: string): void { if (this.replacementRequest?.status === 'pending' && (requestId === undefined || this.replacementRequest.id === requestId)) this.replacementRequest.status = 'cancelled'; }
  public replace(requestId: string, expectedSessionId: string, expectedRevision: number, origin: OriginDescriptor): SessionReceipt { const request = this.replacementRequests.get(requestId); const session = this.session; const existing = this.sessionReceipts.get(requestId); if (existing && (!session || session.id === existing.sessionId)) return { ...existing }; if (!request || request.status !== 'pending' || !session || request.expectedSessionId !== expectedSessionId || request.expectedRevision !== expectedRevision || session.id !== expectedSessionId || session.revision !== expectedRevision) throw new Error('walkthrough replacement is unavailable or stale'); if (!sameAnchor(request.origin, origin)) throw new Error('origin does not match the authorized replacement request'); const next = this.newSession(origin); this.session = next; request.status = 'consumed'; const receipt: SessionReceipt = { schemaVersion: 1, status: 'committed', requestId, sessionId: next.id, revision: next.revision, attentionStopId: next.attentionStopId }; this.sessionReceipts.set(requestId, receipt); return { ...receipt }; }
  public captureReset(): ResetRequest { const session = this.session; if (!session) throw new Error('walkthrough reset is unavailable'); if (this.resetRequest?.status === 'pending') return { ...this.resetRequest }; const request: ResetRequest = { id: identifier('request'), kind: 'reset', sessionId: session.id, revision: session.revision, status: 'pending' }; this.resetRequest = request; this.resetRequests.set(request.id, request); return { ...request }; }
  public getResetRequest(id: string): ResetRequest | undefined { const request = this.resetRequests.get(id); return request && { ...request }; }
  public getPendingReset(): ResetRequest | undefined { return this.resetRequest?.status === 'pending' ? this.getResetRequest(this.resetRequest.id) : undefined; }
  public discardReset(requestId?: string): void { if (this.resetRequest?.status === 'pending' && (requestId === undefined || this.resetRequest.id === requestId)) this.resetRequest.status = 'cancelled'; }
  public reset(requestId: string, expectedSessionId: string, expectedRevision: number): SessionReceipt { const request = this.resetRequests.get(requestId); const session = this.session; const existing = this.sessionReceipts.get(requestId); if (existing && !session) return { ...existing }; if (!request || request.status !== 'pending' || !session || request.sessionId !== expectedSessionId || request.revision !== expectedRevision || session.id !== expectedSessionId || session.revision !== expectedRevision) throw new Error('walkthrough reset is unavailable or stale'); this.session = undefined; request.status = 'consumed'; const receipt: SessionReceipt = { schemaVersion: 1, status: 'committed', requestId, sessionId: expectedSessionId, revision: expectedRevision }; this.sessionReceipts.set(requestId, receipt); return { ...receipt }; }
  public captureQuestion(sourceStopId: string, text: string, questionSnapshotContext: Omit<QuestionSnapshot, 'session'> = { stopExcerpts: [], editorState: { visibleEditors: [] } }): QuestionRequest { const session = this.session; const trimmed = text.trim(); if (!session || !session.stops.some((stop) => stop.id === sourceStopId)) throw new Error('question source is unavailable'); if (!trimmed) throw new Error('question text is empty'); if (this.questionRequest?.status === 'pending') throw new Error('question request is already pending'); const request: QuestionRequest = { id: identifier('request'), kind: 'question', sessionId: session.id, revision: session.revision, sourceStopId, text: trimmed, capturedAt: new Date().toISOString(), snapshot: { session: this.getSession()!, stopExcerpts: questionSnapshotContext.stopExcerpts.map((excerpt) => ({ ...excerpt, range: copyRange(excerpt.range) })), editorState: { ...questionSnapshotContext.editorState, visibleEditors: [...questionSnapshotContext.editorState.visibleEditors] } }, status: 'pending' }; this.questionRequest = request; this.questionRequests.set(request.id, request); return copyQuestionRequest(request); }
  public getQuestionRequest(id: string): QuestionRequest | undefined { const request = this.questionRequests.get(id); return request && copyQuestionRequest(request); }
  public getPendingQuestion(): QuestionRequest | undefined { return this.questionRequest?.status === 'pending' ? this.getQuestionRequest(this.questionRequest.id) : undefined; }
  public discardQuestion(requestId?: string): void { if (this.questionRequest?.status === 'pending' && (requestId === undefined || this.questionRequest.id === requestId)) this.questionRequest.status = 'cancelled'; }
  public commitQuestionOutcome(commit: QuestionCommit, outcome: QuestionOutcome): QuestionReceipt { const terminal = this.questionReceipts.get(commit.requestId); if (terminal) { if (JSON.stringify(terminal.commit) !== JSON.stringify(commit) || JSON.stringify(terminal.outcome) !== JSON.stringify(outcome)) throw new Error('question request does not match its terminal receipt'); return copyReceipt(terminal.receipt); } const request = this.questionRequests.get(commit.requestId); const session = this.session; if (!request || request.status !== 'pending' || !session || request.sessionId !== commit.sessionId || session.id !== commit.sessionId || session.revision !== commit.revision) throw new Error('question request is unavailable or stale'); const stops = session.stops.map(copyStop); if (outcome.kind === 'generated-walkthrough') applyPatch(stops, outcome.patch); if (outcome.kind === 'destination-offer') validateOffer(stops, request.sourceStopId, outcome.destinationIds); const source = stops.find((stop) => stop.id === request.sourceStopId); if (!source) throw new Error('question source is unavailable'); source.conversation.push({ author: 'You', bodyMarkdown: request.text }, { author: 'CodeAlongAI', bodyMarkdown: outcome.answerMarkdown }); validateGraph(stops, session.origin.stopId); this.session = { ...session, revision: session.revision + 1, stops }; request.status = 'consumed'; const receipt: QuestionReceipt = { schemaVersion: 1, status: 'committed', requestId: commit.requestId, sessionId: commit.sessionId, revision: this.session.revision, attentionStopId: this.session.attentionStopId }; this.questionReceipts.set(request.id, { commit: { ...commit }, outcome: copyOutcome(outcome), receipt }); return copyReceipt(receipt); }
  public navigationTarget(sourceStopId: string, direction: NavigationDirection): WalkthroughStop | undefined {
    const source = this.session?.stops.find((stop) => stop.id === sourceStopId);
    const targetId = direction === 'back' ? source?.backId : source?.recommendedNextId;
    return targetId === undefined ? undefined : this.session?.stops.find((stop) => stop.id === targetId);
  }
  public navigate(commit: NavigationCommit): NavigationReceipt {
    const session = this.session;
    if (!session || session.id !== commit.sessionId || session.revision !== commit.revision) throw new Error('walkthrough navigation is unavailable or stale');
    const target = this.navigationTarget(commit.sourceStopId, commit.direction);
    if (!target) throw new Error(`walkthrough ${commit.direction} is unavailable`);
    this.session = { ...session, revision: session.revision + 1, attentionStopId: target.id };
    return { schemaVersion: 1, sessionId: session.id, revision: this.session.revision, attentionStopId: target.id, sourceStopId: commit.sourceStopId, targetStopId: target.id };
  }
  public navigateDestination(commit: DestinationCommit): NavigationReceipt {
    const session = this.session;
    if (!session || session.id !== commit.sessionId || session.revision !== commit.revision) throw new Error('walkthrough navigation is unavailable or stale');
    const target = session.stops.find((stop) => stop.id === commit.targetStopId);
    if (!target) throw new Error('walkthrough destination is unavailable');
    this.session = { ...session, revision: session.revision + 1, attentionStopId: target.id };
    return { schemaVersion: 1, sessionId: session.id, revision: this.session.revision, attentionStopId: target.id, sourceStopId: session.attentionStopId, targetStopId: target.id };
  }
  public discardStart(): void { if (this.startRequest?.status === 'pending') { this.rollbackTentativeStart(); this.startRequest.status = 'cancelled'; } }
  private newSession(origin: OriginDescriptor): WalkthroughSession { const originStop: WalkthroughStop = { ...origin, id: origin.stopId, range: copyRange(origin.range), destinationIds: [], conversation: [{ author: 'CodeAlongAI', bodyMarkdown: origin.explanation }] }; return { id: identifier('walkthrough'), revision: 1, origin: { ...origin, range: copyRange(origin.range) }, attentionStopId: origin.stopId, stops: [originStop] }; }
}
function applyPatch(stops: WalkthroughStop[], patch: GraphPatch): void { const ids = new Set(stops.map((stop) => stop.id)); if (!patch.addedStops.length) throw new Error('graph patch must add a stop'); for (const added of patch.addedStops) { if (ids.has(added.id)) throw new Error('graph patch rewrites an existing stop'); ids.add(added.id); stops.push({ id: added.id, stopId: added.id, displayName: added.displayName, explanation: added.explanationMarkdown, document: added.path, range: copyRange(added.range), destinationIds: [...added.destinationIds], ...(added.recommendedNextId === undefined ? {} : { recommendedNextId: added.recommendedNextId }), ...(added.backId === undefined ? {} : { backId: added.backId }), conversation: [] }); } for (const append of patch.appendedDestinations) { const source = stops.find((stop) => stop.id === append.sourceStopId); if (!source || append.destinationIds.some((id) => source.destinationIds.includes(id) || !ids.has(id))) throw new Error('graph patch has invalid destination append'); source.destinationIds.push(...append.destinationIds); } for (const update of patch.recommendedNextUpdates) { const source = stops.find((stop) => stop.id === update.sourceStopId); if (!source || source.recommendedNextId !== undefined || !source.destinationIds.includes(update.targetStopId)) throw new Error('graph patch rewrites recommended next'); source.recommendedNextId = update.targetStopId; } }
function reachable(stops: readonly WalkthroughStop[], startId: string): Set<string> { const byId = new Map(stops.map((stop) => [stop.id, stop])); const found = new Set<string>(); const pending = [startId]; while (pending.length) { const id = pending.pop()!; if (found.has(id)) continue; found.add(id); for (const target of byId.get(id)?.destinationIds ?? []) pending.push(target); } return found; }
function validateOffer(stops: readonly WalkthroughStop[], sourceId: string, ids: readonly string[]): void { if (!ids.length || new Set(ids).size !== ids.length || ids.includes(sourceId) || ids.some((id) => !reachable(stops, sourceId).has(id))) throw new Error('destination offer is invalid'); }
function validateGraph(stops: readonly WalkthroughStop[], originId: string): void { const ids = new Set(stops.map((stop) => stop.id)); if (ids.size !== stops.length || !ids.has(originId)) throw new Error('graph has duplicate or missing stops'); for (const stop of stops) if (new Set(stop.destinationIds).size !== stop.destinationIds.length || stop.destinationIds.some((id) => !ids.has(id)) || (stop.recommendedNextId !== undefined && !stop.destinationIds.includes(stop.recommendedNextId)) || (stop.backId !== undefined && !ids.has(stop.backId))) throw new Error('graph has unresolved references'); if (reachable(stops, originId).size !== stops.length) throw new Error('graph has disconnected stops'); }
export function sameAnchor(left: OriginAnchor, right: OriginAnchor): boolean { return left.document === right.document && JSON.stringify(left.range) === JSON.stringify(right.range); }

/** A presentation-independent, recommended-first spanning tree of the known graph. */
export interface DestinationRow { stopId: string; depth: number; isLast: boolean; ancestorIsLast: readonly boolean[]; rejoinDisplayNames: readonly string[]; }
export function projectDestinations(session: WalkthroughSession): readonly DestinationRow[] {
  const byId = new Map(session.stops.map((stop) => [stop.id, stop]));
  const rows: { stopId: string; parentStopId?: string; depth: number; isLast: boolean; ancestorIsLast: boolean[]; rejoinDisplayNames: string[] }[] = [];
  const emitted = new Set<string>();
  const visit = (stopId: string, parentStopId: string | undefined, depth: number): void => {
    if (emitted.has(stopId)) return;
    const stop = byId.get(stopId);
    if (!stop) return;
    emitted.add(stopId);
    const row: (typeof rows)[number] = { stopId, parentStopId, depth, isLast: true, ancestorIsLast: [], rejoinDisplayNames: [] };
    rows.push(row);
    const children = stop.recommendedNextId === undefined ? [...stop.destinationIds] : [stop.recommendedNextId, ...stop.destinationIds.filter((id) => id !== stop.recommendedNextId)];
    for (const childId of children) {
      const child = byId.get(childId);
      if (!child) continue;
      if (emitted.has(childId)) { row.rejoinDisplayNames.push(child.displayName); continue; }
      visit(childId, stopId, depth + 1);
    }
  };
  visit(session.origin.stopId, undefined, 0);
  const byParent = new Map<string | undefined, Array<(typeof rows)[number]>>();
  for (const row of rows) { const siblings = byParent.get(row.parentStopId) ?? []; siblings.push(row); byParent.set(row.parentStopId, siblings); }
  for (const siblings of byParent.values()) siblings.forEach((row, index) => { row.isLast = index === siblings.length - 1; });
  const byStopId = new Map(rows.map((row) => [row.stopId, row]));
  for (const row of rows) {
    const ancestors: boolean[] = [];
    for (let parent = row.parentStopId === undefined ? undefined : byStopId.get(row.parentStopId); parent; parent = parent.parentStopId === undefined ? undefined : byStopId.get(parent.parentStopId)) ancestors.unshift(parent.isLast);
    row.ancestorIsLast = ancestors;
  }
  return rows.map(({ parentStopId: _parentStopId, ...row }) => row);
}
