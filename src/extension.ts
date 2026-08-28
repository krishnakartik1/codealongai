import * as vscode from 'vscode';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { commitDeterministicOrigin, LoopbackMcpEndpoint } from './mcp';
import { deriveOrigin, type OriginDescriptor, WalkthroughAuthority } from './walkthrough';
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
  context.subscriptions.push(askWalkthroughCommand, controller, vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('codealongai.mcp')) void updateEndpoint(); }), { dispose: () => { thread?.dispose(); void endpoint?.stop(); } });
  return { get endpointState() { return endpointState; }, get session() { return authority.getSession(); } };
}

export function deactivate(): void {}

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
