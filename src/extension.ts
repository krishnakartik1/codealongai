import * as vscode from 'vscode';

export interface AskPairReadyResult {
  status: 'ready';
}

export function activate(context: vscode.ExtensionContext): void {
  const askPair = vscode.commands.registerCommand(
    'codealongai.askPair',
    (): AskPairReadyResult => {
      void vscode.window.showInformationMessage('CodeAlongAI: your pair is ready.');

      return { status: 'ready' };
    }
  );

  context.subscriptions.push(askPair);
}

export function deactivate(): void {}
