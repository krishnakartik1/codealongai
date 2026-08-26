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

    assert.ok(extension, 'CodeAlongAI extension should be installed in the test host');
    assert.equal(extension.isActive, false, 'CodeAlongAI should start inactive');
    assert.deepEqual(
      await vscode.commands.executeCommand('codealongai.askPair'),
      {
        status: 'started',
        event: {
          kind: 'point',
          target: {
            document: 'checkout.ts',
            range: {
              start: { line: 4, character: 31 },
              end: { line: 4, character: 39 }
            }
          }
        }
      }
    );
    assert.equal(extension.isActive, true, 'Ask pair should activate CodeAlongAI');
  });
});
