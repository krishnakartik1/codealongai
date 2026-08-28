import * as vscode from 'vscode';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { commitDeterministicOrigin, commitDeterministicQuestion, commitDeterministicReplacement, LoopbackMcpEndpoint } from './mcp';
import { deriveOrigin, projectDestinations, type NavigationDirection, type OriginDescriptor, type QuestionOutcome, type QuestionRequest, type WalkthroughSession, type WalkthroughStop, WalkthroughAuthority } from './walkthrough';
import { normalizeWorkspacePath, type WorkspaceSource } from './workspace';
import { McpLifecycle, type McpLifecycleState } from './lifecycle';

const noOriginMessage = 'Select code or place the cursor on a nonblank line to start a walkthrough.';
const invitation = 'What would you like to understand about this code?';
export const commentThreadOptions = {
  prompt: 'Ask CodeAlongAI about this walkthrough stop',
  placeHolder: 'Type a question (try “Why is this negative?”)'
};

export function activate(context: vscode.ExtensionContext): { readonly endpointState: McpLifecycleState; readonly session: ReturnType<WalkthroughAuthority['getSession']> } {
  const authority = new WalkthroughAuthority();
  const controller = vscode.comments.createCommentController('codealongai.walkthrough', 'CodeAlongAI walkthrough');
  controller.commentingRangeProvider = { provideCommentingRanges: () => [] };
  controller.options = commentThreadOptions;
  let endpoint: LoopbackMcpEndpoint | undefined;
  let activePort: number | undefined;
  const output = vscode.window.createOutputChannel('CodeAlongAI', { log: true });
  const lifecycle = new McpLifecycle(async (port) => {
    const listener = new LoopbackMcpEndpoint(authority, vscodeWorkspaceSource());
    return {
      start: async () => { await listener.start(port); endpoint = listener; activePort = listener.port; output.info(`MCP ready on configured port ${port}.`); },
      stop: async () => { await listener.stop(); if (endpoint === listener) { endpoint = undefined; activePort = undefined; } output.info(`MCP listener stopped on configured port ${port}.`); }
    };
  });
  let endpointState: McpLifecycleState = 'off';
  const mcpReady = (): boolean => lifecycle.state === 'ready';
  const threads = new Map<string, vscode.CommentThread>();
  const threadStopIds = new Map<vscode.CommentThread, string>();
  const questionOutcomes = new Map<string, QuestionOutcome>();
  let retryStart: (() => Promise<void>) | undefined;
  let retryReplacement: (() => Promise<void>) | undefined;
  let retryReset: (() => Promise<void>) | undefined;
  let retryQuestion: (() => Promise<void>) | undefined;
  let retryQuestionRequest: QuestionRequest | undefined;
  let navigationInProgress = false;
  const threadFor = (stop: WalkthroughStop, document: vscode.TextDocument): vscode.CommentThread => {
    const existing = threads.get(stop.id);
    if (existing) return existing;
    const created = controller.createCommentThread(document.uri, asVscodeRange(stop.range), stop.conversation.map(commentFor));
    created.label = threadLabel(stop, authority.getSession()!);
    created.contextValue = navigationContext(stop);
    created.canReply = true;
    created.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    threads.set(stop.id, created);
    threadStopIds.set(created, stop.id);
    return created;
  };
  const refreshThreads = (session: NonNullable<ReturnType<WalkthroughAuthority['getSession']>>, targetId: string): void => {
    for (const stop of session.stops) {
      const current = threads.get(stop.id);
      if (!current) continue;
      current.comments = stop.conversation.map(commentFor);
      current.label = threadLabel(stop, session);
      current.contextValue = navigationContext(stop);
      current.collapsibleState = stop.id === targetId ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
    }
  };
  const discardQuestion = (requestId: string): void => {
    if (authority.getPendingQuestion()?.id === requestId) authority.discardQuestion(requestId);
    questionOutcomes.delete(requestId);
    if (retryQuestionRequest?.id === requestId) { retryQuestion = undefined; retryQuestionRequest = undefined; }
  };
  const updateEndpoint = async (): Promise<void> => {
    const config = vscode.workspace.getConfiguration('codealongai.mcp');
    const enabled = config.get<boolean>('enabled', false);
    const port = config.get<number>('port', 61337);
    try {
      const configured = lifecycle.configure({ enabled, port });
      endpointState = lifecycle.state;
      void vscode.commands.executeCommand('setContext', 'codealongai.mcpReady', false);
      await configured;
      endpointState = lifecycle.state;
      void vscode.commands.executeCommand('setContext', 'codealongai.mcpReady', endpointState === 'ready');
      output.info(`MCP lifecycle is ${endpointState}; configured port ${port}.`);
    } catch (error) {
      endpointState = lifecycle.state;
      void vscode.commands.executeCommand('setContext', 'codealongai.mcpReady', false);
      const message = error instanceof RangeError ? error.message : 'CodeAlongAI could not start MCP. Check that the configured loopback port is available.';
      output.error(`MCP lifecycle error (${error instanceof RangeError ? 'invalid_port' : 'bind_failed'}): ${String(error)}`);
      if (!(error instanceof RangeError) && config.get<boolean>('enabled', false) === enabled && config.get<number>('port', 61337) === port) await config.update('enabled', false, vscode.ConfigurationTarget.Workspace);
      void vscode.window.showErrorMessage(message);
    }
  };
  void updateEndpoint();
  const disposeThreads = (): void => { for (const thread of threads.values()) thread.dispose(); threads.clear(); threadStopIds.clear(); };
  const showReplacementFailure = (requestId: string): void => {
    const unavailable = !mcpReady();
    void vscode.window.showErrorMessage('CodeAlongAI could not replace the walkthrough. Your current walkthrough is unchanged.', unavailable ? 'Enable MCP' : 'Retry replacement', 'Keep current walkthrough').then((action) => {
      if (action === 'Enable MCP') void vscode.commands.executeCommand('workbench.action.openSettings', 'codealongai.mcp.enabled');
      if (action === 'Retry replacement') void retryReplacement?.();
      if (action === 'Keep current walkthrough') authority.discardReplacement(requestId);
    });
  };
  const showStartUnavailable = (requestId: string): void => {
    void vscode.window.showWarningMessage('CodeAlongAI needs its MCP endpoint to start this walkthrough.', 'Enable MCP', 'Cancel walkthrough').then((action) => {
      if (action === 'Enable MCP') void vscode.commands.executeCommand('workbench.action.openSettings', 'codealongai.mcp.enabled');
      if (action === 'Cancel walkthrough') authority.discardStart();
    });
    retryStart = async () => { await vscode.commands.executeCommand('codealongai.walkthrough.ask'); };
  };
  const showResetFailure = (requestId: string): void => {
    void vscode.window.showErrorMessage('CodeAlongAI could not reset the walkthrough. Your walkthrough is unchanged.', 'Retry reset', 'Keep walkthrough').then((action) => {
      if (action === 'Retry reset') void retryReset?.();
      if (action === 'Keep walkthrough') authority.discardReset(requestId);
    });
  };
  const askWalkthroughCommand = vscode.commands.registerCommand('codealongai.walkthrough.ask', async () => {
    await updateEndpoint();
    const current = authority.getSession();
    if (current) {
      const confirmation = await vscode.window.showWarningMessage('Starting a new walkthrough clears all conversations.', { modal: true }, 'Start new walkthrough', 'Cancel');
      if (confirmation !== 'Start new walkthrough') return undefined;
    }
    const editor = vscode.window.activeTextEditor;
    const origin = editor && deriveOrigin(vscode.workspace.asRelativePath(editor.document.uri, false), editor.selection, editor.document.lineAt(editor.selection.active.line).text);
    if (!origin) { void vscode.window.showWarningMessage(noOriginMessage); return undefined; }
    const replacement = authority.getPendingReplacement();
    const request = current ? (replacement ?? authority.captureReplacement(origin)) : (authority.getPendingStart() ?? authority.captureStart(origin));
    const descriptor: OriginDescriptor = { ...origin, stopId: 'checkout-origin', displayName: 'Origin', explanation: invitation };
    if (!current && !mcpReady()) { showStartUnavailable(request.id); return undefined; }
    try {
      if (current) {
        if (!mcpReady()) throw new Error('the MCP endpoint is disabled');
        await commitDeterministicReplacement(activePort!, request.id, current.id, current.revision, descriptor);
      } else await commitDeterministicOrigin(vscode.workspace.getConfiguration('codealongai.mcp').get<number>('port', 61337), request.id, descriptor);
      const session = authority.getSession();
      if (!session) throw new Error('the producer did not create a walkthrough');
      const pendingQuestion = authority.getPendingQuestion();
      if (pendingQuestion) discardQuestion(pendingQuestion.id);
      disposeThreads();
      threadFor(session.stops[0], editor.document);
      retryReplacement = undefined;
      return { endpointState, session };
    } catch (error) {
      if (current) {
        retryReplacement = async () => {
          try {
            if (!mcpReady()) throw new Error('the MCP endpoint is disabled');
            await commitDeterministicReplacement(activePort!, request.id, current.id, current.revision, descriptor);
            const session = authority.getSession();
            if (!session) throw new Error('the producer did not create a walkthrough');
            disposeThreads();
            threadFor(session.stops[0], editor.document);
            retryReplacement = undefined;
          } catch { showReplacementFailure(request.id); }
        };
        showReplacementFailure(request.id);
        return undefined;
      }
      retryStart = async () => { await vscode.commands.executeCommand('codealongai.walkthrough.ask'); };
      void vscode.window.showErrorMessage(`CodeAlongAI could not start the walkthrough: ${String(error)}`, 'Retry walkthrough', 'Discard request').then((action) => {
        if (action === 'Retry walkthrough') void retryStart?.();
        if (action === 'Discard request') authority.discardStart();
      });
      return undefined;
    }
  });
  const resetWalkthroughCommand = vscode.commands.registerCommand('codealongai.walkthrough.reset', async () => {
    const current = authority.getSession();
    if (!current) return;
    const confirmation = await vscode.window.showWarningMessage('Reset this walkthrough? All walkthrough conversations will be cleared.', { modal: true }, 'Reset walkthrough', 'Cancel');
    if (confirmation !== 'Reset walkthrough') return;
    const request = authority.getPendingReset() ?? authority.captureReset();
    const commit = (): void => { authority.reset(request.id, current.id, current.revision); disposeThreads(); retryReset = undefined; };
    try { commit(); }
    catch { retryReset = async () => { try { commit(); } catch { showResetFailure(request.id); } }; showResetFailure(request.id); }
  });
  const submitCommentCommand = vscode.commands.registerCommand('codealongai.walkthrough.submitComment', async (reply: vscode.CommentReply) => {
    const sourceStopId = threadStopIds.get(reply.thread);
    const text = reply.text.trim();
    if (!sourceStopId || !text) return;
    const session = authority.getSession();
    if (!session) return;
    const pending = authority.getPendingQuestion() ?? retryQuestionRequest;
    if (!mcpReady()) {
      if (pending) void vscode.window.showWarningMessage('CodeAlongAI needs its MCP endpoint to finish the pending question.', 'Enable MCP', 'Discard question').then((action) => {
        if (action === 'Enable MCP') void vscode.commands.executeCommand('workbench.action.openSettings', 'codealongai.mcp.enabled');
        if (action === 'Discard question') discardQuestion(pending.id);
      });
      return;
    }
    if (pending && (pending.sourceStopId !== sourceStopId || pending.text !== text)) {
      void vscode.window.showWarningMessage('Finish or discard the pending CodeAlongAI question before submitting another.', 'Retry question', 'Discard question').then((action) => {
        if (action === 'Retry question') void retryQuestion?.();
        if (action === 'Discard question') discardQuestion(pending.id);
      });
      return;
    }
    const request = pending ?? authority.captureQuestion(sourceStopId, text, await captureQuestionSnapshot(session));
    retryQuestionRequest = request;
    retryQuestion = async () => { await vscode.commands.executeCommand('codealongai.walkthrough.submitComment', reply); };
    const outcome = questionOutcomes.get(request.id) ?? deterministicQuestionOutcome(session);
    questionOutcomes.set(request.id, outcome);
    try {
      const requestStatus = authority.getQuestionRequest(request.id)?.status;
      await commitDeterministicQuestion(activePort!, { requestId: request.id, sessionId: requestStatus === 'consumed' ? request.sessionId : session.id, revision: requestStatus === 'consumed' ? request.revision : session.revision }, outcome);
      questionOutcomes.delete(request.id);
      if (retryQuestionRequest?.id === request.id) { retryQuestion = undefined; retryQuestionRequest = undefined; }
      const committed = authority.getSession()!;
      const source = committed.stops.find((stop) => stop.id === sourceStopId)!;
      reply.thread.comments = source.conversation.map(commentFor);
      refreshThreads(committed, committed.attentionStopId);
    } catch (error) {
      void vscode.window.showErrorMessage(`CodeAlongAI could not answer the question: ${String(error)}`, 'Retry question', 'Discard question').then((action) => {
        if (action === 'Retry question') void retryQuestion?.();
        if (action === 'Discard question') discardQuestion(request.id);
      });
    }
  });
  const navigate = async (direction: NavigationDirection, thread?: vscode.CommentThread): Promise<void> => {
    const session = authority.getSession();
    const sourceStopId = thread ? threadStopIds.get(thread) : session?.attentionStopId;
    if (!session || !sourceStopId) return;
    const target = authority.navigationTarget(sourceStopId, direction);
    if (!target) { void vscode.window.showErrorMessage(`CodeAlongAI ${direction} is unavailable for this walkthrough stop.`); return; }
    await navigateTo(session, target, () => authority.navigate({ sessionId: session.id, revision: session.revision, sourceStopId, direction }));
  };
  const navigateTo = async (session: NonNullable<ReturnType<WalkthroughAuthority['getSession']>>, target: WalkthroughStop, commit: () => unknown): Promise<void> => {
    const tabsBefore = visibleTextTabLocations();
    if (navigationInProgress) { void vscode.window.showErrorMessage('CodeAlongAI navigation is already in progress.'); return; }
    navigationInProgress = true;
    const threadsBefore = new Map([...threads].map(([stopId, currentThread]) => [stopId, currentThread.collapsibleState]));
    const editorRangesBefore = visibleTextEditorRanges();
    try {
      const document = await openStopDocument(target);
      await showStopDocument(document, target, session.origin);
      threadFor(target, document);
      refreshThreads(session, target.id);
      commit();
    } catch {
      await restorePreparedNavigation(tabsBefore, editorRangesBefore, threads, threadsBefore);
      const current = authority.getSession();
      if (current) refreshThreads(current, current.attentionStopId);
      void vscode.window.showErrorMessage('CodeAlongAI could not navigate to that walkthrough stop.');
    } finally { navigationInProgress = false; }
  };
  const navigateDestination = async (targetStopId: string): Promise<void> => {
    const session = authority.getSession();
    const target = session?.stops.find((stop) => stop.id === targetStopId);
    if (!session || !target) return;
    await navigateTo(session, target, () => authority.navigateDestination({ sessionId: session.id, revision: session.revision, targetStopId }));
  };
  const backCommand = vscode.commands.registerCommand('codealongai.walkthrough.back', (thread?: vscode.CommentThread) => navigate('back', thread));
  const nextCommand = vscode.commands.registerCommand('codealongai.walkthrough.next', (thread?: vscode.CommentThread) => navigate('next', thread));
  const destinationsCommand = vscode.commands.registerCommand('codealongai.walkthrough.destinations', async () => {
    const session = authority.getSession();
    if (!session) return;
    const items = destinationQuickPickItems(session);
    const selected = await vscode.window.showQuickPick(items, { title: 'Walkthrough graph', placeHolder: 'Select a walkthrough stop' });
    if (selected) await navigateDestination(selected.stopId);
  });
  context.subscriptions.push(askWalkthroughCommand, resetWalkthroughCommand, submitCommentCommand, backCommand, nextCommand, destinationsCommand, controller, output, vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('codealongai.mcp')) void updateEndpoint().then(() => {
    if (!mcpReady()) return;
    const replacement = authority.getPendingReplacement();
    if (replacement) showReplacementFailure(replacement.id);
    const start = authority.getPendingStart();
    if (start) void vscode.window.showInformationMessage('CodeAlongAI MCP is ready.', 'Retry walkthrough').then((action) => { if (action === 'Retry walkthrough') void retryStart?.(); });
    const question = authority.getPendingQuestion();
    if (question) void vscode.window.showInformationMessage('CodeAlongAI MCP is ready.', 'Retry question').then((action) => { if (action === 'Retry question') void retryQuestion?.(); });
  }); }), { dispose: () => { disposeThreads(); void lifecycle.dispose(); } });
  return { get endpointState() { return lifecycle.state; }, get session() { return authority.getSession(); } };
}

export function deactivate(): void {}

const commentFor = (comment: { author: 'You' | 'CodeAlongAI'; bodyMarkdown: string }): vscode.Comment => ({ body: comment.bodyMarkdown, mode: vscode.CommentMode.Preview, author: { name: comment.author } });
const asVscodeRange = (range: { start: { line: number; character: number }; end: { line: number; character: number } }): vscode.Range => new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
export const navigationContext = (stop: WalkthroughStop): string => [
  'codealongaiWalkthrough',
  stop.destinationIds.length === 0 ? undefined : 'hasDestinations',
  stop.backId === undefined ? undefined : 'hasBack',
  stop.recommendedNextId === undefined ? undefined : 'hasNext'
].filter((part): part is string => part !== undefined).join('-');

interface DestinationQuickPickItem extends vscode.QuickPickItem { stopId: string; }
export function destinationQuickPickItems(session: WalkthroughSession): readonly DestinationQuickPickItem[] {
  const byId = new Map(session.stops.map((stop) => [stop.id, stop]));
  return projectDestinations(session).map((row) => {
    const stop = byId.get(row.stopId)!;
    const connector = row.depth === 0 ? '' : `${row.ancestorIsLast.map((last) => last ? '   ' : '│  ').join('')}${row.isLast ? '└─ ' : '├─ '}`;
    const markers = row.rejoinDisplayNames.map((name) => ` ↗ ${name}`).join('');
    const location = `L${stop.range.start.line + 1}:C${stop.range.start.character + 1}`;
    return { stopId: stop.id, label: `${stop.id === session.attentionStopId ? '$(location) ' : ''}${connector}${stop.displayName}${markers} ${location}` };
  });
}

export function threadLabel(stop: WalkthroughStop, session: WalkthroughSession): string {
  const matching = session.stops.filter((candidate) => candidate.displayName === stop.displayName && candidate.document === stop.document && JSON.stringify(candidate.range) === JSON.stringify(stop.range));
  const ordinal = matching.findIndex((candidate) => candidate.id === stop.id) + 1;
  return `CodeAlongAI · ${stop.displayName}${matching.length > 1 ? ` (${ordinal})` : ''}`;
}

async function openStopDocument(stop: Pick<WalkthroughStop, 'document' | 'range'>): Promise<vscode.TextDocument> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('workspace unavailable');
  const path = normalizeWorkspacePath(stop.document);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, ...path.split('/')));
  if (stop.range.start.line >= document.lineCount || stop.range.end.line >= document.lineCount || stop.range.start.character > document.lineAt(stop.range.start.line).range.end.character || stop.range.end.character > document.lineAt(stop.range.end.line).range.end.character) throw new Error('stop range unavailable');
  return document;
}

async function showStopDocument(document: vscode.TextDocument, stop: WalkthroughStop, origin: OriginDescriptor): Promise<void> {
  let viewColumn: vscode.ViewColumn | undefined;
  if (stop.id === origin.stopId) viewColumn = vscode.ViewColumn.One;
  else if (stop.document !== origin.document) {
    const originDocument = await openStopDocument(origin);
    await vscode.window.showTextDocument(originDocument, { viewColumn: vscode.ViewColumn.One, preserveFocus: true, preview: false });
    viewColumn = vscode.ViewColumn.Two;
  } else viewColumn = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === document.uri.toString())?.viewColumn ?? vscode.window.activeTextEditor?.viewColumn;
  const editor = await vscode.window.showTextDocument(document, { viewColumn, preserveFocus: true, preview: false });
  editor.revealRange(asVscodeRange(stop.range), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function visibleTextTabLocations(): Set<string> {
  return new Set(vscode.window.tabGroups.all.flatMap((group) => group.tabs).flatMap((tab) => tab.input instanceof vscode.TabInputText ? [`${tab.input.uri.toString()}\u0000${tab.group.viewColumn}`] : []));
}

function visibleTextEditorRanges(): readonly { uri: string; viewColumn: vscode.ViewColumn | undefined; range: vscode.Range }[] {
  return vscode.window.visibleTextEditors.map((editor) => ({ uri: editor.document.uri.toString(), viewColumn: editor.viewColumn, range: editor.visibleRanges[0] ?? editor.document.lineAt(0).range }));
}

async function restorePreparedNavigation(tabsBefore: ReadonlySet<string>, editorRangesBefore: readonly { uri: string; viewColumn: vscode.ViewColumn | undefined; range: vscode.Range }[], threads: Map<string, vscode.CommentThread>, threadsBefore: ReadonlyMap<string, vscode.CommentThreadCollapsibleState>): Promise<void> {
  for (const [stopId, thread] of threads) {
    const previous = threadsBefore.get(stopId);
    if (previous === undefined) { thread.dispose(); threads.delete(stopId); }
    else thread.collapsibleState = previous;
  }
  const addedTabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputText && !tabsBefore.has(`${tab.input.uri.toString()}\u0000${tab.group.viewColumn}`));
  if (addedTabs.length) await vscode.window.tabGroups.close(addedTabs, true);
  for (const previous of editorRangesBefore) vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === previous.uri && editor.viewColumn === previous.viewColumn)?.revealRange(previous.range, vscode.TextEditorRevealType.Default);
}

async function captureQuestionSnapshot(session: NonNullable<ReturnType<WalkthroughAuthority['getSession']>>): Promise<{ stopExcerpts: { stopId: string; path: string; range: { start: { line: number; character: number }; end: { line: number; character: number } }; text: string; documentVersion?: number }[]; editorState: { visibleEditors: string[]; activeVisibleEditorIndex?: number } }> {
  const documents = await Promise.all(session.stops.map(async (stop) => {
    try { const path = normalizeWorkspacePath(stop.document); const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, ...path.split('/'))); return { stopId: stop.id, path, range: stop.range, text: document.getText(new vscode.Range(stop.range.start.line, 0, stop.range.end.line + 1, 0)), documentVersion: document.version }; }
    catch { return undefined; }
  }));
  const visibleEditors = vscode.window.visibleTextEditors.map((editor) => vscode.workspace.asRelativePath(editor.document.uri, false));
  const activeVisibleEditorIndex = vscode.window.activeTextEditor ? vscode.window.visibleTextEditors.indexOf(vscode.window.activeTextEditor) : undefined;
  return { stopExcerpts: documents.filter((excerpt): excerpt is Exclude<typeof excerpt, undefined> => excerpt !== undefined), editorState: { visibleEditors, ...(activeVisibleEditorIndex === undefined || activeVisibleEditorIndex < 0 ? {} : { activeVisibleEditorIndex }) } };
}

export function deterministicQuestionOutcome(session: NonNullable<ReturnType<WalkthroughAuthority['getSession']>>): QuestionOutcome {
  if (session.stops.some((stop) => stop.id === 'initial-value')) return { kind: 'explanation-only', answerMarkdown: 'This follow-up stays attached to the current walkthrough stop.' };
  if (session.stops.some((stop) => stop.id === 'pricing-function')) return { kind: 'generated-walkthrough', answerMarkdown: 'The reducer begins with its initial value.', patch: { addedStops: [
    { id: 'initial-value', displayName: 'Initial value', explanationMarkdown: 'The reduction starts from its initial value.', path: 'pricing.ts', range: { start: { line: 1, character: 41 }, end: { line: 1, character: 42 } }, destinationIds: [], backId: 'pricing-reducer-revisit' }
  ], appendedDestinations: [{ sourceStopId: 'pricing-reducer-revisit', destinationIds: ['initial-value'] }], recommendedNextUpdates: [] } };
  return { kind: 'generated-walkthrough', answerMarkdown: 'Follow the value through the subtotal function and its reducer.', patch: { addedStops: [
    { id: 'pricing-function', displayName: 'Definition', explanationMarkdown: 'This defines the subtotal calculation.', path: 'pricing.ts', range: { start: { line: 0, character: 16 }, end: { line: 0, character: 51 } }, destinationIds: ['pricing-reducer'], recommendedNextId: 'pricing-reducer', backId: 'checkout-origin' },
    { id: 'pricing-reducer', displayName: 'Reducer', explanationMarkdown: 'The reducer subtracts each price.', path: 'pricing.ts', range: { start: { line: 1, character: 41 }, end: { line: 1, character: 54 } }, destinationIds: ['pricing-reducer-revisit'], recommendedNextId: 'pricing-reducer-revisit', backId: 'pricing-function' },
    { id: 'pricing-reducer-revisit', displayName: 'Reducer', explanationMarkdown: 'Revisit the same reduction expression.', path: 'pricing.ts', range: { start: { line: 1, character: 41 }, end: { line: 1, character: 54 } }, destinationIds: [], backId: 'pricing-reducer' },
    { id: 'checkout-cart', displayName: 'Cart input', explanationMarkdown: 'The cart supplies the prices.', path: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 22 } }, destinationIds: ['pricing-function'], recommendedNextId: 'pricing-function', backId: 'checkout-origin' }
  ], appendedDestinations: [{ sourceStopId: 'checkout-origin', destinationIds: ['pricing-function', 'checkout-cart'] }], recommendedNextUpdates: [{ sourceStopId: 'checkout-origin', targetStopId: 'pricing-function' }] } };
}

function vscodeWorkspaceSource(): WorkspaceSource {
  return {
    workspaceFolderCount: () => vscode.workspace.workspaceFolders?.length ?? 0,
    listFiles: async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return [];
      const uris = await vscode.workspace.findFiles('**/*');
      const paths = new Set(uris.map((uri) => vscode.workspace.asRelativePath(uri, false)));
      for (const document of vscode.workspace.textDocuments) if (vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() === folder.uri.toString()) paths.add(vscode.workspace.asRelativePath(document.uri, false));
      return [...paths];
    },
    readFile: async (relativePath) => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return { path: relativePath, dirty: false, failure: 'file_unsupported' as const };
      const uri = vscode.Uri.joinPath(folder.uri, ...relativePath.split('/'));
      try {
        if (folder.uri.scheme === 'file') {
          const workspaceRoot = await realpath(folder.uri.fsPath);
          const resolved = await realpath(uri.fsPath);
          if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`)) return { path: relativePath, dirty: false, failure: 'path_outside_workspace' as const };
        }
        const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri.toString());
        if (document) return { path: relativePath, text: document.getText(), dirty: document.isDirty, documentVersion: document.version };
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.byteLength > 1024 * 1024) return { path: relativePath, dirty: false, failure: 'file_too_large' as const };
        return { path: relativePath, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), dirty: false };
      } catch { return { path: relativePath, dirty: false, failure: 'file_unsupported' as const }; }
    }
  };
}
