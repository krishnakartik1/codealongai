import * as vscode from 'vscode';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { commitDeterministicOrigin, commitDeterministicQuestion, LoopbackMcpEndpoint } from './mcp';
import { deriveOrigin, type OriginDescriptor, type QuestionOutcome, WalkthroughAuthority } from './walkthrough';
import type { WorkspaceSource } from './workspace';

const noOriginMessage = 'Select code or place the cursor on a nonblank line to start a walkthrough.';
const invitation = 'What would you like to understand about this code?';

export function activate(context: vscode.ExtensionContext): { readonly endpointState: 'off' | 'ready'; readonly session: ReturnType<WalkthroughAuthority['getSession']> } {
  const authority = new WalkthroughAuthority();
  const controller = vscode.comments.createCommentController('codealongai.walkthrough', 'CodeAlongAI walkthrough');
  controller.commentingRangeProvider = { provideCommentingRanges: () => [] };
  controller.options = { prompt: 'Ask CodeAlongAI about this walkthrough stop' };
  let endpoint: LoopbackMcpEndpoint | undefined;
  let activePort: number | undefined;
  let endpointState: 'off' | 'ready' = 'off';
  let thread: vscode.CommentThread | undefined;
  const threadStopIds = new Map<vscode.CommentThread, string>();
  let retryStart: (() => Promise<void>) | undefined;
  const updateEndpoint = async (): Promise<void> => {
    const config = vscode.workspace.getConfiguration('codealongai.mcp');
    const enabled = config.get<boolean>('enabled', false);
    const port = config.get<number>('port', 61337);
    if (!enabled) { await endpoint?.stop(); endpoint = undefined; endpointState = 'off'; void vscode.commands.executeCommand('setContext', 'codealongai.mcpReady', false); return; }
    if (!Number.isInteger(port) || port < 1024 || port > 65535) { endpointState = 'off'; void vscode.window.showErrorMessage('CodeAlongAI MCP port must be an integer from 1024 through 65535.'); return; }
    if (endpoint && activePort !== port) { await endpoint.stop(); endpoint = undefined; endpointState = 'off'; }
    if (!endpoint) {
      endpoint = new LoopbackMcpEndpoint(authority, vscodeWorkspaceSource());
      try { await endpoint.start(port); activePort = port; endpointState = 'ready'; void vscode.commands.executeCommand('setContext', 'codealongai.mcpReady', true); }
      catch (error) { endpoint = undefined; endpointState = 'off'; void vscode.commands.executeCommand('setContext', 'codealongai.mcpReady', false); void vscode.window.showErrorMessage(`CodeAlongAI could not start MCP: ${String(error)}`); }
    }
  };
  void updateEndpoint();
  const askWalkthroughCommand = vscode.commands.registerCommand('codealongai.walkthrough.ask', async () => {
    await updateEndpoint();
    if (endpointState !== 'ready') { void vscode.window.showWarningMessage('Enable the CodeAlongAI MCP endpoint to start a walkthrough.'); return undefined; }
    const editor = vscode.window.activeTextEditor;
    const origin = editor && deriveOrigin(vscode.workspace.asRelativePath(editor.document.uri, false), editor.selection, editor.document.lineAt(editor.selection.active.line).text);
    if (!origin) { void vscode.window.showWarningMessage(noOriginMessage); return undefined; }
    const request = authority.getPendingStart() ?? authority.captureStart(origin);
    const descriptor: OriginDescriptor = { ...origin, stopId: 'checkout-origin', displayName: 'Origin', explanation: invitation };
    try {
      await commitDeterministicOrigin(vscode.workspace.getConfiguration('codealongai.mcp').get<number>('port', 61337), request.id, descriptor);
      const session = authority.getSession();
      if (!session) throw new Error('the producer did not create a walkthrough');
      thread?.dispose();
      thread = controller.createCommentThread(editor.document.uri, new vscode.Range(origin.range.start.line, origin.range.start.character, origin.range.end.line, origin.range.end.character), [{ body: invitation, mode: vscode.CommentMode.Preview, author: { name: 'CodeAlongAI' } }]);
      thread.label = 'CodeAlongAI · Origin';
      thread.contextValue = 'codealongai.walkthrough';
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      threadStopIds.set(thread, session.origin.stopId);
      return { endpointState, session };
    } catch (error) {
      retryStart = async () => { await vscode.commands.executeCommand('codealongai.walkthrough.ask'); };
      void vscode.window.showErrorMessage(`CodeAlongAI could not start the walkthrough: ${String(error)}`, 'Retry walkthrough', 'Discard request').then((action) => {
        if (action === 'Retry walkthrough') void retryStart?.();
        if (action === 'Discard request') authority.discardStart();
      });
      return undefined;
    }
  });
  const submitCommentCommand = vscode.commands.registerCommand('codealongai.walkthrough.submitComment', async (reply: vscode.CommentReply) => {
    const sourceStopId = threadStopIds.get(reply.thread);
    const text = reply.text.trim();
    if (!sourceStopId || !text) return;
    const session = authority.getSession();
    if (!session || endpointState !== 'ready') return;
    const request = authority.getPendingQuestion() ?? authority.captureQuestion(sourceStopId, text, await captureQuestionSnapshot(session));
    try {
      await commitDeterministicQuestion(activePort!, request.id, session.id, session.revision, deterministicQuestionOutcome());
      const committed = authority.getSession()!;
      const source = committed.stops.find((stop) => stop.id === sourceStopId)!;
      reply.thread.comments = source.conversation.map((comment) => ({ body: comment.bodyMarkdown, mode: vscode.CommentMode.Preview, author: { name: comment.author } }));
    } catch (error) {
      void vscode.window.showErrorMessage(`CodeAlongAI could not answer the question: ${String(error)}`, 'Retry question', 'Discard question').then((action) => {
        if (action === 'Retry question') void vscode.commands.executeCommand('codealongai.walkthrough.submitComment', reply);
        if (action === 'Discard question') authority.discardQuestion();
      });
    }
  });
  context.subscriptions.push(askWalkthroughCommand, submitCommentCommand, controller, vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('codealongai.mcp')) void updateEndpoint(); }), { dispose: () => { thread?.dispose(); void endpoint?.stop(); } });
  return { get endpointState() { return endpointState; }, get session() { return authority.getSession(); } };
}

export function deactivate(): void {}

async function captureQuestionSnapshot(session: NonNullable<ReturnType<WalkthroughAuthority['getSession']>>): Promise<{ stopExcerpts: { stopId: string; path: string; range: { start: { line: number; character: number }; end: { line: number; character: number } }; text: string; documentVersion?: number }[]; editorState: { visibleEditors: string[]; activeVisibleEditorIndex?: number } }> {
  const documents = await Promise.all(session.stops.map(async (stop) => {
    try { const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, ...stop.document.split('/'))); return { stopId: stop.id, path: stop.document, range: stop.range, text: document.getText(new vscode.Range(stop.range.start.line, 0, stop.range.end.line + 1, 0)), documentVersion: document.version }; }
    catch { return undefined; }
  }));
  const visibleEditors = vscode.window.visibleTextEditors.map((editor) => vscode.workspace.asRelativePath(editor.document.uri, false));
  const activeVisibleEditorIndex = vscode.window.activeTextEditor ? vscode.window.visibleTextEditors.indexOf(vscode.window.activeTextEditor) : undefined;
  return { stopExcerpts: documents.filter((excerpt): excerpt is Exclude<typeof excerpt, undefined> => excerpt !== undefined), editorState: { visibleEditors, ...(activeVisibleEditorIndex === undefined || activeVisibleEditorIndex < 0 ? {} : { activeVisibleEditorIndex }) } };
}

function deterministicQuestionOutcome(): QuestionOutcome {
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
