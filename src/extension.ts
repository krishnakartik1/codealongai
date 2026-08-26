import * as vscode from 'vscode';
import {
  deterministicReplayFixture,
  ReplayController,
  type ReplayEvent
} from './replay';

export interface AskPairStartedResult {
  status: 'started';
  event: ReplayEvent | undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const askPair = vscode.commands.registerCommand(
    'codealongai.askPair',
    (): AskPairStartedResult => {
      const replay = new ReplayController(deterministicReplayFixture.events);

      return { status: 'started', event: replay.start() };
    }
  );

  context.subscriptions.push(askPair);
}

export function deactivate(): void {}
