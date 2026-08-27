import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  InteractionController,
  type InteractionState,
  type ProposalAcceptanceEffect,
  type ProposalCapture,
  type StagedProposal
} from './interaction';
import { ProposalAcceptanceAuthority, type LiveProposalDocument } from './proposalAcceptance';
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

async function revealFollowTarget(
  target: DocumentRange,
  isCurrent: () => boolean,
  currentInteractionEditor: () => vscode.TextEditor | undefined
): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (workspace === undefined) {
    return;
  }
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(workspace.uri, target.document)
  );
  if (!isCurrent()) {
    return;
  }
  const editor = await vscode.window.showTextDocument(document);
  if (!isCurrent()) {
    const currentEditor = currentInteractionEditor();
    if (currentEditor !== undefined && currentEditor.document.uri.toString() !== editor.document.uri.toString()) {
      await vscode.window.showTextDocument(currentEditor.document, currentEditor.viewColumn);
    }
    return;
  }
  editor.revealRange(toRange(target), vscode.TextEditorRevealType.InCenter);
}

async function captureKnownProposal(
  target: DocumentRange
): Promise<{ baseDocumentVersion: number; baseContents: string; replacement: string; stagedContents: string }> {
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

  return { baseDocumentVersion: document.version, baseContents: source, replacement: '+', stagedContents };
}

async function openProposalDiff(
  proposal: StagedProposal,
  staged: vscode.Uri
): Promise<vscode.Tab | undefined> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (workspace === undefined) {
    return undefined;
  }
  const target = vscode.Uri.joinPath(workspace.uri, proposal.target.document);
  await vscode.commands.executeCommand(
    'vscode.diff',
    target,
    staged,
    `CodeAlongAI proposal: ${proposal.target.document} (version ${proposal.baseDocumentVersion})`
  );
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return tab?.input instanceof vscode.TabInputTextDiff ? tab : undefined;
}

function isTabOpen(tab: vscode.Tab): boolean {
  return vscode.window.tabGroups.all.some((group) => group.tabs.includes(tab));
}

function liveProposalDocuments(): LiveProposalDocument {
  return { async applyIfVersionMatches(proposal: ProposalCapture, isAcceptanceCurrent, beginApplication) {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace || proposal.target.document !== 'pricing.ts' || !isAcceptanceCurrent()) return { outcome: 'cancelled' };
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspace.uri, proposal.target.document));
    if (!isAcceptanceCurrent()) return { outcome: 'cancelled' };
    const editor = vscode.window.visibleTextEditors.find(
      (visibleEditor) => visibleEditor.document.uri.toString() === document.uri.toString()
    ) ?? await vscode.window.showTextDocument(document);
    if (!isAcceptanceCurrent()) return { outcome: 'cancelled' };
    if (document.version !== proposal.baseDocumentVersion || document.getText() !== proposal.baseContents) return { outcome: 'stale' };
    const targetRange = toRange(proposal.target);
    if (!beginApplication()) return { outcome: 'cancelled' };
    return await editor.edit((edit) => edit.replace(targetRange, proposal.replacement))
      ? { outcome: 'applied' } : { outcome: 'stale' };
  } };
}

export function activate(context: vscode.ExtensionContext): void {
  const interaction = new InteractionController(deterministicReplayFixture.events);
  const proposalAuthority = new ProposalAcceptanceAuthority(liveProposalDocuments());
  let followPromptIsOpen = false;
  let visibleState: InteractionState = {
    humanSelection: undefined,
    aiAttention: undefined,
    explanations: [],
    follow: 'not-following',
    followTarget: undefined,
    proposalCaptureTarget: undefined,
    proposal: undefined,
    mutationRequest: undefined,
    proposalAcceptance: { message: undefined, closeReview: false }
  };
  let followNavigationGeneration = 0;
  let interactionEditor: { generation: number; editor: vscode.TextEditor } | undefined;
  const supersedeInteraction = (): void => {
    followNavigationGeneration += 1;
    const editor = vscode.window.activeTextEditor;
    interactionEditor = editor === undefined
      ? undefined
      : { generation: followNavigationGeneration, editor };
  };
  const render = (state: InteractionState): InteractionState => {
    visibleState = state;
    applyCues(visibleState);
    return state;
  };
  const announceProposalAcceptance = (effect: ProposalAcceptanceEffect): void => {
    if (effect.message !== undefined) {
      void vscode.window.showWarningMessage(effect.message);
    }
  };
  let stagedProposalTab: vscode.Tab | undefined;
  let stagedProposalUri: vscode.Uri | undefined;
  const stagedProposalContents = new Map<string, string>();
  let proposalGeneration = 0;
  let proposalStagingInProgress = false;
  let proposalInvalidation: Promise<boolean> | undefined;

  const proposalContentProvider = vscode.workspace.registerTextDocumentContentProvider(
    'codealongai-proposal',
    { provideTextDocumentContent: (uri) => stagedProposalContents.get(uri.toString()) }
  );
  const showProposalReviewActions = (generation: number): void => {
    void vscode.window.showInformationMessage(
      'CodeAlongAI staged the known proposal for review.',
      'Request acceptance',
      'Reject proposal', 'Cancel proposal'
    ).then((response) => {
      if (generation !== proposalGeneration) return undefined;
      if (response === 'Request acceptance') {
        return requestProposalAcceptance();
      }
      if (response === 'Reject proposal') {
        return rejectProposal();
      }
      if (response === 'Cancel proposal') return cancelProposal();
      return undefined;
    });
  };

  const closeStagedProposalTab = async (): Promise<boolean> => {
    if (stagedProposalTab !== undefined) {
      const tab = stagedProposalTab;
      stagedProposalTab = undefined;
      if (!isTabOpen(tab)) {
        discardProposalContents();
        return true;
      }
      const closed = await vscode.window.tabGroups.close(tab, true);
      if (!closed) {
        if (isTabOpen(tab)) {
          stagedProposalTab = tab;
          return false;
        }
        await cancelClosedProposalReview();
        return true;
      }
    }
    if (stagedProposalUri !== undefined) {
      stagedProposalContents.delete(stagedProposalUri.toString());
      stagedProposalUri = undefined;
    }
    return true;
  };
  const invalidateProposalReview = async (): Promise<boolean> => {
    await proposalAuthority.cancelAcceptance();
    if (proposalInvalidation !== undefined) {
      return proposalInvalidation;
    }
    const pendingInvalidation = (async (): Promise<boolean> => {
      const invalidationGeneration = proposalGeneration + 1;
      proposalGeneration = invalidationGeneration;
      const closed = await closeStagedProposalTab();
      if (!closed && proposalGeneration === invalidationGeneration) {
        proposalGeneration -= 1;
        showProposalReviewActions(proposalGeneration);
      }
      return closed;
    })();
    proposalInvalidation = pendingInvalidation;
    try {
      return await pendingInvalidation;
    } finally {
      proposalInvalidation = undefined;
    }
  };
  const discardProposalContents = (): void => {
    if (stagedProposalUri !== undefined) {
      stagedProposalContents.delete(stagedProposalUri.toString());
      stagedProposalUri = undefined;
    }
    stagedProposalTab = undefined;
  };
  const cancelClosedProposalReview = async (): Promise<void> => {
    await proposalAuthority.cancelAcceptance();
    proposalGeneration += 1;
    discardProposalContents();
    render(interaction.rejectProposal());
  };

  const followAi = async (): Promise<InteractionState> => {
    const shouldNavigate = visibleState.follow === 'awaiting-consent';
    const state = render(interaction.acceptFollow());
    if (!shouldNavigate || state.followTarget === undefined) {
      return state;
    }
    followNavigationGeneration += 1;
    const acceptedGeneration = followNavigationGeneration;
    await revealFollowTarget(
      state.followTarget,
      () => acceptedGeneration === followNavigationGeneration,
      () => interactionEditor?.generation === followNavigationGeneration
        ? interactionEditor.editor
        : undefined
    );
    return acceptedGeneration === followNavigationGeneration ? state : visibleState;
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
    async (): Promise<InteractionState | undefined> => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined) {
        void vscode.window.showWarningMessage('Open the suspicious code before asking CodeAlongAI.');
        return undefined;
      }
      supersedeInteraction();
      if (!await invalidateProposalReview()) {
        return visibleState;
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
      if (state.proposalCaptureTarget !== undefined && !proposalStagingInProgress) {
        proposalStagingInProgress = true;
        const target = state.proposalCaptureTarget;
        const generation = proposalGeneration;
        try {
          let capture: { baseDocumentVersion: number; baseContents: string; replacement: string; stagedContents: string };
          try {
            capture = await captureKnownProposal(target);
          } catch (error) {
            if (generation === proposalGeneration) {
              state = render(interaction.rejectProposal());
              void vscode.window.showWarningMessage(`CodeAlongAI could not stage the proposal: ${String(error)}`);
            }
            return state;
          }

          if (generation !== proposalGeneration) {
            return visibleState;
          }

          state = interaction.stageProposal({ target, ...capture });
          render(state);
          if (state.proposal !== undefined) {
            const stagedUri = vscode.Uri.parse(
              `codealongai-proposal:/${target.document}?generation=${generation}`
            );
            stagedProposalContents.set(stagedUri.toString(), state.proposal.stagedContents);
            let tab: vscode.Tab | undefined;
            try { tab = await openProposalDiff(state.proposal, stagedUri); } catch (error) {
              stagedProposalContents.delete(stagedUri.toString());
              if (generation === proposalGeneration) state = render(interaction.rejectProposal());
              void vscode.window.showWarningMessage(`CodeAlongAI could not open the proposal review: ${String(error)}`);
              return state;
            }
            if (generation !== proposalGeneration) {
              if (tab !== undefined) await vscode.window.tabGroups.close(tab, true);
              stagedProposalContents.delete(stagedUri.toString());
              return state;
            }
            stagedProposalTab = tab;
            stagedProposalUri = stagedUri;
            showProposalReviewActions(generation);
          }
        } finally {
          proposalStagingInProgress = false;
        }
      }
      return state;
    }
  );
  const breakAway = async (): Promise<InteractionState> => {
    supersedeInteraction();
    if (!await invalidateProposalReview()) {
      return visibleState;
    }
    return render(interaction.breakAway());
  };
  const resetReplay = async (): Promise<InteractionState> => {
    supersedeInteraction();
    if (!await invalidateProposalReview()) {
      return visibleState;
    }
    const state = interaction.reset();
    return render(state);
  };
  const dismissProposal = async (): Promise<InteractionState> => {
    const state = render(interaction.rejectProposal());
    const cancellation = proposalAuthority.cancelAcceptance();
    proposalGeneration += 1;
    await cancellation;
    await closeStagedProposalTab();
    return state;
  };
  const rejectProposal = dismissProposal;
  const cancelProposal = dismissProposal;
  const requestProposalAcceptance = async (): Promise<InteractionState> => {
    let state = interaction.requestProposalAcceptance();
    render(state);
    if (state.mutationRequest !== undefined) {
      const request = state.mutationRequest;
      if (proposalAuthority.beginAcceptance(request)) {
        const acceptanceResult = await proposalAuthority.accept(request);
        const completion = interaction.completeProposalAcceptance(request, acceptanceResult);
        state = render(completion.state);
        announceProposalAcceptance(completion.effect);
        if (completion.effect.closeReview) await closeStagedProposalTab();
      } else {
        const completion = interaction.releaseProposalAcceptance(request);
        state = render(completion.state);
        announceProposalAcceptance(completion.effect);
      }
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
    vscode.window.tabGroups.onDidChangeTabs(() => {
      if (stagedProposalTab !== undefined && !isTabOpen(stagedProposalTab)) {
        void cancelClosedProposalReview();
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => applyCues(visibleState)),
    vscode.commands.registerCommand('codealongai.proposal.reject', rejectProposal),
    vscode.commands.registerCommand('codealongai.proposal.cancel', cancelProposal),
    vscode.commands.registerCommand('codealongai.proposal.requestAcceptance', requestProposalAcceptance),
    proposalContentProvider,
    aiPointerStyle,
    explanationStyle
  );
}

export function deactivate(): void {}
