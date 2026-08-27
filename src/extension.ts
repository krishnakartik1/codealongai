import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  InteractionController,
  type InteractionState,
  type StagedProposal
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

async function captureKnownProposal(
  target: DocumentRange
): Promise<{ baseDocumentVersion: number; stagedContents: string }> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  const isKnownTarget = target.document === 'pricing.ts' &&
    target.range.start.line === 1 &&
    target.range.start.character === 47 &&
    target.range.end.line === 1 &&
    target.range.end.character === 48;
  if (workspace === undefined || !isKnownTarget) {
    throw new Error('The known proposal target is unavailable.');
  }
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(workspace.uri, target.document)
  );
  const source = document.getText();
  const lines = source.split('\n');
  const knownLine = lines[1];
  if (knownLine?.slice(47, 48) !== '-') {
    throw new Error('The known one-character proposal no longer matches the fixture.');
  }
  lines[1] = knownLine.slice(0, 47) + '+' + knownLine.slice(48);
  const stagedContents = lines.join('\n');

  return { baseDocumentVersion: document.version, stagedContents };
}

async function openProposalDiff(proposal: StagedProposal): Promise<vscode.Tab | undefined> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (workspace === undefined) {
    return undefined;
  }
  const target = vscode.Uri.joinPath(workspace.uri, proposal.target.document);
  const staged = await vscode.workspace.openTextDocument({
    content: proposal.stagedContents,
    language: 'typescript'
  });
  await vscode.commands.executeCommand(
    'vscode.diff',
    target,
    staged.uri,
    `CodeAlongAI proposal: ${proposal.target.document} (version ${proposal.baseDocumentVersion})`
  );
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return tab?.input instanceof vscode.TabInputTextDiff ? tab : undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const interaction = new InteractionController(deterministicReplayFixture.events);
  let followPromptIsOpen = false;
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
  let stagedProposalTab: vscode.Tab | undefined;

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
  const requestFollowConsent = (): void => {
    if (followPromptIsOpen) {
      return;
    }
    followPromptIsOpen = true;
    void Promise.resolve(vscode.window.showInformationMessage(
      'CodeAlongAI found a related code range. Follow AI?',
      'Follow AI',
      'Stay here'
    )).then((response) => {
      if (response === 'Follow AI') {
        return followAi();
      }
      if (response === 'Stay here') {
        return refuseFollow();
      }
      return undefined;
    }).finally(() => {
      followPromptIsOpen = false;
    });
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
      let state = interaction.advance();
      render(state);
      if (state.follow === 'awaiting-consent') {
        requestFollowConsent();
      }
      if (state.proposalCaptureTarget !== undefined) {
        const capture = await captureKnownProposal(state.proposalCaptureTarget);
        state = interaction.stageProposal({ target: state.proposalCaptureTarget, ...capture });
        render(state);
        if (state.proposal !== undefined) {
          stagedProposalTab = await openProposalDiff(state.proposal);
          void vscode.window.showInformationMessage(
            'CodeAlongAI staged the known proposal for review.',
            'Request acceptance',
            'Reject proposal'
          ).then((response) => {
            if (response === 'Request acceptance') {
              return requestProposalAcceptance();
            }
            if (response === 'Reject proposal') {
              return rejectProposal();
            }
            return undefined;
          });
        }
      }
      return state;
    }
  );
  const breakAway = (): InteractionState => {
    return render(interaction.breakAway());
  };
  const resetReplay = async (): Promise<InteractionState> => {
    if (stagedProposalTab !== undefined) {
      await vscode.window.tabGroups.close(stagedProposalTab, true);
      stagedProposalTab = undefined;
    }
    const state = interaction.reset();
    return render(state);
  };
  const rejectProposal = async (): Promise<InteractionState> => {
    if (stagedProposalTab !== undefined) {
      await vscode.window.tabGroups.close(stagedProposalTab, true);
      stagedProposalTab = undefined;
    }
    const state = interaction.rejectProposal();
    return render(state);
  };
  const requestProposalAcceptance = (): InteractionState => {
    const state = interaction.requestProposalAcceptance();
    render(state);
    if (state.mutationRequest !== undefined) {
      void vscode.window.showInformationMessage(
        'Acceptance request recorded. The extension authority gate must recheck the document version before any change.'
      );
    }
    return state;
  };

  context.subscriptions.push(
    askPair,
    advanceReplay,
    vscode.commands.registerCommand('codealongai.follow.accept', followAi),
    vscode.commands.registerCommand('codealongai.follow.refuse', refuseFollow),
    vscode.commands.registerCommand('codealongai.follow.breakAway', breakAway),
    vscode.commands.registerCommand('codealongai.replay.reset', resetReplay),
    vscode.window.onDidChangeVisibleTextEditors(() => applyCues(visibleState)),
    vscode.commands.registerCommand('codealongai.proposal.reject', rejectProposal),
    vscode.commands.registerCommand('codealongai.proposal.requestAcceptance', requestProposalAcceptance),
    aiPointerStyle,
    explanationStyle
  );
}

export function deactivate(): void {}
