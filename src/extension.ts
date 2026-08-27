import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  InteractionController,
  type InteractionState
} from './interaction';
import { deterministicReplayFixture, type DocumentRange } from './replay';

const aiPointerStyle = vscode.window.createTextEditorDecorationType({
  after: { contentText: '  CodeAlongAI →', color: new vscode.ThemeColor('editorInfo.foreground') },
  border: '1px solid',
  borderColor: new vscode.ThemeColor('editorInfo.foreground')
});

const explanationStyle = vscode.window.createTextEditorDecorationType({
  after: { contentText: '  CodeAlongAI explanation', color: new vscode.ThemeColor('editorInfo.foreground') }
});

function documentRange(editor: vscode.TextEditor): DocumentRange {
  return {
    document: path.basename(editor.document.uri.fsPath),
    range: { start: editor.selection.start, end: editor.selection.end }
  };
}

function toRange(target: DocumentRange): vscode.Range {
  return new vscode.Range(
    new vscode.Position(target.range.start.line, target.range.start.character),
    new vscode.Position(target.range.end.line, target.range.end.character)
  );
}

function applyCues(state: InteractionState): void {
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(aiPointerStyle, []);
    editor.setDecorations(explanationStyle, []);
    if (state.aiAttention?.target.document === path.basename(editor.document.uri.fsPath)) {
      editor.setDecorations(aiPointerStyle, [toRange(state.aiAttention.target)]);
    }
    for (const explanation of state.explanations) {
      if (explanation.target.document === path.basename(editor.document.uri.fsPath)) {
        editor.setDecorations(explanationStyle, [{
          range: toRange(explanation.target),
          renderOptions: { after: { contentText: `  ${explanation.message}` } }
        }]);
      }
    }
  }
}

async function revealFollowTarget(target: DocumentRange): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (workspace === undefined) {
    return;
  }
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(workspace.uri, target.document)
  );
  const editor = await vscode.window.showTextDocument(document);
  editor.revealRange(toRange(target), vscode.TextEditorRevealType.InCenter);
}

export function activate(context: vscode.ExtensionContext): void {
  const interaction = new InteractionController(deterministicReplayFixture.events);
  let visibleState: InteractionState = {
    humanSelection: undefined,
    aiAttention: undefined,
    explanations: [],
    follow: 'not-following',
    followTarget: undefined
  };
  const render = (state: InteractionState): InteractionState => {
    visibleState = state;
    applyCues(visibleState);
    return state;
  };

  const followAi = async (): Promise<InteractionState> => {
    const state = interaction.acceptFollow();
    if (state.followTarget !== undefined) {
      await revealFollowTarget(state.followTarget);
    }
    return render(state);
  };
  const refuseFollow = (): InteractionState => {
    return render(interaction.refuseFollow());
  };
  const askPair = vscode.commands.registerCommand(
    'codealongai.askPair',
    (): InteractionState | undefined => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined) {
        void vscode.window.showWarningMessage('Open the suspicious code before asking CodeAlongAI.');
        return undefined;
      }
      const state = interaction.start(documentRange(editor));
      return render(state);
    }
  );
  const advanceReplay = vscode.commands.registerCommand(
    'codealongai.replay.advance',
    async (): Promise<InteractionState> => {
      const state = interaction.advance();
      render(state);
      if (state.follow === 'awaiting-consent') {
        void vscode.window.showInformationMessage(
          'CodeAlongAI found a related code range. Follow AI?',
          'Follow AI',
          'Stay here'
        ).then((response) => {
          if (response === 'Follow AI') {
            return followAi();
          }
          if (response === 'Stay here') {
            return refuseFollow();
          }
          return undefined;
        });
      }
      return state;
    }
  );
  const breakAway = (): InteractionState => {
    return render(interaction.breakAway());
  };
  const resetReplay = (): InteractionState => {
    return render(interaction.reset());
  };

  context.subscriptions.push(
    askPair,
    advanceReplay,
    vscode.commands.registerCommand('codealongai.follow.accept', followAi),
    vscode.commands.registerCommand('codealongai.follow.refuse', refuseFollow),
    vscode.commands.registerCommand('codealongai.follow.breakAway', breakAway),
    vscode.commands.registerCommand('codealongai.replay.reset', resetReplay),
    vscode.window.onDidChangeVisibleTextEditors(() => applyCues(visibleState)),
    aiPointerStyle,
    explanationStyle
  );
}

export function deactivate(): void {}
