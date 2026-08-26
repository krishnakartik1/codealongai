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

  test('retains replay state across replay commands and restarts deterministically', async () => {
    const firstEvent = {
      kind: 'point',
      target: {
        document: 'checkout.ts',
        range: {
          start: { line: 4, character: 31 },
          end: { line: 4, character: 39 }
        }
      }
    };
    const secondEvent = {
      kind: 'walkthrough',
      message: 'Follow checkout through its subtotal import.',
      target: {
        document: 'checkout.ts',
        range: {
          start: { line: 0, character: 9 },
          end: { line: 0, character: 17 }
        }
      }
    };

    assert.deepEqual(await vscode.commands.executeCommand('codealongai.askPair'), {
      status: 'started',
      event: firstEvent
    });
    assert.deepEqual(
      await vscode.commands.executeCommand('codealongai.replay.advance'),
      secondEvent
    );

    await vscode.commands.executeCommand('codealongai.replay.cancel');
    assert.equal(
      await vscode.commands.executeCommand('codealongai.replay.advance'),
      undefined
    );

    await vscode.commands.executeCommand('codealongai.replay.reset');
    assert.equal(
      await vscode.commands.executeCommand('codealongai.replay.advance'),
      undefined
    );

    assert.deepEqual(await vscode.commands.executeCommand('codealongai.askPair'), {
      status: 'started',
      event: firstEvent
    });
    assert.deepEqual(
      await vscode.commands.executeCommand('codealongai.replay.advance'),
      secondEvent
    );
  });
});
