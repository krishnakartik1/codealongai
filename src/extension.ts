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
  const replay = new ReplayController(deterministicReplayFixture.events);

  const askPair = vscode.commands.registerCommand(
    'codealongai.askPair',
    (): AskPairStartedResult => {
      replay.reset();
      return { status: 'started', event: replay.start() };
    }
  );
  const advanceReplay = vscode.commands.registerCommand(
    'codealongai.replay.advance',
    (): ReplayEvent | undefined => replay.advance()
  );
  const cancelReplay = vscode.commands.registerCommand(
    'codealongai.replay.cancel',
    (): void => replay.cancel()
  );
  const resetReplay = vscode.commands.registerCommand(
    'codealongai.replay.reset',
    (): void => replay.reset()
  );

  context.subscriptions.push(askPair, advanceReplay, cancelReplay, resetReplay);
}

export function deactivate(): void {}
