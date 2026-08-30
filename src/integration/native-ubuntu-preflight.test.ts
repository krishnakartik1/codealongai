import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeUbuntuPreflight, safeNativeEvidence, validTurnCallSequence } from '../acceptance/native-ubuntu-preflight';
import { untilTeardown } from '../producer-turn';

const ready = { enabled: true, ubuntuX64: true, nodeVersion: 'v22.14.0', buildCommit: '1'.repeat(40), trueforgeVersion: '0.1.4', sdkVersion: '0.1.3', mcpServerVersion: '2.0.0', dataPath: '/operator/trueforge', model: 'openai/example', reasoningEffort: 'medium', reply: 'operator input' };
test('native acceptance preflight distinguishes skips, external blocks, and ready execution', () => {
  assert.deepEqual(nativeUbuntuPreflight({ ...ready, enabled: false }), { status: 'skip', reason: 'opt-in' });
  assert.deepEqual(nativeUbuntuPreflight({ ...ready, nodeVersion: 'v23.0.0' }), { status: 'blocked', reason: 'node' });
  assert.deepEqual(nativeUbuntuPreflight({ ...ready, dataPath: 'relative' }), { status: 'blocked', reason: 'configuration' });
  assert.deepEqual(nativeUbuntuPreflight(ready), { status: 'ready' });
});
test('native evidence retains only the public redacted vocabulary', () => {
  assert.deepEqual(safeNativeEvidence({ result: 'PASS', phases: ['ready', 'secret'], calls: ['codealongai_get_walkthrough_request', 'payload'], receiptMatched: true, terminalDone: true, cleanup: ['owned-sidecar', '/private/path'] }), { result: 'PASS', versions: { trueforge: '0.1.4', sdk: '0.1.3', mcp: '2.0.0' }, phases: ['ready'], calls: ['codealongai_get_walkthrough_request'], receiptMatched: true, terminalDone: true, cleanup: ['owned-sidecar'] });
});
test('cleanup observation distinguishes fulfilled deletion from rejection and timeout', async () => {
  const rejected = await untilTeardown(Promise.reject(new Error('provider cleanup rejected')), new AbortController().signal);
  assert.equal(rejected, 'rejected');
  const controller = new AbortController(); const pending = untilTeardown(new Promise<void>(() => undefined), controller.signal); controller.abort();
  assert.equal(await pending, 'aborted');
  assert.equal(await untilTeardown(Promise.resolve(), new AbortController().signal), 'fulfilled');
});
test('turn observation policy requires authority first and one final transition', () => {
  assert.equal(validTurnCallSequence('ask', ['codealongai_get_walkthrough_request', 'codealongai_read_workspace_file', 'codealongai_start_walkthrough'], false), true);
  assert.equal(validTurnCallSequence('reply', ['codealongai_get_walkthrough_request', 'codealongai_get_walkthrough', 'codealongai_read_workspace_file', 'codealongai_commit_question_outcome'], false), true);
  assert.equal(validTurnCallSequence('ask', ['codealongai_read_workspace_file', 'codealongai_start_walkthrough'], false), false);
  assert.equal(validTurnCallSequence('reply', ['codealongai_get_walkthrough_request', 'codealongai_get_walkthrough', 'codealongai_commit_question_outcome', 'codealongai_search_workspace'], false), false);
});
