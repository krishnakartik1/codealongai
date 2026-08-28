import * as vscode from 'vscode';
import { commitDeterministicOrigin, LoopbackMcpEndpoint } from './mcp';
import { deriveOrigin, type OriginDescriptor, WalkthroughAuthority } from './walkthrough';

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
  let retryStart: (() => Promise<void>) | undefined;
  const updateEndpoint = async (): Promise<void> => {
    const config = vscode.workspace.getConfiguration('codealongai.mcp');
    const enabled = config.get<boolean>('enabled', false);
    const port = config.get<number>('port', 61337);
    if (!enabled) { await endpoint?.stop(); endpoint = undefined; endpointState = 'off'; void vscode.commands.executeCommand('setContext', 'codealongai.mcpReady', false); return; }
    if (!Number.isInteger(port) || port < 1024 || port > 65535) { endpointState = 'off'; void vscode.window.showErrorMessage('CodeAlongAI MCP port must be an integer from 1024 through 65535.'); return; }
    if (endpoint && activePort !== port) { await endpoint.stop(); endpoint = undefined; endpointState = 'off'; }
    if (!endpoint) {
      endpoint = new LoopbackMcpEndpoint(authority);
      try { await endpoint.start(port); activePort = port; endpointState = 'ready'; void vscode.commands.executeCommand('setContext', 'codealongai.mcpReady', true); }
      catch (error) { endpoint = undefined; endpointState = 'off'; void vscode.commands.executeCommand('setContext', 'codealongai.mcpReady', false); void vscode.window.showErrorMessage(`CodeAlongAI could not start MCP: ${String(error)}`); }
    }
  };
  void updateEndpoint();
  const ask = vscode.commands.registerCommand('codealongai.walkthrough.ask', async () => {
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
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
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
  context.subscriptions.push(ask, controller, vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('codealongai.mcp')) void updateEndpoint(); }), { dispose: () => { thread?.dispose(); void endpoint?.stop(); } });
  return { get endpointState() { return endpointState; }, get session() { return authority.getSession(); } };
}

export function deactivate(): void {}
