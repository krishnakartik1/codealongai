import assert from 'node:assert/strict';
import test from 'node:test';
import { localSandboxRuntimeDirectoryCount, nativeUbuntuPreflight, safeNativeEvidence, validNativeReadinessFacts, validTurnCallSequence } from '../acceptance/native-ubuntu-preflight';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { untilTeardown } from '../producer-turn';
import { trueForgeCapabilitySummary } from '../trueforge-native';
import { terminateOwnedSidecar } from '../trueforge-native';
import { TrueForgeSidecar } from '../trueforge';
import { emptyTrueForgeProducer } from '../test/trueforge-runtime-double';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ready = { enabled: true, ubuntuX64: true, nodeVersion: 'v22.14.0', buildCommit: '1'.repeat(40), trueforgeVersion: '0.1.4', sdkVersion: '0.1.3', mcpServerVersion: '2.0.0', dataPath: '/operator/trueforge', model: 'openai/example', reasoningEffort: 'medium', reply: 'operator input' };
test('native acceptance preflight distinguishes skips, external blocks, and ready execution', () => {
  assert.deepEqual(nativeUbuntuPreflight({ ...ready, enabled: false }), { status: 'skip', reason: 'opt-in' });
  assert.deepEqual(nativeUbuntuPreflight({ ...ready, nodeVersion: 'v22.13.9' }), { status: 'blocked', reason: 'node' });
  assert.deepEqual(nativeUbuntuPreflight({ ...ready, nodeVersion: 'v23.0.0' }), { status: 'blocked', reason: 'node' });
  assert.deepEqual(nativeUbuntuPreflight({ ...ready, dataPath: 'relative' }), { status: 'blocked', reason: 'configuration' });
  assert.deepEqual(nativeUbuntuPreflight(ready), { status: 'ready' });
});
test('native evidence retains only the public redacted vocabulary', () => {
  assert.deepEqual(safeNativeEvidence({ result: 'PASS', runtime: { platform: 'ubuntu', architecture: 'x64', nodeVersion: 'v22.14.0', model: 'openai/gpt-5.2', reasoningEffort: 'medium' }, versions: { trueforge: '0.1.4', sdk: '0.1.3', mcp: '2.0.0' }, phases: ['ready', 'secret'], calls: ['codealongai_get_walkthrough_request', 'payload'], receiptMatched: true, terminalDone: true, cleanup: ['owned-sidecar', '/private/path'] }), { result: 'PASS', runtime: { platform: 'ubuntu', architecture: 'x64', nodeVersion: '22.14.0', model: 'openai/gpt-5.2', reasoningEffort: 'medium' }, versions: { trueforge: '0.1.4', sdk: '0.1.3', mcp: '2.0.0' }, phases: ['ready'], calls: ['codealongai_get_walkthrough_request'], receiptMatched: true, terminalDone: true, cleanup: ['owned-sidecar'] });
});
test('native evidence drops unverified policy and readiness values', () => {
  assert.deepEqual(safeNativeEvidence({ result: 'PASS', runtime: { platform: 'host', architecture: 'arm64', nodeVersion: 'private', model: 'secret', reasoningEffort: 'reasoning content' }, versions: { trueforge: 'x', sdk: 'x', mcp: 'x' }, phases: ['provider', 'snapshots', 'sandboxes', 'ready'], calls: [], policies: ['question', 'prompt'], readiness: { provider: 'daytona', skillCommit: 'not-a-commit', connectorDiscovered: true, mcpDiscovered: true, ownedSidecar: true, probeCleaned: true }, receiptMatched: true, terminalDone: true, cleanup: [] }), { result: 'PASS', runtime: { platform: 'unknown', architecture: 'unknown', nodeVersion: 'unknown', model: 'unknown', reasoningEffort: 'unknown' }, versions: { trueforge: 'unknown', sdk: 'unknown', mcp: 'unknown' }, phases: ['provider', 'snapshots', 'sandboxes', 'ready'], calls: [], policies: ['question'], receiptMatched: true, terminalDone: true, cleanup: [] });
});
test('native evidence reconstructs turn records and strips hostile extras', () => {
  const evidence = safeNativeEvidence({ result: 'PASS', runtime: { platform: 'ubuntu', architecture: 'x64', nodeVersion: '22.14.0', model: 'openai/gpt', reasoningEffort: 'low' }, versions: { trueforge: '0.1.4', sdk: '0.1.3', mcp: '2.0.0' }, phases: [], calls: [], turns: [{ kind: 'ask', calls: ['codealongai_get_walkthrough_request'], policy: 'start', sandboxCreated: true, sessionCreated: true, sessionDeleted: true, receiptMatched: true, terminalDone: true, agentSpec: { secret: 'no' } } as never], receiptMatched: true, terminalDone: true, cleanup: [] });
  assert.deepEqual(evidence.turns, [{ kind: 'ask', calls: ['codealongai_get_walkthrough_request'], policy: 'start', sandboxCreated: true, sessionCreated: true, sessionDeleted: true, receiptMatched: true, terminalDone: true }]);
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
test('public capability parsing retains only an exact server version', () => {
  assert.deepEqual(trueForgeCapabilitySummary(200, '{"version":"0.1.4","private":"ignored"}'), { available: true, version: '0.1.4' });
  assert.deepEqual(trueForgeCapabilitySummary(200, '{"version":"not-a-version"}'), { available: true, version: undefined });
  assert.deepEqual(trueForgeCapabilitySummary(500, '{}'), { available: false, version: undefined });
});
test('configuration evidence requires build-pinned skill, connector, and ownership', () => {
  const commit = '2'.repeat(40); const facts = { skillCommit: commit, connectorDiscovered: true, ownership: true };
  assert.equal(validNativeReadinessFacts(facts, commit), true);
  assert.equal(validNativeReadinessFacts({ ...facts, connectorDiscovered: false }, commit), false);
});
test('sandbox runtime count returns only a count', async () => {
  const store = await mkdtemp(path.join(os.tmpdir(), 'codealongai-sandbox-count-'));
  try { await mkdir(path.join(store, 'nested', 'sandbox-runtime'), { recursive: true }); assert.equal(await localSandboxRuntimeDirectoryCount(store), 1); }
  finally { await rm(store, { recursive: true, force: true }); }
});
test('native owned shutdown escalates after one exact five-second grace', async () => {
  const signals: string[] = []; const waits: number[] = [];
  const child = { exitCode: null, signalCode: null, kill: (signal: string) => { signals.push(signal); return true; }, once: () => child, removeListener: () => child };
  assert.equal(await terminateOwnedSidecar(child as never, async () => true, async (_child, timeout) => { waits.push(timeout); return false; }), 'kill');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']); assert.deepEqual(waits, [5_000, 5_000]);
});
test('one owned acceptance crash restarts through the public sidecar without a producer replay', async () => {
  let starts = 0; let crashed = false; let producerReads = 0;
  const runtime = { producer: new Proxy(emptyTrueForgeProducer, { get(target, key) { if (key === 'createSession') producerReads += 1; return Reflect.get(target, key); } }), start: async () => { starts += 1; crashed = false; }, health: async () => true, verifyCapability: async () => true, hasExited: () => crashed, ownsRunningChild: async () => !crashed, open: async () => undefined, stop: async () => undefined, crashForAcceptance: async () => { crashed = true; return true; } };
  const sidecar = new TrueForgeSidecar(runtime, '/operator/store', async () => 48123 + starts);
  await sidecar.configure(); assert.equal(await sidecar.restartAfterAcceptanceCrash(), true); assert.equal(starts, 2); assert.equal(producerReads, 0);
});
test('TrueForge package metadata is reachable from its supported CLI seed', () => {
  const requireFromRoot = createRequire(`${process.cwd()}/package.json`); let directory = path.dirname(requireFromRoot.resolve('@truefoundry/trueforge/dist/cli.js'));
  while (true) { try { const manifest = require(`${directory}/package.json`) as { name?: string; version?: string }; if (manifest.name === '@truefoundry/trueforge') { assert.equal(manifest.version, '0.1.4'); return; } } catch {} const parent = path.dirname(directory); assert.notEqual(parent, directory); directory = parent; }
});
test('file URL roots preserve spaces and escaped checkout characters', () => {
  const root = fileURLToPath(new URL('file:///tmp/codealongai%20checkout%20%23native/'));
  assert.equal(root, '/tmp/codealongai checkout #native/');
});
