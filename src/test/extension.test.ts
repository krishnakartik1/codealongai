import assert from 'node:assert/strict';
import * as vscode from 'vscode';

suite('CodeAlongAI extension', () => {
  test('activates and executes Ask pair', async () => {
    const extension = vscode.extensions.getExtension('krishnakartik1.codealongai');

    assert.ok(extension, 'CodeAlongAI extension should be installed in the test host');

    await extension.activate();

    assert.equal(extension.isActive, true);
    assert.ok(
      (await vscode.commands.getCommands(true)).includes('codealongai.askPair'),
      'Ask pair should be registered'
    );
    assert.deepEqual(
      await vscode.commands.executeCommand('codealongai.askPair'),
      { status: 'ready' }
    );
  });
});
