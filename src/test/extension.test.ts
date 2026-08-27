import assert from 'node:assert/strict';
import * as vscode from 'vscode';

async function stageKnownProposal(): Promise<{
  proposal: {
    target: { document: string };
    baseDocumentVersion: number;
    baseContents: string;
    replacement: string;
    stagedContents: string;
    review: string;
  };
}> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspace, 'the demo workspace should be open');
  const checkout = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(workspace.uri, 'checkout.ts')
  );
  const editor = await vscode.window.showTextDocument(checkout);
  editor.selection = new vscode.Selection(4, 31, 4, 39);

  await vscode.commands.executeCommand('codealongai.askPair');
  await vscode.commands.executeCommand('codealongai.replay.advance');
  await vscode.commands.executeCommand('codealongai.replay.advance');
  await vscode.commands.executeCommand('codealongai.follow.accept');
  return await vscode.commands.executeCommand('codealongai.replay.advance') as {
    proposal: {
      target: { document: string };
      baseDocumentVersion: number;
      baseContents: string;
      replacement: string;
      stagedContents: string;
      review: string;
    };
  };
}

suite('CodeAlongAI extension', () => {
  test('opens the demo workspace', () => {
    assert.deepEqual(
      vscode.workspace.workspaceFolders?.map((folder) => folder.name),
      ['demo-workspace']
    );
  });

  test('activates when Ask pair executes', async () => {
    const extension = vscode.extensions.getExtension('krishnakartik1.codealongai');
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace, 'the demo workspace should be open');
    const checkout = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(workspace.uri, 'checkout.ts')
    );
    const editor = await vscode.window.showTextDocument(checkout);
    editor.selection = new vscode.Selection(4, 31, 4, 39);

    assert.ok(extension, 'CodeAlongAI extension should be installed in the test host');
    assert.equal(extension.isActive, false, 'CodeAlongAI should start inactive');
    const started = await vscode.commands.executeCommand('codealongai.askPair') as {
      humanSelection: { document: string };
      aiAttention: { name: string; target: { document: string } };
      explanations: readonly unknown[];
      follow: string;
    };
    assert.equal(started.humanSelection.document, 'checkout.ts');
    assert.equal(started.aiAttention.name, 'CodeAlongAI');
    assert.equal(started.aiAttention.target.document, 'checkout.ts');
    assert.deepEqual(started.explanations, []);
    assert.equal(started.follow, 'not-following');
    assert.equal(extension.isActive, true, 'Ask pair should activate CodeAlongAI');
  });

  test('reveals the target only after Follow AI consent and preserves the checkout selection', async () => {
    const checkoutEditor = vscode.window.activeTextEditor;
    assert.ok(checkoutEditor, 'Ask pair should leave checkout open');
    const selection = checkoutEditor.selection;

    await vscode.commands.executeCommand('codealongai.replay.advance');
    const awaitingConsent = await vscode.commands.executeCommand('codealongai.replay.advance');
    const pendingFollow = awaitingConsent as {
      follow: string;
      aiAttention: { target: { document: string } };
      explanations: readonly unknown[];
    };
    assert.equal(pendingFollow.follow, 'awaiting-consent');
    assert.equal(pendingFollow.aiAttention.target.document, 'pricing.ts');
    assert.deepEqual(pendingFollow.explanations, []);
    assert.equal(vscode.window.activeTextEditor?.document.fileName.endsWith('checkout.ts'), true);

    const following = await vscode.commands.executeCommand('codealongai.follow.accept');
    assert.equal((following as { follow: string }).follow, 'following');
    assert.equal(vscode.window.activeTextEditor?.document.fileName.endsWith('pricing.ts'), true);
    assert.equal(checkoutEditor.selection.isEqual(selection), true);

    const reset = await vscode.commands.executeCommand('codealongai.replay.reset');
    const resetState = reset as {
      humanSelection: undefined;
      aiAttention: undefined;
      explanations: readonly unknown[];
      follow: string;
      followTarget: undefined;
    };
    assert.equal(resetState.humanSelection, undefined);
    assert.equal(resetState.aiAttention, undefined);
    assert.deepEqual(resetState.explanations, []);
    assert.equal(resetState.follow, 'not-following');
    assert.equal(resetState.followTarget, undefined);
  });

  test('does not restore followed cues when reset wins during navigation', async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace, 'the demo workspace should be open');
    const checkout = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(workspace.uri, 'checkout.ts')
    );
    const editor = await vscode.window.showTextDocument(checkout);
    editor.selection = new vscode.Selection(4, 31, 4, 39);

    await vscode.commands.executeCommand('codealongai.askPair');
    await vscode.commands.executeCommand('codealongai.replay.advance');
    await vscode.commands.executeCommand('codealongai.replay.advance');
    const pendingFollow = vscode.commands.executeCommand('codealongai.follow.accept');
    const reset = await vscode.commands.executeCommand('codealongai.replay.reset') as {
      aiAttention: undefined;
      explanations: readonly unknown[];
      follow: string;
    };
    const completedFollow = await pendingFollow as {
      aiAttention: undefined;
      explanations: readonly unknown[];
      follow: string;
    };

    assert.equal(reset.follow, 'not-following');
    assert.equal(completedFollow.follow, 'not-following');
    assert.equal(completedFollow.aiAttention, undefined);
    assert.deepEqual(completedFollow.explanations, []);
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), checkout.uri.toString());
  });

  test('does not cancel accepted navigation when an ordinary follow command renders', async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace, 'the demo workspace should be open');
    const checkout = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(workspace.uri, 'checkout.ts')
    );
    const editor = await vscode.window.showTextDocument(checkout);
    editor.selection = new vscode.Selection(4, 31, 4, 39);

    await vscode.commands.executeCommand('codealongai.askPair');
    await vscode.commands.executeCommand('codealongai.replay.advance');
    await vscode.commands.executeCommand('codealongai.replay.advance');
    const pendingFollow = vscode.commands.executeCommand('codealongai.follow.accept');
    await vscode.commands.executeCommand('codealongai.follow.refuse');
    const completedFollow = await pendingFollow as { follow: string };

    assert.equal(completedFollow.follow, 'following');
    assert.equal(vscode.window.activeTextEditor?.document.fileName.endsWith('pricing.ts'), true);
    await vscode.commands.executeCommand('codealongai.replay.reset');
  });

  test('stages the known proposal in a separate document without changing the fixture', async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace, 'the demo workspace should be open');
    const pricingUri = vscode.Uri.joinPath(workspace.uri, 'pricing.ts');
    const pricing = await vscode.workspace.openTextDocument(pricingUri);
    const originalContents = pricing.getText();
    const staged = await stageKnownProposal();

    assert.equal(staged.proposal.target.document, 'pricing.ts');
    assert.equal(staged.proposal.baseDocumentVersion, pricing.version);
    assert.equal(staged.proposal.baseContents, originalContents);
    assert.equal(staged.proposal.replacement, '+');
    assert.equal(staged.proposal.stagedContents.includes('total + price'), true);
    assert.equal(staged.proposal.review, 'ready');
    assert.equal(pricing.getText(), originalContents);

    const rejected = await vscode.commands.executeCommand('codealongai.proposal.reject') as {
      proposal: undefined;
      mutationRequest: undefined;
    };
    assert.equal(rejected.proposal, undefined);
    assert.equal(rejected.mutationRequest, undefined);
  });

  test('cancels a staged proposal through the public command before closing its review', async () => {
    await stageKnownProposal();

    const cancelled = await vscode.commands.executeCommand(
      'codealongai.proposal.cancel'
    ) as { proposal: undefined; mutationRequest: undefined };

    assert.equal(cancelled.proposal, undefined);
    assert.equal(cancelled.mutationRequest, undefined);
  });

  test('applies only the staged target when the live document still matches', async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace, 'the demo workspace should be open');
    const pricingUri = vscode.Uri.joinPath(workspace.uri, 'pricing.ts');
    const originalContents = (await vscode.workspace.openTextDocument(pricingUri)).getText();
    const staged = await stageKnownProposal();

    const documentChanges: vscode.TextDocumentChangeEvent[] = [];
    const subscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() === pricingUri.toString()) {
        documentChanges.push(event);
      }
    });
    const accepted = await vscode.commands.executeCommand(
      'codealongai.proposal.requestAcceptance'
    ) as { proposal: undefined; mutationRequest: undefined };
    await new Promise((resolve) => setTimeout(resolve, 0));
    subscription.dispose();

    assert.equal(accepted.proposal, undefined);
    assert.equal(accepted.mutationRequest, undefined);
    assert.equal(documentChanges.length > 0, true);
    assert.equal(documentChanges.some((event) => event.contentChanges.some((change) =>
      change.range.start.line === 1 &&
      change.range.start.character === 47 &&
      change.range.end.line === 1 &&
      change.range.end.character === 48 &&
      change.rangeLength === 1 &&
      change.text === staged.proposal.replacement
    )), true);
    const restoredDocument = await vscode.workspace.openTextDocument(pricingUri);
    const restoredEditor = await vscode.window.showTextDocument(restoredDocument);
    assert.equal(await restoredEditor.edit((edit) => edit.replace(
      new vscode.Range(new vscode.Position(1, 47), new vscode.Position(1, 48)),
      '-'
    )), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test('refuses an intervening human edit without overwriting it', async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace, 'the demo workspace should be open');
    const pricingUri = vscode.Uri.joinPath(workspace.uri, 'pricing.ts');
    const originalContents = (await vscode.workspace.openTextDocument(pricingUri)).getText();
    await stageKnownProposal();
    const humanEdit = `${originalContents}\n// human edit`;
    const editor = vscode.window.visibleTextEditors.find(
      (visibleEditor) => visibleEditor.document.uri.toString() === pricingUri.toString()
    );
    assert.ok(editor, 'the proposal diff should expose the live pricing document');
    const editedDocument = editor.document;
    assert.equal(await editor.edit((edit) => edit.replace(
      new vscode.Range(editedDocument.positionAt(0), editedDocument.positionAt(editedDocument.getText().length)),
      humanEdit
    )), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(editor.document.getText(), humanEdit);

    const documentChanges: vscode.TextDocumentChangeEvent[] = [];
    const subscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() === pricingUri.toString()) {
        documentChanges.push(event);
      }
    });
    const refused = await vscode.commands.executeCommand(
      'codealongai.proposal.requestAcceptance'
    ) as {
      proposal: { review: string };
      mutationRequest: undefined;
      proposalAcceptance: { message: string };
    };
    subscription.dispose();

    assert.equal(refused.proposal.review, 'stale');
    assert.equal(refused.mutationRequest, undefined);
    assert.equal(refused.proposalAcceptance.message, 'The proposal is stale. Replay or restage it before accepting.');
    assert.equal(documentChanges.length, 0);
    await editor.edit((edit) => edit.replace(
      new vscode.Range(editedDocument.positionAt(0), editedDocument.positionAt(editedDocument.getText().length)),
      originalContents
    ));
  });

  test('cancels a proposal when its review diff is closed manually', async () => {
    await stageKnownProposal();

    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab, 'staging should open a proposal diff tab');
    await vscode.window.tabGroups.close(tab, true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const acceptance = await vscode.commands.executeCommand(
      'codealongai.proposal.requestAcceptance'
    ) as { proposal: undefined; mutationRequest: undefined };
    assert.equal(acceptance.proposal, undefined);
    assert.equal(acceptance.mutationRequest, undefined);
  });
});
