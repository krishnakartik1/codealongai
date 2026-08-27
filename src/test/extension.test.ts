import assert from 'node:assert/strict';
import * as vscode from 'vscode';

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
    assert.deepEqual(
      await vscode.commands.executeCommand('codealongai.askPair'),
      {
        humanSelection: {
          document: 'checkout.ts',
          range: {
            start: { line: 4, character: 31 },
            end: { line: 4, character: 39 }
          }
        },
        aiAttention: {
          name: 'CodeAlongAI',
          target: {
            document: 'checkout.ts',
            range: {
              start: { line: 4, character: 31 },
              end: { line: 4, character: 39 }
            }
          }
        },
        explanations: [],
        follow: 'not-following'
      }
    );
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
});
