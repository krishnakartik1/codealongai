import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { deriveOrigin, projectDestinations, WalkthroughAuthority, type QuestionOutcome, type StartReceipt, type WalkthroughSession } from '../walkthrough';
import { WorkspaceReader } from '../workspace';
import type { WorkspaceFile, WorkspaceSource } from '../workspace';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { LoopbackMcpEndpoint } from '../mcp';
import { commentThreadOptions, destinationQuickPickItems, navigationContext, selectReadinessRetryForTests, setMcpPortObserverForTests, setOutputShowObserverForTests, setReadinessActionSelectorForTests, setTrueForgeEnvironmentForTests, setTrueForgeRuntimeForTests, threadComments, threadLabel } from '../extension';
import { deterministicQuestionOutcome } from './question-outcome-fixture';
import { emptyTrueForgeProducer, TrueForgeRuntimeDouble } from './trueforge-runtime-double';
import { McpLifecycle } from '../lifecycle';
import { isUbuntuX64, recoverStaleOwnership, releaseOwnershipIfCurrent, SdkTrueForgeProducerRuntime, TrueForgeSidecar, type TrueForgeProducerReadinessResult, type TrueForgeProducerRuntime, type TrueForgeRuntime } from '../trueforge';
import { resolveNodeExecutable } from '../trueforge-environment';
import { writeOwnership } from '../trueforge-ownership';
import { DaytonaReadiness, type DaytonaProbeResult } from '../daytona';
import { DaytonaProbeState, producerAgentSpec, trueForgeClientOptions } from '../trueforge-sdk';
import { ProducerReadiness } from '../producer-readiness';
import { setBuildCommitForTests } from '../build-identity';
import { ReceiptBackedStartCoordinator, StartTurnReducer, startProducerAgentSpec } from '../producer-turn';
import { StartTurnOwner } from '../start-turn-owner';

interface WalkthroughTestApi {
  readonly endpointState: string;
  readonly session: WalkthroughSession | undefined;
  readonly hasPendingWalkthroughRequest: boolean;
  replyTargetAt(stopId: string): object | undefined;
}

const commandRuntime = new TrueForgeRuntimeDouble();
setTrueForgeRuntimeForTests((reportUnexpectedExit) => { commandRuntime.reportUnexpectedExitForTests = reportUnexpectedExit; return commandRuntime; });
setMcpPortObserverForTests((port) => { commandRuntime.mcpPort = port; });
setBuildCommitForTests('1111111111111111111111111111111111111111');

function sdkWithProbeEvents(events: readonly unknown[]): SdkTrueForgeProducerRuntime {
  return new SdkTrueForgeProducerRuntime('http://127.0.0.1:48123/', () => ({
    settings: { modelProviders: { list: async () => [] }, skills: { list: async () => [] }, sandboxProviders: { get: async () => ({ data: { manifest: { type: 'daytona' }, status: 'ready' } }), createOrUpdate: async () => ({ data: { manifest: { type: 'daytona' }, status: 'ready' } }) } },
    catalogs: { modelProviders: { list: async () => [] } }, models: { list: async () => ({ data: [{ name: 'configured-model' }] }) }, skills: { list: async () => [] },
    sessions: { create: async () => ({ data: { id: 'probe-session' } }), createTurn: async () => ({ data: { id: 'probe-turn' } }), subscribeToTurn: async () => (async function* () { yield* events; })(), cancel: async () => undefined, delete: async () => undefined }
  }));
}

async function activeWalkthrough(): Promise<WalkthroughTestApi> {
  const extension = vscode.extensions.getExtension<WalkthroughTestApi>('krishnakartik1.codealongai');
  assert.ok(extension, 'the CodeAlongAI extension should be installed in the Extension Development Host');
  return extension.activate();
}

async function eventually<T>(read: () => T | undefined, message: string): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}
function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
}

async function withMcpEnabled<T>(api: WalkthroughTestApi, run: () => Promise<T>): Promise<T> {
  const configuration = vscode.workspace.getConfiguration('codealongai.mcp');
  const previous = configuration.inspect<boolean>('enabled')?.globalValue;
  const wasEnabled = configuration.get<boolean>('enabled', false);
  await configuration.update('enabled', true, vscode.ConfigurationTarget.Global);
  await eventually(() => api.endpointState === 'ready' ? true : undefined, 'the loopback MCP endpoint should become ready');
  try {
    return await run();
  } finally {
    await configuration.update('enabled', previous, vscode.ConfigurationTarget.Global);
    await eventually(() => api.endpointState === (wasEnabled ? 'ready' : 'off') ? true : undefined, 'the loopback MCP endpoint should return to its previous state after the test');
  }
}

async function withProducerConfigured<T>(run: () => Promise<T>): Promise<T> {
  const configuration = vscode.workspace.getConfiguration('codealongai.trueforge');
  const priorModel = configuration.inspect<string>('model')?.globalValue;
  const priorReasoning = configuration.inspect<string>('reasoningEffort')?.globalValue;
  await configuration.update('model', 'openai/gpt-5.2', vscode.ConfigurationTarget.Global);
  await configuration.update('reasoningEffort', 'medium', vscode.ConfigurationTarget.Global);
  try { return await run(); }
  finally { await configuration.update('model', priorModel, vscode.ConfigurationTarget.Global); await configuration.update('reasoningEffort', priorReasoning, vscode.ConfigurationTarget.Global); }
}

async function clearWalkthroughForStartTest(api: WalkthroughTestApi): Promise<void> {
  if (!api.session) return;
  const notificationWindow = vscode.window as unknown as { showWarningMessage: typeof vscode.window.showWarningMessage };
  const nativeWarning = notificationWindow.showWarningMessage;
  notificationWindow.showWarningMessage = (async (message: string) => message === 'Reset this walkthrough? All walkthrough conversations will be cleared.' ? 'Reset walkthrough' : undefined) as typeof vscode.window.showWarningMessage;
  try {
    await vscode.commands.executeCommand('codealongai.walkthrough.reset');
    await eventually(() => api.session === undefined ? true : undefined, 'the existing walkthrough should reset before a start-failure assertion');
  } finally { notificationWindow.showWarningMessage = nativeWarning; }
}

async function writeOwnershipLock(lock: string, record: object | string): Promise<void> {
  await mkdir(lock);
  await writeFile(path.join(lock, 'ownership.json'), typeof record === 'string' ? record : JSON.stringify(record));
}

function childHasExited(child: { readonly exitCode: number | null; readonly signalCode: NodeJS.Signals | null }): boolean { return child.exitCode !== null || child.signalCode !== null; }

function waitForChildExit(child: import('node:child_process').ChildProcess): Promise<void> {
  if (childHasExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => resolve();
    child.once('exit', finish);
    if (childHasExited(child)) { child.removeListener('exit', finish); finish(); }
  });
}

suite('Extension Development Host walkthrough', () => {
  test('retries the captured Ask and Reply origins only after Daytona setup is ready', async () => {
    const api = await activeWalkthrough();
    await withProducerConfigured(() => withMcpEnabled(api, async () => {
      const workspace = vscode.workspace.workspaceFolders?.[0];
      assert.ok(workspace, 'the approved two-file workspace should be open');
      const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspace.uri, 'checkout.ts'));
      const editor = await vscode.window.showTextDocument(document);
      const selection = new vscode.Selection(2, 0, 2, 22);
      editor.selection = selection;
      const sourceBefore = document.getText();

      const askProbes = commandRuntime.probeCalls;
      const askPrepares = commandRuntime.prepareCalls;
      commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'snapshots', outcome: 'failed' };
      setReadinessActionSelectorForTests(async (actions) => {
        assert.deepEqual(actions, ['Open TrueForge Setup', 'Retry Setup']);
        editor.selection = new vscode.Selection(0, 0, 0, 1);
        commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'ready', outcome: 'ready' };
        return 'Retry Setup';
      });
      await vscode.commands.executeCommand('codealongai.walkthrough.ask');
      const origin = await eventually(() => api.session, 'the public Ask command should create a walkthrough session');
      setReadinessActionSelectorForTests(undefined);
      assert.equal(commandRuntime.probeCalls, askProbes + 3);
      assert.equal(commandRuntime.prepareCalls, askPrepares + 1);
      assert.deepEqual(origin.origin, {
      stopId: 'checkout-origin',
      displayName: 'Origin',
      explanation: 'What would you like to understand about this code?',
      document: 'checkout.ts',
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 22 } }
      });
      editor.selection = selection;

      const replyTarget = await eventually(() => api.replyTargetAt('checkout-origin'), 'the origin should render a native CodeAlongAI comment thread');
      assert.equal(Object.isFrozen(replyTarget), true);
      const blockedReadinessCases: { readonly name: string; readonly actions: readonly string[]; readonly environment?: { isUbuntuX64(): Promise<boolean>; resolveNodeExecutable(configured?: string): Promise<string> }; readonly sidecar?: boolean; readonly daytona?: DaytonaProbeResult; readonly producer?: TrueForgeProducerReadinessResult }[] = [
        { name: 'node', actions: ['Configure Node', 'Show CodeAlongAI Output'], environment: { isUbuntuX64: async () => true, resolveNodeExecutable: async () => { throw new Error('node unavailable'); } } },
        { name: 'architecture', actions: ['Show CodeAlongAI Output'], environment: { isUbuntuX64: async () => false, resolveNodeExecutable: async () => process.execPath } },
        { name: 'sidecar', actions: ['Retry TrueForge', 'Show CodeAlongAI Output'], sidecar: true },
        ...(['provider', 'authentication', 'authentication-or-snapshots', 'model', 'sandboxes', 'snapshots', 'sandbox-create', 'cleanup', 'setup'] as const).map((phase) => ({ name: `daytona-${phase === 'provider' ? 'provider-project-configuration' : phase}`, actions: ['Open TrueForge Setup', 'Retry Setup'], daytona: { provider: 'daytona' as const, phase, outcome: phase === 'cleanup' ? 'residual' as const : 'failed' as const } })),
        ...(['model', 'alias', 'reasoning', 'authentication', 'skill', 'connector'] as const).map((phase) => ({ name: `producer-${phase === 'authentication' ? 'terminal-authentication' : phase}`, actions: ['Open TrueForge Setup', 'Retry Setup'], producer: { phase, outcome: 'failed' as const } })),
        { name: 'producer-terminal-network', actions: ['Retry TrueForge', 'Show CodeAlongAI Output'], producer: { phase: 'network' as const, outcome: 'failed' as const } },
        { name: 'producer-paused-done', actions: ['Retry TrueForge', 'Show CodeAlongAI Output'], producer: { phase: 'network' as const, outcome: 'failed' as const } },
        { name: 'producer-mcp-catalog', actions: ['Show CodeAlongAI Output'], producer: { phase: 'mcp-discovery' as const, outcome: 'failed' as const } }
      ];
      for (const readinessCase of blockedReadinessCases) {
        const before = api.session;
        commandRuntime.daytonaProbe = readinessCase.daytona ?? { provider: 'daytona', phase: 'ready', outcome: 'ready' };
        commandRuntime.producerReadiness = readinessCase.producer ?? { phase: 'ready', outcome: 'ready' };
        commandRuntime.healthy = !readinessCase.sidecar;
        commandRuntime.failStart = readinessCase.sidecar === true;
        setTrueForgeEnvironmentForTests(readinessCase.environment);
        let offered: readonly string[] | undefined;
        setReadinessActionSelectorForTests(async (actions) => { offered = actions; return undefined; });
        try {
          await vscode.commands.executeCommand('codealongai.walkthrough.submitComment', { thread: replyTarget, text: `Blocked readiness ${readinessCase.name}.` });
          assert.deepEqual(await eventually(() => offered, `the ${readinessCase.name} public readiness warning should offer an action`), readinessCase.actions);
          assert.deepEqual(api.session, before);
          assert.equal(api.hasPendingWalkthroughRequest, false);

          setReadinessActionSelectorForTests(undefined);
          offered = undefined;
          setReadinessActionSelectorForTests(async (actions) => { offered = actions; return undefined; });
          const notificationWindow = vscode.window as unknown as { showWarningMessage: typeof vscode.window.showWarningMessage };
          const originalWarning = notificationWindow.showWarningMessage;
          notificationWindow.showWarningMessage = (async (message: string) => message === 'Starting a new walkthrough clears all conversations.' ? 'Start new walkthrough' : undefined) as typeof vscode.window.showWarningMessage;
          try {
            await vscode.commands.executeCommand('codealongai.walkthrough.ask');
            assert.deepEqual(await eventually(() => offered, `the confirmed ${readinessCase.name} replacement should offer an action`), readinessCase.actions);
            assert.deepEqual(api.session, before);
            assert.equal(api.hasPendingWalkthroughRequest, false);
          } finally { notificationWindow.showWarningMessage = originalWarning; }
        } finally {
          setReadinessActionSelectorForTests(undefined);
          setTrueForgeEnvironmentForTests(undefined);
          commandRuntime.healthy = true;
          commandRuntime.failStart = false;
          commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'ready', outcome: 'ready' };
          commandRuntime.producerReadiness = { phase: 'ready', outcome: 'ready' };
        }
      }
      const setupOpens = commandRuntime.calls.filter((call) => call.startsWith('open:')).length;
      const setupPrepares = commandRuntime.prepareCalls;
      const beforeSetup = api.session;
      commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'snapshots', outcome: 'failed' };
      setReadinessActionSelectorForTests(async (actions) => {
        assert.deepEqual(actions, ['Open TrueForge Setup', 'Retry Setup']);
        commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'ready', outcome: 'ready' };
        return 'Open TrueForge Setup';
      });
      await vscode.commands.executeCommand('codealongai.walkthrough.submitComment', { thread: replyTarget, text: 'Setup must not capture this reply.' });
      await eventually(() => commandRuntime.calls.filter((call) => call.startsWith('open:')).length >= setupOpens + 1 ? true : undefined, 'the selected public setup action should invoke the registered Configure command');
      await eventually(() => commandRuntime.prepareCalls === setupPrepares + 1 ? true : undefined, 'the registered Configure command should complete its public readiness check');
      setReadinessActionSelectorForTests(undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(api.session, beforeSetup);
      assert.equal(api.hasPendingWalkthroughRequest, false);

      let resolveOldSelection: ((action: string | undefined) => void) | undefined;
      let selections = 0;
      const stalePrepares = commandRuntime.prepareCalls;
      commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'sandboxes', outcome: 'failed' };
      setReadinessActionSelectorForTests(async () => {
        selections += 1;
        return selections === 1 ? new Promise((resolve) => { resolveOldSelection = resolve; }) : undefined;
      });
      await vscode.commands.executeCommand('codealongai.walkthrough.submitComment', { thread: replyTarget, text: 'This stale reply must not run.' });
      await eventually(() => resolveOldSelection, 'the older Daytona notification should await its selection');
      await vscode.commands.executeCommand('codealongai.walkthrough.submitComment', { thread: replyTarget, text: 'This stale reply must not run.' });
      await eventually(() => selections === 2 ? true : undefined, 'the newer Daytona notification should supersede the older one');
      commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'ready', outcome: 'ready' };
      resolveOldSelection!('Open TrueForge Setup');
      await new Promise((resolve) => setTimeout(resolve, 0));
      setReadinessActionSelectorForTests(undefined);
      assert.equal(commandRuntime.prepareCalls, stalePrepares);
      assert.deepEqual(api.session, beforeSetup);

      const replyProbes = commandRuntime.probeCalls;
      const replyPrepares = commandRuntime.prepareCalls;
      commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'sandboxes', outcome: 'failed' };
      setReadinessActionSelectorForTests(async (actions) => {
        assert.deepEqual(actions, ['Open TrueForge Setup', 'Retry Setup']);
        commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'ready', outcome: 'ready' };
        return 'Retry Setup';
      });
      await vscode.commands.executeCommand('codealongai.walkthrough.submitComment', { thread: replyTarget, text: 'Follow this value.' });
      const branched = await eventually(() => api.session?.stops.length === 5 ? api.session : undefined, 'the native reply should grow the deterministic first branch');
      setReadinessActionSelectorForTests(undefined);
      assert.equal(commandRuntime.probeCalls, replyProbes + 3);
      assert.equal(commandRuntime.prepareCalls, replyPrepares + 1);
      assert.deepEqual(branched.stops.map((stop) => stop.id), ['checkout-origin', 'pricing-function', 'pricing-reducer', 'pricing-reducer-revisit', 'checkout-cart']);
      assert.deepEqual(branched.stops[0].conversation.slice(-2), [{ author: 'You', bodyMarkdown: 'Follow this value.' }, { author: 'CodeAlongAI', bodyMarkdown: 'Follow the value through the subtotal function and its reducer.' }]);
      assert.ok(destinationQuickPickItems(branched).some((item) => item.stopId === 'pricing-function'));
      assert.deepEqual(branched.origin, origin.origin);
      assert.equal(branched.attentionStopId, 'checkout-origin');
      assert.equal(document.getText(), sourceBefore);
      assert.equal(document.isDirty, false);
      assert.deepEqual(editor.selection, selection);
      await eventually(() => !api.hasPendingWalkthroughRequest ? true : undefined, 'the completed public reply should clear its request before another reply begins');
      assert.equal(api.replyTargetAt('pricing-function'), undefined, 'the generated Definition must not create a native thread before explicit navigation');

      await vscode.commands.executeCommand('codealongai.walkthrough.next');
      const definitionSession = await eventually(() => api.session?.attentionStopId === 'pricing-function' ? api.session : undefined, 'the public Next command should move walkthrough attention to Definition');
      const definitionReplyTarget = await eventually(() => api.replyTargetAt(definitionSession.attentionStopId), 'Definition should render a native CodeAlongAI comment thread');
      await vscode.commands.executeCommand('codealongai.walkthrough.submitComment', { thread: definitionReplyTarget, text: 'Where does the reducer start?' });
      const complete = await eventually(() => api.session?.stops.length === 6 ? api.session : undefined, 'the second native reply should add Initial value');
      assert.deepEqual(complete.stops.map((stop) => stop.id), ['checkout-origin', 'pricing-function', 'pricing-reducer', 'pricing-reducer-revisit', 'checkout-cart', 'initial-value']);
      assert.equal(complete.attentionStopId, 'pricing-function');
      assert.equal(complete.stops.find((stop) => stop.id === 'initial-value')?.explanation, 'The reduction starts from its initial value.');

      const beforeReplacement = api.session!;
      const preparesBeforeReplacement = commandRuntime.prepareCalls;
      const notificationWindow = vscode.window as unknown as { showWarningMessage: typeof vscode.window.showWarningMessage };
      const originalWarning = notificationWindow.showWarningMessage;
      try {
        notificationWindow.showWarningMessage = (async (message: string) => message === 'Starting a new walkthrough clears all conversations.' ? 'Cancel' : undefined) as typeof vscode.window.showWarningMessage;
        await vscode.commands.executeCommand('codealongai.walkthrough.ask');
        assert.deepEqual(api.session, beforeReplacement);
        assert.equal(commandRuntime.prepareCalls, preparesBeforeReplacement);

        notificationWindow.showWarningMessage = (async (message: string) => message === 'Starting a new walkthrough clears all conversations.' ? 'Start new walkthrough' : undefined) as typeof vscode.window.showWarningMessage;
        commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'snapshots', outcome: 'failed' };
        setReadinessActionSelectorForTests(async (actions) => {
          assert.deepEqual(actions, ['Open TrueForge Setup', 'Retry Setup']);
          editor.selection = new vscode.Selection(0, 0, 0, 1);
          commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'ready', outcome: 'ready' };
          return 'Retry Setup';
        });
        await vscode.commands.executeCommand('codealongai.walkthrough.ask');
        const replacement = await eventually(() => api.session?.id !== beforeReplacement.id ? api.session : undefined, 'the confirmed public Ask command should replace the walkthrough');
        setReadinessActionSelectorForTests(undefined);
        assert.equal(replacement.stops.length, 1);
        assert.deepEqual(replacement.origin?.range, { start: { line: 2, character: 0 }, end: { line: 2, character: 22 } });
        assert.equal(commandRuntime.prepareCalls, preparesBeforeReplacement + 1);
      } finally { notificationWindow.showWarningMessage = originalWarning; }
    }));
  });

  test('Configure TrueForge completes ready setup without creating a walkthrough session', async () => {
    const api = await activeWalkthrough();
    const before = api.session;
    await withProducerConfigured(async () => {
      await withMcpEnabled(api, async () => {
        const checks = commandRuntime.prepareCalls;
        commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'ready', outcome: 'ready' };
        commandRuntime.producerReadiness = { phase: 'ready', outcome: 'ready' };
        await vscode.commands.executeCommand('codealongai.trueforge.configure');
        assert.ok(commandRuntime.prepareCalls > checks);
      });
    });
    assert.deepEqual(api.session, before);
    assert.equal(api.hasPendingWalkthroughRequest, false);
  });

  test('Configure TrueForge retries a failed Daytona readiness check through its registered command', async () => {
    const api = await activeWalkthrough();
    await withProducerConfigured(() => withMcpEnabled(api, async () => {
      const prepares = commandRuntime.prepareCalls;
      commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'snapshots', outcome: 'failed' };
      commandRuntime.producerReadiness = { phase: 'ready', outcome: 'ready' };
      setReadinessActionSelectorForTests(async (actions) => {
        assert.deepEqual(actions, ['Open TrueForge Setup', 'Retry Setup']);
        commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'ready', outcome: 'ready' };
        return 'Retry Setup';
      });
      try {
        await vscode.commands.executeCommand('codealongai.trueforge.configure');
        await eventually(() => commandRuntime.prepareCalls > prepares ? true : undefined, 'Retry Setup should rerun Configure and producer readiness');
      } finally {
        setReadinessActionSelectorForTests(undefined);
        commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'ready', outcome: 'ready' };
      }
    }));
  });

  test('refreshes the retained readiness coordinator when the external producer is replaced', async () => {
    const api = await activeWalkthrough();
    await withProducerConfigured(() => withMcpEnabled(api, async () => {
      commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'ready', outcome: 'ready' };
      commandRuntime.producerReadiness = { phase: 'ready', outcome: 'ready' };
      commandRuntime.maximumConcurrentPrepares = 0;
      const prepares = commandRuntime.prepareCalls;
      let release: (() => void) | undefined;
      commandRuntime.prepareWait = new Promise<void>((resolve) => { release = resolve; });
      try {
        const first = vscode.commands.executeCommand('codealongai.trueforge.configure');
        await eventually(() => commandRuntime.prepareCalls === prepares + 1 ? true : undefined, 'the first retained producer readiness check should begin');
        const queued = vscode.commands.executeCommand('codealongai.trueforge.configure');
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(commandRuntime.prepareCalls, prepares + 1);
        commandRuntime.replaceProducerForTests();
        const refreshed = vscode.commands.executeCommand('codealongai.trueforge.configure');
        await eventually(() => commandRuntime.prepareCalls === prepares + 2 ? true : undefined, 'the replacement producer should receive a fresh coordinator');
        assert.equal(commandRuntime.maximumConcurrentPrepares, 2);
        release!();
        await Promise.all([first, queued, refreshed]);
        assert.equal(commandRuntime.prepareCalls, prepares + 3);
      } finally { commandRuntime.prepareWait = undefined; }
    }));
  });

  test('routes public Ask through the replacement producer after a sidecar identity swap', async () => {
    const api = await activeWalkthrough();
    await withProducerConfigured(() => withMcpEnabled(api, async () => {
      const workspace = vscode.workspace.workspaceFolders?.[0]; assert.ok(workspace);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspace.uri, 'checkout.ts'));
      const editor = await vscode.window.showTextDocument(document); editor.selection = new vscode.Selection(2, 0, 2, 22);
      const notificationWindow = vscode.window as unknown as { showWarningMessage: typeof vscode.window.showWarningMessage };
      const previousWarning = notificationWindow.showWarningMessage;
      notificationWindow.showWarningMessage = (async (message: string) => message === 'Reset this walkthrough? All walkthrough conversations will be cleared.' ? 'Reset walkthrough' : message === 'Starting a new walkthrough clears all conversations.' ? 'Start new walkthrough' : undefined) as typeof vscode.window.showWarningMessage;
      try {
        if (api.session) await vscode.commands.executeCommand('codealongai.walkthrough.reset');
        await eventually(() => api.session === undefined ? true : undefined, 'the prior walkthrough should reset before the producer swap');
        commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'ready', outcome: 'ready' };
        commandRuntime.producerReadiness = { phase: 'ready', outcome: 'ready' };
        const producerA = commandRuntime.producer;
        await vscode.commands.executeCommand('codealongai.walkthrough.ask');
        await eventually(() => api.session, 'producer A should establish the initial start coordinator');
        await vscode.commands.executeCommand('codealongai.walkthrough.reset');
        await eventually(() => api.session === undefined ? true : undefined, 'the first walkthrough should reset');
        commandRuntime.replaceProducerForTests();
        const producerB = commandRuntime.producer;
        const before = commandRuntime.producerTurnCalls.length;
        await vscode.commands.executeCommand('codealongai.walkthrough.ask');
        const session = await eventually(() => api.session, 'the replacement producer receipt should commit a walkthrough');
        const replacementCalls = commandRuntime.producerTurnCalls.slice(before);
        assert.equal(session.origin.document, 'checkout.ts');
        assert.deepEqual(replacementCalls.map((call) => call.kind), ['session', 'turn', 'events']);
        assert.equal(replacementCalls.every((call) => call.producer === producerB), true);
        assert.equal(replacementCalls.some((call) => call.producer === producerA), false);
      } finally { notificationWindow.showWarningMessage = previousWarning; }
    }));
  });

  test('does not queue duplicate public Asks and cancellation keeps the request pending', async () => {
    const api = await activeWalkthrough();
    await withProducerConfigured(() => withMcpEnabled(api, async () => {
      const notificationWindow = vscode.window as unknown as { showWarningMessage: typeof vscode.window.showWarningMessage };
      const nativeWarning = notificationWindow.showWarningMessage;
      const errorWindow = vscode.window as unknown as { showErrorMessage: typeof vscode.window.showErrorMessage };
      const nativeError = errorWindow.showErrorMessage;
      let discardCancelledRequest: ((action: string) => void) | undefined;
      notificationWindow.showWarningMessage = (async (message: string) => message.startsWith('Reset this walkthrough?') ? 'Reset walkthrough' : undefined) as typeof vscode.window.showWarningMessage;
      errorWindow.showErrorMessage = (() => new Promise<string>((resolve) => { discardCancelledRequest = resolve; })) as typeof vscode.window.showErrorMessage;
      if (api.session) { await vscode.commands.executeCommand('codealongai.walkthrough.reset'); await eventually(() => api.session === undefined ? true : undefined, 'the walkthrough should reset'); }
      const workspace = vscode.workspace.workspaceFolders?.[0]; assert.ok(workspace);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspace.uri, 'checkout.ts'));
      const editor = await vscode.window.showTextDocument(document); editor.selection = new vscode.Selection(2, 0, 2, 22);
      let release: (() => void) | undefined;
      commandRuntime.producerEventWait = new Promise<void>((resolve) => { release = resolve; });
      const windowWithProgress = vscode.window as unknown as { withProgress: typeof vscode.window.withProgress };
      const nativeWithProgress = windowWithProgress.withProgress;
      const tokenSource = new vscode.CancellationTokenSource();
      try {
        windowWithProgress.withProgress = ((_: vscode.ProgressOptions, task: (progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Thenable<unknown>) => task({ report: () => undefined }, tokenSource.token)) as typeof vscode.window.withProgress;
        const before = commandRuntime.producerTurnCalls.length;
        const first = vscode.commands.executeCommand('codealongai.walkthrough.ask');
        await eventually(() => commandRuntime.producerTurnCalls.length === before + 3 ? true : undefined, 'the first Ask should start its one producer turn');
        const duplicate = vscode.commands.executeCommand('codealongai.walkthrough.ask');
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(commandRuntime.producerTurnCalls.length, before + 3);
        tokenSource.cancel();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(commandRuntime.producerCancelCalls > 0, true, 'the native progress cancellation token cancels the active producer turn');
        release!();
        await Promise.all([first, duplicate]);
        assert.equal(commandRuntime.producerCancelCalls > 0, true);
        assert.equal(api.session, undefined);
        assert.equal(api.hasPendingWalkthroughRequest, true);
        discardCancelledRequest!('Discard request');
        await eventually(() => !api.hasPendingWalkthroughRequest ? true : undefined, 'the test should discard its cancelled request before later public tests');
      } finally {
        release?.(); commandRuntime.producerEventWait = undefined; windowWithProgress.withProgress = nativeWithProgress; notificationWindow.showWarningMessage = nativeWarning; errorWindow.showErrorMessage = nativeError; tokenSource.dispose();
      }
    }));
  });

  test('retries one exact failed Ask with a fresh turn and never exposes provider text', async () => {
    const api = await activeWalkthrough();
    await withProducerConfigured(() => withMcpEnabled(api, async () => {
      const workspace = vscode.workspace.workspaceFolders?.[0]; assert.ok(workspace);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspace.uri, 'checkout.ts'));
      const editor = await vscode.window.showTextDocument(document); editor.selection = new vscode.Selection(2, 0, 2, 22);
      await clearWalkthroughForStartTest(api);
      const errorWindow = vscode.window as unknown as { showErrorMessage: typeof vscode.window.showErrorMessage };
      const nativeError = errorWindow.showErrorMessage;
      let select: ((action: string) => void) | undefined;
      const sentinel = 'PROVIDER_SECRET_SENTINEL';
      commandRuntime.producerEventError = new Error(sentinel);
      errorWindow.showErrorMessage = ((message: string, ...actions: string[]) => {
        assert.equal(message.includes(sentinel), false); assert.equal(actions.includes('Show CodeAlongAI Output'), true);
        return new Promise<string>((resolve) => { select = resolve; });
      }) as unknown as typeof vscode.window.showErrorMessage;
      try {
        const before = commandRuntime.producerTurnCalls.length;
        await vscode.commands.executeCommand('codealongai.walkthrough.ask');
        await eventually(() => select ? true : undefined, 'the failure notification should offer a selection');
        assert.equal(api.hasPendingWalkthroughRequest, true);
        commandRuntime.producerEventError = undefined;
        select!('Retry walkthrough');
        await eventually(() => api.session, 'Retry should use a new producer session and turn');
        assert.deepEqual(commandRuntime.producerTurnCalls.slice(before).map((call) => call.kind), ['session', 'turn', 'events', 'events', 'session', 'turn', 'events']);
      } finally { commandRuntime.producerEventError = undefined; errorWindow.showErrorMessage = nativeError; }
    }));
  });

  test('does not let a discarded start-failure retry select a later request', async () => {
    const api = await activeWalkthrough();
    await withProducerConfigured(() => withMcpEnabled(api, async () => {
      const workspace = vscode.workspace.workspaceFolders?.[0]; assert.ok(workspace);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspace.uri, 'checkout.ts'));
      const editor = await vscode.window.showTextDocument(document); editor.selection = new vscode.Selection(2, 0, 2, 22);
      const warningWindow = vscode.window as unknown as { showWarningMessage: typeof vscode.window.showWarningMessage };
      const errorWindow = vscode.window as unknown as { showErrorMessage: typeof vscode.window.showErrorMessage };
      const nativeWarning = warningWindow.showWarningMessage;
      const nativeError = errorWindow.showErrorMessage;
      const selections: ((action: string) => void)[] = [];
      warningWindow.showWarningMessage = (async (message: string) => message === 'Reset this walkthrough? All walkthrough conversations will be cleared.' ? 'Reset walkthrough' : undefined) as typeof vscode.window.showWarningMessage;
      errorWindow.showErrorMessage = ((message: string, ...actions: string[]) => {
        assert.equal(message, 'CodeAlongAI could not start the walkthrough.');
        assert.deepEqual(actions, ['Retry walkthrough', 'Discard request', 'Show CodeAlongAI Output']);
        return new Promise<string>((resolve) => { selections.push(resolve); });
      }) as unknown as typeof vscode.window.showErrorMessage;
      try {
        if (api.session) { await vscode.commands.executeCommand('codealongai.walkthrough.reset'); await eventually(() => api.session === undefined ? true : undefined, 'the walkthrough should reset'); }
        commandRuntime.producerEventError = new Error('first request fails');
        const before = commandRuntime.producerTurnCalls.length;
        await vscode.commands.executeCommand('codealongai.walkthrough.ask');
        await eventually(() => selections.length === 1 ? true : undefined, 'the first failed Ask should offer its actions');
        selections[0]('Discard request');
        await eventually(() => !api.hasPendingWalkthroughRequest ? true : undefined, 'Discard request should invalidate only the first request');
        assert.equal(commandRuntime.producerTurnCalls.length, before + 4);

        await vscode.commands.executeCommand('codealongai.walkthrough.ask');
        await eventually(() => selections.length === 2 ? true : undefined, 'the later failed Ask should offer separate actions');
        // The first notification's retry capability was discarded with its
        // request. It must not be rebound to the later pending request.
        const callsBeforeStaleRetry = commandRuntime.producerTurnCalls.length;
        selections[0]('Retry walkthrough');
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(commandRuntime.producerTurnCalls.length, callsBeforeStaleRetry);
        assert.equal(api.session, undefined);
        assert.equal(api.hasPendingWalkthroughRequest, true);
        selections[1]('Discard request');
        await eventually(() => !api.hasPendingWalkthroughRequest ? true : undefined, 'the later request should be discarded for test cleanup');
      } finally {
        commandRuntime.producerEventError = undefined;
        warningWindow.showWarningMessage = nativeWarning;
        errorWindow.showErrorMessage = nativeError;
      }
    }));
  });

  test('shows sanitized start failure output without retrying or changing its request', async () => {
    const api = await activeWalkthrough();
    await withProducerConfigured(() => withMcpEnabled(api, async () => {
      await clearWalkthroughForStartTest(api);
      const workspace = vscode.workspace.workspaceFolders?.[0]; assert.ok(workspace);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspace.uri, 'checkout.ts'));
      const editor = await vscode.window.showTextDocument(document); editor.selection = new vscode.Selection(2, 0, 2, 22);
      const errorWindow = vscode.window as unknown as { showErrorMessage: typeof vscode.window.showErrorMessage };
      const nativeError = errorWindow.showErrorMessage;
      let discardAfterOutput: (() => void) | undefined;
      const shown: boolean[] = [];
      commandRuntime.producerEventError = new Error('output only failure');
      setOutputShowObserverForTests((preserveFocus) => { shown.push(preserveFocus); });
      errorWindow.showErrorMessage = (() => ({
        then: (selected: (action: string) => unknown) => {
          void selected('Show CodeAlongAI Output');
          return new Promise<void>((resolve) => { discardAfterOutput = () => { void selected('Discard request'); resolve(); }; });
        }
      })) as unknown as typeof vscode.window.showErrorMessage;
      try {
        const before = commandRuntime.producerTurnCalls.length;
        await vscode.commands.executeCommand('codealongai.walkthrough.ask');
        await eventually(() => shown.length === 1 ? true : undefined, 'Show CodeAlongAI Output should reveal the native output channel');
        assert.deepEqual(shown, [true]);
        assert.equal(commandRuntime.producerTurnCalls.length, before + 4);
        assert.equal(api.session, undefined);
        assert.equal(api.hasPendingWalkthroughRequest, true);
        // Output is observation only; discard remains an explicit learner action.
        discardAfterOutput!();
        await eventually(() => !api.hasPendingWalkthroughRequest ? true : undefined, 'the output action should not prevent a later explicit discard');
      } finally {
        commandRuntime.producerEventError = undefined;
        setOutputShowObserverForTests(undefined);
        errorWindow.showErrorMessage = nativeError;
      }
    }));
  });

  test('a sidecar crash cancels the owned active turn without replaying it', async () => {
    const api = await activeWalkthrough();
    await withProducerConfigured(() => withMcpEnabled(api, async () => {
      await clearWalkthroughForStartTest(api);
      const workspace = vscode.workspace.workspaceFolders?.[0]; assert.ok(workspace);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspace.uri, 'checkout.ts'));
      const editor = await vscode.window.showTextDocument(document); editor.selection = new vscode.Selection(2, 0, 2, 22);
      const errorWindow = vscode.window as unknown as { showErrorMessage: typeof vscode.window.showErrorMessage };
      const nativeError = errorWindow.showErrorMessage;
      let discard: ((action: string) => void) | undefined;
      errorWindow.showErrorMessage = (() => new Promise<string>((resolve) => { discard = resolve; })) as typeof vscode.window.showErrorMessage;
      let release: (() => void) | undefined;
      commandRuntime.producerEventWait = new Promise<void>((resolve) => { release = resolve; });
      try {
        const startsBefore = commandRuntime.calls.filter((call) => call.startsWith('start:')).length;
        const turnsBefore = commandRuntime.producerTurnCalls.length;
        const ask = vscode.commands.executeCommand('codealongai.walkthrough.ask');
        await eventually(() => commandRuntime.producerTurnCalls.length === turnsBefore + 3 ? true : undefined, 'the active Ask should own one producer turn');
        commandRuntime.crashForTests();
        release!();
        await ask;
        await eventually(() => discard ? true : undefined, 'the crashed turn should report a recoverable failure');
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(commandRuntime.producerTurnCalls.length, turnsBefore + 3);
        assert.equal(commandRuntime.calls.filter((call) => call.startsWith('start:')).length, startsBefore);
        assert.equal(api.session, undefined);
        assert.equal(api.hasPendingWalkthroughRequest, true);
        discard!('Discard request');
        await eventually(() => !api.hasPendingWalkthroughRequest ? true : undefined, 'the crashed request should remain explicitly discardable');
      } finally {
        release?.();
        commandRuntime.producerEventWait = undefined;
        errorWindow.showErrorMessage = nativeError;
      }
    }));
  });

});

suite('MCP lifecycle', () => {
  test('serializes setting churn so the last valid configuration wins', async () => {
    const calls: string[] = [];
    let releaseStart: (() => void) | undefined;
    let listenerAttempt = 0;
    const lifecycle = new McpLifecycle(async () => {
      const attempt = ++listenerAttempt;
      return {
        port: 4000 + attempt,
        start: async () => { calls.push(`start:${attempt}`); if (attempt === 1) await new Promise<void>((resolve) => { releaseStart = resolve; }); },
        stop: async () => { calls.push(`stop:${attempt}`); }
      };
    });
    const starting = lifecycle.configure({ enabled: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const disabling = lifecycle.configure({ enabled: false });
    const enabling = lifecycle.configure({ enabled: true });
    releaseStart!();
    await Promise.all([starting, disabling, enabling]);
    assert.equal(lifecycle.state, 'ready');
    assert.equal(lifecycle.port, 4001);
    assert.deepEqual(calls, ['start:1']);
  });

  test('dynamically allocates real listeners across disable and re-enable without changing the walkthrough', async () => {
    const authority = new WalkthroughAuthority();
    const origin = { stopId: 'origin', displayName: 'Origin', explanation: 'Start', document: 'checkout.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } };
    const start = authority.captureStart(origin);
    const session = authority.start(start.id, origin);
    const lifecycle = new McpLifecycle(async () => {
      const endpoint = new LoopbackMcpEndpoint(authority);
      return { get port() { return endpoint.port; }, start: () => endpoint.start(0), stop: () => endpoint.stop() };
    });
    await lifecycle.configure({ enabled: true });
    const firstPort = lifecycle.port;
    assert.ok(firstPort && firstPort > 1023, 'the real listener should own an allocated loopback port');
    await lifecycle.configure({ enabled: false });
    await lifecycle.configure({ enabled: true });
    assert.ok(lifecycle.port && lifecycle.port > 1023, 're-enabling should allocate a real loopback listener');
    assert.equal(lifecycle.state, 'ready');
    await lifecycle.configure({ enabled: false });
    assert.equal(lifecycle.state, 'off');
    assert.deepEqual(authority.getSession(), session);
  });

  test('allocates a listener-owned port and retries bind failures no more than three times', async () => {
    const calls: string[] = [];
    let attempts = 0;
    const lifecycle = new McpLifecycle(async () => {
      const attempt = ++attempts;
      return {
        port: 4300 + attempt,
        start: async () => { calls.push(`start:${attempt}`); if (attempt < 4) throw new Error('in use'); },
        stop: async () => { calls.push(`stop:${attempt}`); }
      };
    });
    await lifecycle.configure({ enabled: true });
    assert.equal(lifecycle.state, 'ready');
    assert.equal(lifecycle.port, 4304);
    assert.deepEqual(calls, ['start:1', 'stop:1', 'start:2', 'stop:2', 'start:3', 'stop:3', 'start:4']);
  });

  test('returns off after exhausting allocation retries and can recover when re-enabled', async () => {
    const calls: string[] = [];
    let shouldFail = true;
    const lifecycle = new McpLifecycle(async () => ({
      port: 4400,
      start: async () => { calls.push('start'); if (shouldFail) throw new Error('in use'); },
      stop: async () => { calls.push('stop'); }
    }));
    await assert.rejects(() => lifecycle.configure({ enabled: true }), /in use/);
    assert.equal(lifecycle.state, 'off');
    shouldFail = false;
    await lifecycle.configure({ enabled: true });
    assert.equal(lifecycle.state, 'ready');
    assert.deepEqual(calls, ['start', 'stop', 'start', 'stop', 'start', 'stop', 'start', 'stop', 'start']);
  });

  test('ignores a bind failure superseded by a disabled lifecycle', async () => {
    let rejectStart: ((error: Error) => void) | undefined;
    const lifecycle = new McpLifecycle(async () => ({
      port: 4500,
      start: async () => {
        await new Promise<void>((_resolve, reject) => { rejectStart = reject; });
      },
      stop: async () => undefined
    }));
    const first = lifecycle.configure({ enabled: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const replacement = lifecycle.configure({ enabled: false });
    rejectStart!(new Error('in use'));
    await Promise.all([first, replacement]);
    assert.equal(lifecycle.state, 'off');
    assert.equal(lifecycle.port, undefined);
  });
});

suite('TrueForge setup sidecar', () => {
  const producer: TrueForgeProducerRuntime = emptyTrueForgeProducer;
  test('accepts only Ubuntu x86-64 for the native sidecar', async () => {
    assert.equal(await isUbuntuX64(async () => 'NAME="Ubuntu"\nID=ubuntu\n', 'linux', 'x64'), true);
    assert.equal(await isUbuntuX64(async () => 'ID=ubuntu\n', 'darwin', 'arm64'), false);
    assert.equal(await isUbuntuX64(async () => 'ID=debian\n', 'linux', 'x64'), false);
  });

  test('recovers only a stale owner record and refuses a live second window', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'codealongai-trueforge-test-'));
    const lock = path.join(directory, 'codealongai-trueforge.lock');
    try {
      await writeOwnershipLock(lock, { ownerPid: -1, ownerStartTime: '0', launchId: 'crashed-before-pid', executable: process.execPath, cli: require.resolve('@truefoundry/trueforge/dist/cli.js'), port: 48123, dataPath: directory });
      await writeFile(path.join(lock, 'recovery.claim'), JSON.stringify({ pid: -1, startTime: '0' }));
      assert.equal(await recoverStaleOwnership(lock), true);
      await writeOwnershipLock(lock, '{partial');
      assert.equal(await recoverStaleOwnership(lock), false);
      assert.equal(readFileSync(path.join(lock, 'ownership.json'), 'utf8'), '{partial');
      await rm(lock, { recursive: true, force: true });
      await writeOwnershipLock(lock, { ownerPid: -1, ownerStartTime: '0', launchId: 'unknown', childPid: 987654321, executable: '/missing/node', cli: '/missing/cli', port: 48123, dataPath: directory });
      assert.equal(await recoverStaleOwnership(lock), false);
      await rm(lock, { recursive: true, force: true });
      const stat = readFileSync('/proc/self/stat', 'utf8');
      const ownerStartTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      await writeOwnershipLock(lock, { ownerPid: process.pid, ownerStartTime, launchId: 'live-owner', executable: process.execPath, cli: require.resolve('@truefoundry/trueforge/dist/cli.js'), port: 48123, dataPath: directory });
      assert.equal(await recoverStaleOwnership(lock), false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test('recovers and terminates the exact token-identified child after a crash before PID persistence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'codealongai-trueforge-recovery-'));
    const lock = path.join(directory, 'codealongai-trueforge.lock');
    const cli = require.resolve('@truefoundry/trueforge/dist/cli.js');
    const launchId = randomUUID();
    const executable = await resolveNodeExecutable(undefined);
    const port = 48123;
    const child = spawn(executable, [cli, '--port', String(port)], { cwd: directory, stdio: 'ignore', env: { ...process.env, HOST: '127.0.0.1', XDG_DATA_HOME: directory, CODEALONGAI_TRUEFORGE_LAUNCH_ID: launchId } });
    try {
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      let tokenPublished = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (readFileSync(`/proc/${String(child.pid)}/environ`, 'utf8').includes(`CODEALONGAI_TRUEFORGE_LAUNCH_ID=${launchId}`)) { tokenPublished = true; break; }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(tokenPublished, true);
      assert.equal(readFileSync(`/proc/${String(child.pid)}/cmdline`, 'utf8').split('\0').filter(Boolean).join('|'), [executable, cli, '--port', String(port)].join('|'));
      const record = { ownerPid: -1, ownerStartTime: '0', launchId, executable, cli, port, dataPath: directory, childPid: child.pid! };
      await writeOwnershipLock(lock, { ...record, childPid: undefined });
      assert.equal(await recoverStaleOwnership(lock), true);
      await waitForChildExit(child);
    } finally { if (!childHasExited(child)) child.kill('SIGKILL'); await waitForChildExit(child); await rm(directory, { recursive: true, force: true }); }
  });
  test('cleanup preserves a valid ownership record atomically replaced by another launch', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'codealongai-trueforge-replacement-'));
    const lock = path.join(directory, 'codealongai-trueforge.lock');
    const replacement = JSON.stringify({ launchId: 'launch-b', ownerPid: process.pid, ownerStartTime: '1', executable: process.execPath, cli: 'cli', port: 48123, dataPath: directory });
    try { await writeOwnershipLock(lock, replacement); await releaseOwnershipIfCurrent(lock, 'launch-a'); assert.equal(readFileSync(path.join(lock, 'ownership.json'), 'utf8'), replacement); } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test('serializes duplicate stale recovery so only one contender removes the lock directory', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'codealongai-trueforge-competing-recovery-'));
    const lock = path.join(directory, 'codealongai-trueforge.lock');
    try {
      await writeOwnershipLock(lock, { ownerPid: -1, ownerStartTime: '0', launchId: 'stale-a', executable: process.execPath, cli: require.resolve('@truefoundry/trueforge/dist/cli.js'), port: 48123, dataPath: directory });
      const results = await Promise.all([recoverStaleOwnership(lock), recoverStaleOwnership(lock)]);
      assert.deepEqual(results.sort(), [false, true]);
      assert.equal(existsSync(lock), false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test('duplicate cleanup cannot remove a replacement owner directory', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'codealongai-trueforge-duplicate-cleanup-'));
    const lock = path.join(directory, 'codealongai-trueforge.lock');
    const first = { ownerPid: process.pid, ownerStartTime: '1', launchId: 'launch-a', executable: process.execPath, cli: 'cli', port: 48123, dataPath: directory };
    const replacement = { ...first, launchId: 'launch-b' };
    try {
      await writeOwnershipLock(lock, first);
      await Promise.all([releaseOwnershipIfCurrent(lock, 'launch-a'), releaseOwnershipIfCurrent(lock, 'launch-a')]);
      await writeOwnershipLock(lock, replacement);
      await releaseOwnershipIfCurrent(lock, 'launch-a');
      assert.deepEqual(JSON.parse(readFileSync(path.join(lock, 'ownership.json'), 'utf8')), replacement);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test('cleanup and an ownership update leave either the replacement record or no lock', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'codealongai-trueforge-cleanup-write-'));
    const lock = path.join(directory, 'codealongai-trueforge.lock');
    const first = { ownerPid: process.pid, ownerStartTime: '1', launchId: 'launch-a', executable: process.execPath, cli: 'cli', port: 48123, dataPath: directory };
    const replacement = { ...first, launchId: 'launch-b' };
    try {
      await writeOwnershipLock(lock, first);
      const [writeResult] = await Promise.allSettled([writeOwnership(lock, replacement), releaseOwnershipIfCurrent(lock, 'launch-a')]);
      if (writeResult.status === 'fulfilled') assert.deepEqual(JSON.parse(readFileSync(path.join(lock, 'ownership.json'), 'utf8')), replacement);
      else assert.equal(existsSync(lock), false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test('runs the public Configure TrueForge command through the contract runtime double without changing walkthrough state', async () => {
    const api = await activeWalkthrough();
    const before = api.session;
    assert.equal(api.hasPendingWalkthroughRequest, false);
    commandRuntime.failStart = false;
    await vscode.commands.executeCommand('codealongai.trueforge.configure');
    assert.deepEqual(api.session, before);
    assert.equal(api.hasPendingWalkthroughRequest, false);
    assert.ok(commandRuntime.calls.some((call) => call.startsWith('start:')));
  });
  test('keeps walkthrough state unchanged when public Configure TrueForge setup fails', async () => {
    const api = await activeWalkthrough();
    const before = api.session;
    const callsBeforeFailure = commandRuntime.calls.length;
    commandRuntime.healthy = false;
    commandRuntime.failStart = true;
    await vscode.commands.executeCommand('codealongai.trueforge.configure');
    commandRuntime.failStart = false;
    commandRuntime.healthy = true;
    assert.deepEqual(api.session, before);
    assert.ok(commandRuntime.calls.slice(callsBeforeFailure).some((call) => call.startsWith('start:')));
  });
  test('starts one owned healthy runtime and exposes its loopback setup UI without creating a walkthrough request', async () => {
    const calls: string[] = [];
    let alive = true;
    const runtime: TrueForgeRuntime = {
      producer,
      start: async (options) => { calls.push(`start:${options.port}:${options.dataPath}`); },
      health: async () => alive,
      verifyCapability: async () => alive,
      hasExited: () => false,
      ownsRunningChild: async () => alive,
      open: async (url) => { calls.push(`open:${url}`); },
      stop: async () => { calls.push('stop'); alive = false; }
    };
    const sidecar = new TrueForgeSidecar(runtime, '/storage/trueforge', async () => 48123);
    await sidecar.configure();
    await sidecar.configure();
    assert.deepEqual(calls, ['start:48123:/storage/trueforge', 'open:http://127.0.0.1:48123/', 'open:http://127.0.0.1:48123/']);
    assert.equal(sidecar.url, 'http://127.0.0.1:48123/');
    await sidecar.dispose();
    assert.deepEqual(calls, ['start:48123:/storage/trueforge', 'open:http://127.0.0.1:48123/', 'open:http://127.0.0.1:48123/', 'stop']);
  });

  test('serializes concurrent setup requests and waits for owned cleanup on disposal', async () => {
    const calls: string[] = [];
    let releaseStart: (() => void) | undefined;
    const runtime: TrueForgeRuntime = {
      producer,
      start: async () => { calls.push('start'); await new Promise<void>((resolve) => { releaseStart = resolve; }); },
      health: async () => true, verifyCapability: async () => true, hasExited: () => false, ownsRunningChild: async () => true, open: async () => { calls.push('open'); }, stop: async () => { calls.push('stop'); }
    };
    const sidecar = new TrueForgeSidecar(runtime, '/storage', async () => 48123);
    const first = sidecar.configure();
    const second = sidecar.configure();
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseStart!();
    await Promise.all([first, second]);
    await sidecar.dispose();
    assert.deepEqual(calls, ['start', 'open', 'open', 'stop']);
  });

  test('does not open the UI when the owned sidecar fails its health check', async () => {
    const calls: string[] = [];
    const runtime: TrueForgeRuntime = {
      producer,
      start: async () => { calls.push('start'); throw new Error('crashed'); },
      health: async () => true,
      verifyCapability: async () => true,
      hasExited: () => true,
      ownsRunningChild: async () => false,
      open: async () => { calls.push('open'); },
      stop: async () => { calls.push('stop'); }
    };
    const sidecar = new TrueForgeSidecar(runtime, '/storage/trueforge');
    await assert.rejects(() => sidecar.configure(), /crashed/);
    assert.deepEqual(calls, ['start', 'stop', 'start', 'stop', 'start', 'stop']);
  });

  test('retries a released-port bind failure with a fresh allocation before opening setup', async () => {
    const calls: string[] = [];
    let startCount = 0;
    const runtime: TrueForgeRuntime = {
      producer,
      start: async ({ port }) => { calls.push(`start:${port}`); startCount += 1; },
      health: async () => startCount === 2,
      verifyCapability: async () => startCount === 2,
      hasExited: () => startCount === 1,
      ownsRunningChild: async () => startCount === 2,
      open: async (url) => { calls.push(`open:${url}`); },
      stop: async () => { calls.push('stop'); }
    };
    const ports = [48123, 48124];
    const sidecar = new TrueForgeSidecar(runtime, '/storage', async () => ports.shift()!);
    await sidecar.configure();
    assert.deepEqual(calls, ['start:48123', 'stop', 'start:48124', 'open:http://127.0.0.1:48124/']);
  });

  test('replaces a healthy-looking endpoint when its retained child identity no longer matches', async () => {
    const calls: string[] = [];
    let ownsChild = true;
    const ports = [48123, 48124];
    const runtime: TrueForgeRuntime = {
      producer,
      start: async ({ port }) => { calls.push(`start:${port}`); ownsChild = true; }, health: async () => true, verifyCapability: async () => true,
      hasExited: () => false, ownsRunningChild: async () => ownsChild, open: async (url) => { calls.push(`open:${url}`); }, stop: async () => { calls.push('stop'); }
    };
    const sidecar = new TrueForgeSidecar(runtime, '/storage', async () => ports.shift()!);
    await sidecar.configure();
    ownsChild = false;
    await sidecar.configure();
    assert.deepEqual(calls, ['start:48123', 'open:http://127.0.0.1:48123/', 'stop', 'start:48124', 'open:http://127.0.0.1:48124/']);
  });

  test('maps the complete producer contract through the pinned SDK client seam', async () => {
    const calls: unknown[] = [];
    const abortSignal = new AbortController().signal;
    const requestOptions = { abortSignal, timeoutInSeconds: 7.25 };
    const sdk = new SdkTrueForgeProducerRuntime('http://127.0.0.1:48123/', (baseUrl) => ({
      settings: { modelProviders: { list: async () => { calls.push([baseUrl, 'configured-providers']); return 'providers'; } }, skills: { list: async () => { calls.push('configured-skills'); return 'skills'; } }, sandboxProviders: { get: async () => { calls.push('configured-sandbox'); return 'sandbox'; }, createOrUpdate: async () => 'sandbox' } },
      catalogs: { modelProviders: { list: async () => { calls.push('catalog-providers'); return 'catalog'; } } },
      models: { list: async () => { calls.push('models'); return 'models'; } }, skills: { list: async () => { calls.push('skills'); return 'skills'; } },
      sessions: {
        create: async (input, options) => { calls.push(['create', input, options]); return 'session'; }, createTurn: async (id, input, options) => { calls.push(['turn', id, input, options]); return 'turn'; },
        subscribeToTurn: async (id, turn, request, options) => { calls.push(['events', id, turn, request, options]); return (async function* () { yield 'event'; })(); }, listTurnEvents: async (id, turn, request, options) => { calls.push(['history', id, turn, request, options]); return { data: ['persisted'] }; }, cancel: async (id, request, options) => { calls.push(['cancel', id, request, options]); return undefined; }, delete: async (id, options) => { calls.push(['delete', id, options]); return undefined; }
      }
    }));
    assert.deepEqual(await sdk.discoverConfiguration(), ['providers', 'skills', 'sandbox']);
    assert.equal(await sdk.discoverProviders(), 'catalog'); assert.equal(await sdk.discoverModels(), 'models'); assert.equal(await sdk.discoverSkills(), 'skills');
    assert.equal(await sdk.createSession({ agentId: 'a' }, requestOptions), 'session'); assert.equal(await sdk.runTurn({ sessionId: 's', request: { text: 'x' }, options: requestOptions }), 'turn');
    const events: unknown[] = []; for await (const event of sdk.events('s', 't', 4, requestOptions)) events.push(event);
    assert.deepEqual(await sdk.listTurnEvents('s', 't', requestOptions), ['persisted']);
    await sdk.cancelTurn('s', requestOptions); await sdk.deleteSession('s', requestOptions);
    assert.deepEqual(events, ['event']);
    assert.deepEqual(calls, [['http://127.0.0.1:48123/', 'configured-providers'], 'configured-skills', 'configured-sandbox', 'catalog-providers', 'models', 'skills', ['create', { agentId: 'a' }, requestOptions], ['turn', 's', { text: 'x' }, requestOptions], ['events', 's', 't', { afterSequenceNumber: 4 }, requestOptions], ['history', 's', 't', { order: 'asc', limit: 100 }, requestOptions], ['cancel', 's', undefined, requestOptions], ['delete', 's', requestOptions]]);
  });
  test('preserves pinned SSE numeric ids and resume cursor at the producer boundary', async () => {
    const cursors: (number | undefined)[] = [];
    const sdk = new SdkTrueForgeProducerRuntime('http://127.0.0.1:48123/', () => ({
      settings: { modelProviders: { list: async () => [] }, skills: { list: async () => [] }, sandboxProviders: { get: async () => ({}), createOrUpdate: async () => ({}) } }, catalogs: { modelProviders: { list: async () => [] } }, models: { list: async () => [] }, skills: { list: async () => [] },
      sessions: { create: async () => ({}), createTurn: async () => ({}), subscribeToTurn: async (_s, _t, request) => { cursors.push(request?.afterSequenceNumber); const stream = (async function* () { yield { type: 'turn.done' }; })(); return Object.assign(stream, { withMetadata: async function* () { yield { id: '41', data: { type: 'turn.done' } }; } }); }, cancel: async () => ({}), delete: async () => ({}) }
    }));
    const events: unknown[] = []; for await (const event of sdk.events('session', 'turn', 40)) events.push(event);
    assert.deepEqual(cursors, [40]);
    assert.deepEqual(events, [{ sequenceNumber: 41, event: { type: 'turn.done' } }]);
  });

});

suite('Daytona producer readiness', () => {
  test('maps a safe public probe outcome to the setup action', async () => {
    const lifecycle: string[] = [];
    const readiness = new DaytonaReadiness({
      probeDaytona: async () => ({ provider: 'daytona', phase: 'snapshots', outcome: 'failed' })
    }, {
      open: async () => { lifecycle.push('open'); }
    });

    const failed = await readiness.check();
    assert.deepEqual(failed, { provider: 'daytona', phase: 'snapshots', outcome: 'failed', action: 'open-setup' });
    await readiness.configureOrRetry();
    assert.deepEqual(lifecycle, ['open']);

    const ready = new DaytonaReadiness({ probeDaytona: async () => ({ provider: 'daytona', phase: 'ready', outcome: 'ready' }) }, { open: async () => undefined });
    assert.deepEqual(await ready.check(), { provider: 'daytona', phase: 'ready', outcome: 'ready', action: 'none' });
  });

  test('opens setup safely then rechecks readiness without throwing', async () => {
    let checks = 0;
    const readiness = new DaytonaReadiness({
      probeDaytona: async () => {
        checks += 1;
        return checks === 1
          ? { provider: 'daytona' as const, phase: 'snapshots' as const, outcome: 'failed' as const }
          : { provider: 'daytona' as const, phase: 'ready' as const, outcome: 'ready' as const };
      }
    }, { open: async () => undefined });

    assert.deepEqual(await readiness.configureOrRetry(), { provider: 'daytona', phase: 'snapshots', outcome: 'failed', action: 'open-setup' });
    assert.equal(checks, 1);
    assert.deepEqual(await readiness.configureOrRetry(), { provider: 'daytona', phase: 'ready', outcome: 'ready', action: 'none' });
    assert.equal(checks, 2);

    const unavailable = new DaytonaReadiness({ probeDaytona: async () => ({ provider: 'daytona', phase: 'ready', outcome: 'ready' }) }, { open: async () => { throw new Error('external URI unavailable'); } });
    assert.deepEqual(await unavailable.configureOrRetry(), { provider: 'daytona', phase: 'setup', outcome: 'failed', action: 'open-setup' });
  });

  test('public configuration reports a Daytona permission failure without capturing a walkthrough request', async () => {
    const api = await activeWalkthrough();
    const before = api.session;
    await withMcpEnabled(api, async () => {
      const probesBefore = commandRuntime.probeCalls;
      try {
        commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'snapshots', outcome: 'failed' };
        await vscode.commands.executeCommand('codealongai.trueforge.configure');
        assert.deepEqual(api.session, before);
        assert.equal(api.hasPendingWalkthroughRequest, false);
        assert.equal(commandRuntime.probeCalls, probesBefore + 1);
        commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'ready', outcome: 'ready' };
        await vscode.commands.executeCommand('codealongai.trueforge.configure');
        assert.deepEqual(api.session, before);
        assert.equal(api.hasPendingWalkthroughRequest, false);
        assert.equal(commandRuntime.probeCalls, probesBefore + 2);
      } finally {
        commandRuntime.daytonaProbe = { provider: 'daytona', phase: 'ready', outcome: 'ready' };
      }
    });
  });

  test('proves the disposable public lifecycle and retains only its safe result', async () => {
    const calls: string[] = [];
    const sdk = new SdkTrueForgeProducerRuntime('http://127.0.0.1:48123/', () => ({
      settings: { modelProviders: { list: async () => [] }, skills: { list: async () => [] }, sandboxProviders: { get: async () => ({ data: { manifest: { type: 'daytona' }, status: 'ready' } }), createOrUpdate: async () => { calls.push('refresh'); return ({ data: { manifest: { type: 'daytona' }, status: 'ready' } }); } } },
      catalogs: { modelProviders: { list: async () => [] } }, models: { list: async () => ({ data: [{ name: 'configured-model' }] }) }, skills: { list: async () => [] },
      sessions: {
        create: async (request) => { calls.push(JSON.stringify(request)); return { data: { id: 'probe-session' } }; },
        createTurn: async (id) => { calls.push(`turn:${id}`); return { data: { id: 'probe-turn' } }; }, subscribeToTurn: async () => (async function* () { yield { type: 'sandbox.created' }; })(), cancel: async () => undefined,
        delete: async (id) => { calls.push(`delete:${id}`); return undefined; }
      }
    }));
    assert.deepEqual(await sdk.probeDaytona(), { provider: 'daytona', phase: 'ready', outcome: 'ready' });
    assert.deepEqual(calls.map((call) => call.startsWith('{') ? JSON.parse(call) : call), [
      'refresh',
      { agent: { spec: { model: { name: 'configured-model' }, config: { sandbox: { enabled: true, fileDownloads: false } }, instructions: 'This is a disposable CodeAlongAI readiness probe. Use the supplied sandbox to run the command true exactly once. Do not access files, use MCP, or include workspace, editor, request, or credential data.', messages: [{ type: 'user.message', content: 'Run true in the supplied sandbox once, then reply READY.' }] } } },
      'turn:probe-session', 'delete:probe-session'
    ]);
  });

  test('reports a snapshot permission failure without retaining the runtime error', async () => {
    const calls: string[] = [];
    const sdk = new SdkTrueForgeProducerRuntime('http://127.0.0.1:48123/', () => ({
      settings: { modelProviders: { list: async () => [] }, skills: { list: async () => [] }, sandboxProviders: { get: async () => ({ data: { manifest: { type: 'daytona' }, status: 'ready' } }), createOrUpdate: async () => { throw new Error('sentinel secret is never retained'); } } },
      catalogs: { modelProviders: { list: async () => [] } }, models: { list: async () => ({ data: [{ name: 'configured-model' }] }) }, skills: { list: async () => [] },
      sessions: { create: async () => ({ data: { id: 'probe-session' } }), createTurn: async () => { throw new Error('snapshots permission denied: secret-never-recorded'); }, subscribeToTurn: async () => (async function* () {})(), cancel: async () => undefined, delete: async (id) => { calls.push(id); return undefined; } }
    }));
    assert.deepEqual(await sdk.probeDaytona(), { provider: 'daytona', phase: 'snapshots', outcome: 'failed' });
    assert.deepEqual(calls, []);
  });

  test('reports a public snapshot-build rejection as a safe snapshot phase', async () => {
    const sdk = new SdkTrueForgeProducerRuntime('http://127.0.0.1:48123/', () => ({
      settings: { modelProviders: { list: async () => [] }, skills: { list: async () => [] }, sandboxProviders: { get: async () => ({ data: { manifest: { type: 'daytona' }, status: 'ready' } }), createOrUpdate: async () => { throw { statusCode: 422, message: 'provider payload must stay private' }; } } },
      catalogs: { modelProviders: { list: async () => [] } }, models: { list: async () => ({ data: [] }) }, skills: { list: async () => [] },
      sessions: { create: async () => ({}), createTurn: async () => ({}), subscribeToTurn: async () => (async function* () {})(), cancel: async () => undefined, delete: async () => undefined }
    }));
    assert.deepEqual(await sdk.probeDaytona(), { provider: 'daytona', phase: 'snapshots', outcome: 'failed' });
  });

  test('classifies only standalone public sandbox permission statuses without retaining tool content', async () => {
    const result = await sdkWithProbeEvents([{ type: 'tool.response', content: 'sandbox request failed with 403; sentinel-secret' }]).probeDaytona();
    assert.deepEqual(result, { provider: 'daytona', phase: 'sandboxes', outcome: 'failed' });
    assert.doesNotMatch(JSON.stringify(result), /sentinel-secret/);
  });

  test('keeps a non-permission sandbox tool failure in the creation phase', async () => {
    assert.deepEqual(await sdkWithProbeEvents([{ type: 'tool.response', content: 'sandbox request failed with 500; sentinel-secret' }]).probeDaytona(), { provider: 'daytona', phase: 'sandbox-create', outcome: 'failed' });
  });

  test('does not confuse terminal model authentication with a sandbox permission failure', async () => {
    const result = await sdkWithProbeEvents([{ type: 'turn.done', state: { status: 'error', message: 'model authorization 401; sentinel-secret' } }]).probeDaytona();
    assert.deepEqual(result, { provider: 'daytona', phase: 'sandbox-create', outcome: 'failed' });
    assert.doesNotMatch(JSON.stringify(result), /sentinel-secret/);
  });

  test('retries a residual public cleanup without creating another probe or retaining its opaque identity', async () => {
    let creates = 0;
    let deletes = 0;
    const sdk = new SdkTrueForgeProducerRuntime('http://127.0.0.1:48123/', () => ({
      settings: { modelProviders: { list: async () => [] }, skills: { list: async () => [] }, sandboxProviders: { get: async () => ({ data: { manifest: { type: 'daytona' }, status: 'ready' } }), createOrUpdate: async () => ({ data: { manifest: { type: 'daytona' }, status: 'ready' } }) } },
      catalogs: { modelProviders: { list: async () => [] } }, models: { list: async () => ({ data: [{ name: 'configured-model' }] }) }, skills: { list: async () => [] },
      sessions: { create: async () => { creates += 1; return { data: { id: 'opaque-session-id' } }; }, createTurn: async () => ({ data: { id: 'probe-turn' } }), subscribeToTurn: async () => (async function* () { yield { type: 'sandbox.created' }; })(), cancel: async () => undefined, delete: async () => { deletes += 1; if (deletes === 1) throw new Error('unavailable'); return undefined; } }
    }));
    const residual = await sdk.probeDaytona();
    assert.deepEqual(residual, { provider: 'daytona', phase: 'cleanup', outcome: 'residual' });
    assert.doesNotMatch(JSON.stringify(residual), /opaque-session-id/);
    assert.deepEqual(await sdk.probeDaytona(), { provider: 'daytona', phase: 'ready', outcome: 'ready' });
    assert.deepEqual({ creates, deletes }, { creates: 1, deletes: 2 });
  });

  test('hydrates extension storage in a replacement adapter and clears a residual only after confirmed deletion', async () => {
    let stored: { readonly sessionId: string; readonly result: { readonly provider: 'daytona'; readonly phase: 'ready'; readonly outcome: 'ready' } } | undefined;
    const store = { read: async () => stored, write: async (value: typeof stored) => { stored = value; } };
    let creates = 0;
    let deletes = 0;
    const createClient = () => ({
      settings: { modelProviders: { list: async () => [] }, skills: { list: async () => [] }, sandboxProviders: { get: async () => ({ data: { manifest: { type: 'daytona' }, status: 'ready' } }), createOrUpdate: async () => ({ data: { manifest: { type: 'daytona' }, status: 'ready' } }) } },
      catalogs: { modelProviders: { list: async () => [] } }, models: { list: async () => ({ data: [{ name: 'configured-model' }] }) }, skills: { list: async () => [] },
      sessions: { create: async () => { creates += 1; return { data: { id: 'opaque-session-id' } }; }, createTurn: async () => ({ data: { id: 'probe-turn' } }), subscribeToTurn: async () => (async function* () { yield { type: 'sandbox.created' }; })(), cancel: async () => undefined, delete: async () => { deletes += 1; if (deletes === 1) throw new Error('temporary cleanup failure'); } }
    });
    const first = new SdkTrueForgeProducerRuntime('http://127.0.0.1:48123/', createClient, new DaytonaProbeState(store));
    assert.deepEqual(await first.probeDaytona(), { provider: 'daytona', phase: 'cleanup', outcome: 'residual' });
    assert.deepEqual(stored, { sessionId: 'opaque-session-id', result: { provider: 'daytona', phase: 'ready', outcome: 'ready' } });

    const replacement = new SdkTrueForgeProducerRuntime('http://127.0.0.1:48123/', createClient, new DaytonaProbeState(store));
    assert.deepEqual(await replacement.probeDaytona(), { provider: 'daytona', phase: 'ready', outcome: 'ready' });
    assert.equal(stored, undefined);
    assert.deepEqual({ creates, deletes }, { creates: 1, deletes: 2 });
  });

  test('serializes concurrent readiness probes so a residual cannot be overwritten or lost', async () => {
    let creates = 0;
    let deletes = 0;
    let allowFirstDelete: (() => void) | undefined;
    const firstDelete = new Promise<void>((resolve) => { allowFirstDelete = resolve; });
    const sdk = new SdkTrueForgeProducerRuntime('http://127.0.0.1:48123/', () => ({
      settings: { modelProviders: { list: async () => [] }, skills: { list: async () => [] }, sandboxProviders: { get: async () => ({ data: { manifest: { type: 'daytona' }, status: 'ready' } }), createOrUpdate: async () => ({ data: { manifest: { type: 'daytona' }, status: 'ready' } }) } },
      catalogs: { modelProviders: { list: async () => [] } }, models: { list: async () => ({ data: [{ name: 'configured-model' }] }) }, skills: { list: async () => [] },
      sessions: { create: async () => { creates += 1; return { data: { id: 'opaque-session-id' } }; }, createTurn: async () => ({ data: { id: 'probe-turn' } }), subscribeToTurn: async () => (async function* () { yield { type: 'sandbox.created' }; })(), cancel: async () => undefined, delete: async () => { deletes += 1; if (deletes === 1) { await firstDelete; throw new Error('temporary cleanup failure'); } } }
    }));
    const first = sdk.probeDaytona();
    const second = sdk.probeDaytona();
    await eventually(() => allowFirstDelete, 'the first public cleanup should start');
    allowFirstDelete!();
    assert.deepEqual(await Promise.all([first, second]), [
      { provider: 'daytona', phase: 'cleanup', outcome: 'residual' },
      { provider: 'daytona', phase: 'ready', outcome: 'ready' }
    ]);
    assert.deepEqual({ creates, deletes }, { creates: 1, deletes: 2 });
  });
});

suite('producer readiness', () => {
  test('selector retries the Ask origin only for Retry Setup', async () => {
    let asks = 0; let replies = 0;
    setReadinessActionSelectorForTests(async () => 'Retry Setup');
    await selectReadinessRetryForTests(['Open TrueForge Setup', 'Retry Setup'], async () => { asks += 1; });
    setReadinessActionSelectorForTests(undefined);
    assert.deepEqual({ asks, replies }, { asks: 1, replies: 0 });
  });

  test('selector retries the Reply origin only for Retry TrueForge', async () => {
    let asks = 0; let replies = 0;
    setReadinessActionSelectorForTests(async () => 'Retry TrueForge');
    await selectReadinessRetryForTests(['Retry TrueForge', 'Show CodeAlongAI Output'], async () => { replies += 1; });
    setReadinessActionSelectorForTests(undefined);
    assert.deepEqual({ asks, replies }, { asks: 0, replies: 1 });
  });

  test('a superseded selector cannot invoke the older readiness origin', async () => {
    let oldCalls = 0; let currentCalls = 0;
    let selectOld: ((value: string) => void) | undefined;
    setReadinessActionSelectorForTests(async () => new Promise((resolve) => { selectOld = resolve; }));
    const stale = selectReadinessRetryForTests(['Retry Setup'], async () => { oldCalls += 1; });
    setReadinessActionSelectorForTests(async () => 'Retry TrueForge');
    await selectReadinessRetryForTests(['Retry TrueForge'], async () => { currentCalls += 1; });
    selectOld!('Retry Setup'); await stale; setReadinessActionSelectorForTests(undefined);
    assert.deepEqual({ oldCalls, currentCalls }, { oldCalls: 0, currentCalls: 1 });
  });
  test('runtime double preserves its external producer identity until a replacement is explicit', () => {
    const runtime = new TrueForgeRuntimeDouble();
    const first = runtime.producer;
    assert.equal(runtime.producer, first);
    runtime.replaceProducerForTests();
    assert.notEqual(runtime.producer, first);
  });
  test('serializes concurrent public readiness checks at the retained external-runtime boundary', async () => {
    let active = 0; let maximum = 0; let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const readiness = new ProducerReadiness({ ...emptyTrueForgeProducer, prepareProducer: async () => { active += 1; maximum = Math.max(maximum, active); try { await gate; return { phase: 'ready', outcome: 'ready' as const }; } finally { active -= 1; } } });
    const input = { model: 'openai/gpt-5.2', reasoningEffort: 'medium', mcpUrl: 'http://127.0.0.1:48123/mcp', skillCommit: '1111111111111111111111111111111111111111' };
    const first = readiness.check(input); const second = readiness.check(input); release!();
    assert.deepEqual(await Promise.all([first, second]), [{ phase: 'ready', outcome: 'ready', action: 'none' }, { phase: 'ready', outcome: 'ready', action: 'none' }]);
    assert.equal(maximum, 1);
  });
  test('maps each safe external readiness phase to a bounded operator action', async () => {
    for (const [phase, action] of [
      ['node', 'configure-node'], ['architecture', 'show-output'], ['sidecar', 'retry-trueforge'], ['model', 'open-setup'], ['network', 'retry-trueforge'], ['authentication', 'open-setup'], ['alias', 'open-setup'], ['reasoning', 'open-setup'], ['skill', 'open-setup'], ['connector', 'open-setup'], ['mcp-discovery', 'show-output']
    ] as const) {
      const readiness = new ProducerReadiness({ ...emptyTrueForgeProducer, prepareProducer: async () => ({ phase, outcome: 'failed' }) });
      assert.deepEqual(await readiness.check({ model: 'openai/gpt-5.2', reasoningEffort: 'medium', mcpUrl: 'http://127.0.0.1:48123/mcp', skillCommit: '1111111111111111111111111111111111111111' }), { phase, outcome: 'failed', action });
    }
  });

  test('requires a ready external runtime result before it permits request capture', async () => {
    const readiness = new ProducerReadiness({ ...emptyTrueForgeProducer, prepareProducer: async () => ({ phase: 'ready', outcome: 'ready' }) });
    assert.deepEqual(await readiness.check({ model: 'openai/gpt-5.2', reasoningEffort: 'medium', mcpUrl: 'http://127.0.0.1:48123/mcp', skillCommit: '1111111111111111111111111111111111111111' }), { phase: 'ready', outcome: 'ready', action: 'none' });
  });

  test('requires the exact successful terminal turn contract from the SDK', async () => {
    const input = { model: 'openai/gpt-5.2', reasoningEffort: 'medium', mcpUrl: 'http://127.0.0.1:48123/mcp', skillCommit: '1111111111111111111111111111111111111111' };
    const done = { status: 'done', completedAt: '2026-08-29T18:00:00.000Z', output: { type: 'model.message', id: 'readiness-output', threadId: 'readiness-thread', createdAt: '2026-08-29T18:00:00.000Z', content: 'READY' }, requiredActions: [] };
    const producerWithTerminal = (state: Record<string, unknown>, timer?: { waitFor<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined>; now?(): number }, lifecycle: string[] = [], events?: readonly unknown[]) => new SdkTrueForgeProducerRuntime('http://127.0.0.1:48123/', () => ({
      settings: {
        modelProviders: { list: async () => [] }, sandboxProviders: { get: async () => ({}), createOrUpdate: async () => ({}) },
        skills: { createOrUpdate: async () => ({}), list: async () => ({ data: [{ manifest: { name: 'codealongai', type: 'git', url: 'https://github.com/krishnakartik1/codealongai.git', ref: input.skillCommit, path: 'skills/codealongai' } }] }) },
        mcpServers: { createOrUpdate: async () => ({}) }
      },
      catalogs: { modelProviders: { list: async () => [] } }, skills: { list: async () => [] }, models: { list: async () => ({ data: [{ name: input.model, properties: { reasoningEfforts: [input.reasoningEffort] } }] }) },
      mcpServers: { listTools: async () => ({ data: ['codealongai_get_walkthrough', 'codealongai_get_walkthrough_request', 'codealongai_list_workspace_files', 'codealongai_read_workspace_file', 'codealongai_search_workspace', 'codealongai_start_walkthrough', 'codealongai_replace_walkthrough', 'codealongai_reset_walkthrough', 'codealongai_commit_question_outcome', 'codealongai_navigate_walkthrough'].map((name) => ({ name })) }) },
      sessions: { create: async () => ({ data: { id: 'terminal-contract-session' } }), createTurn: async () => ({ data: { id: 'terminal-contract-turn' } }), subscribeToTurn: async () => (async function* () { yield* events ?? [{ type: 'turn.done', state }]; })(), cancel: async () => { lifecycle.push('cancel'); }, delete: async () => { lifecycle.push('delete'); } }
    }), new DaytonaProbeState(), timer);

    assert.deepEqual(await producerWithTerminal(done).prepareProducer(input), { phase: 'ready', outcome: 'ready' });
    assert.deepEqual(await producerWithTerminal({ ...done, completedAt: undefined }).prepareProducer(input), { phase: 'network', outcome: 'failed' });
    assert.deepEqual(await producerWithTerminal({ ...done, completedAt: 0 }).prepareProducer(input), { phase: 'network', outcome: 'failed' });
    assert.deepEqual(await producerWithTerminal({ ...done, output: {} }).prepareProducer(input), { phase: 'network', outcome: 'failed' });
    assert.deepEqual(await producerWithTerminal({ ...done, output: { ...done.output, type: 'model.message', id: 1 } }).prepareProducer(input), { phase: 'network', outcome: 'failed' });
    assert.deepEqual(await producerWithTerminal({ ...done, output: { ...done.output, content: 'NOT READY' } }).prepareProducer(input), { phase: 'network', outcome: 'failed' });
    assert.deepEqual(await producerWithTerminal({ ...done, output: { ...done.output, content: '' } }).prepareProducer(input), { phase: 'network', outcome: 'failed' });
    assert.deepEqual(await producerWithTerminal({ ...done, output: { ...done.output, refusal: 'I cannot comply' } }).prepareProducer(input), { phase: 'network', outcome: 'failed' });
    assert.deepEqual(await producerWithTerminal({ ...done, requiredActions: undefined }).prepareProducer(input), { phase: 'network', outcome: 'failed' });
    assert.deepEqual(await producerWithTerminal({ ...done, requiredActions: {} }).prepareProducer(input), { phase: 'network', outcome: 'failed' });
    assert.deepEqual(await producerWithTerminal({ ...done, requiredActions: [{ type: 'approval' }] }).prepareProducer(input), { phase: 'network', outcome: 'failed' });
    assert.deepEqual(await producerWithTerminal({ ...done }).prepareProducer({ ...input, model: 'gpt-5.2' }), { phase: 'alias', outcome: 'failed' });
    assert.deepEqual(await producerWithTerminal({ ...done }).prepareProducer({ ...input, model: 'other/gpt-5.2' }), { phase: 'alias', outcome: 'failed' });
    assert.deepEqual(await producerWithTerminal({ ...done }).prepareProducer({ ...input, reasoningEffort: 'high' }), { phase: 'reasoning', outcome: 'failed' });
    assert.deepEqual(await producerWithTerminal({ ...done, status: 'completed' }).prepareProducer(input), { phase: 'network', outcome: 'failed' });
    assert.deepEqual(await producerWithTerminal({ ...done, status: 'paused' }).prepareProducer(input), { phase: 'network', outcome: 'failed' });
    assert.deepEqual(await producerWithTerminal({ ...done, output: null }).prepareProducer(input), { phase: 'network', outcome: 'failed' });
    assert.deepEqual(await producerWithTerminal({ status: 'error', message: 'configured model authorization 401 failed' }).prepareProducer(input), { phase: 'authentication', outcome: 'failed' });
    assert.deepEqual(await producerWithTerminal({ status: 'error', message: 'configured model network timeout' }).prepareProducer(input), { phase: 'network', outcome: 'failed' });
    const lifecycle: string[] = [];
    assert.deepEqual(await producerWithTerminal(done, { waitFor: async () => undefined }, lifecycle).prepareProducer(input), { phase: 'network', outcome: 'failed' });
    assert.deepEqual(lifecycle, ['cancel', 'delete']);
    let now = 0; const budgets: number[] = []; const deadlineLifecycle: string[] = [];
    const timer = { now: () => now, waitFor: async <T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> => { budgets.push(timeoutMs); const next = await operation; now = budgets.length === 1 ? 4_000 : 10_000; return next; } };
    assert.deepEqual(await producerWithTerminal(done, timer, deadlineLifecycle, [{ type: 'progress' }, { type: 'progress' }, { type: 'turn.done', state: done }]).prepareProducer(input), { phase: 'network', outcome: 'failed' });
    assert.deepEqual(budgets, [10_000, 6_000]);
    assert.deepEqual(deadlineLifecycle, ['cancel', 'delete']);
  });

  test('serializes the producer AgentSpec with parallel tool calls disabled in model params', async () => {
    let wireRequest: Record<string, unknown> | undefined;
    const client = new TrueForge({
      baseUrl: 'http://trueforge.test/', auth: false,
      fetch: async (_input, init) => {
        wireRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ data: { id: 'serialization-session' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });

    await client.sessions.create({ agent: { spec: producerAgentSpec({ model: 'openai/gpt-5.2', reasoningEffort: 'medium', mcpUrl: 'http://127.0.0.1:48123/mcp', skillCommit: '1111111111111111111111111111111111111111' }) } });

    assert.deepEqual(wireRequest, {
      agent: {
        spec: {
          model: { name: 'openai/gpt-5.2', params: { reasoning_effort: 'medium', parallel_tool_calls: false } },
          skills: [{ name: 'codealongai' }],
          mcp_servers: [{ name: 'codealongai-mcp' }],
          config: { sandbox: { enabled: true, file_downloads: false } },
          instructions: 'This is a CodeAlongAI producer readiness check. Do not access workspace, editor, source, requests, credentials, or MCP tools.'
        }
      }
    });
  });

  test('classifies mixed terminal browser authentication errors as network failures without retaining or logging their text', async () => {
    const sentinel = 'terminal-error-sentinel-3c65d8';
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => { logs.push(values.map(String).join(' ')); };
    try {
      const result = await new SdkTrueForgeProducerRuntime('http://127.0.0.1:48123/', () => ({
        settings: {
          modelProviders: { list: async () => [] }, sandboxProviders: { get: async () => ({}), createOrUpdate: async () => ({}) },
          skills: { createOrUpdate: async () => ({}), list: async () => ({ data: [{ manifest: { name: 'codealongai', type: 'git', url: 'https://github.com/krishnakartik1/codealongai.git', ref: '1111111111111111111111111111111111111111', path: 'skills/codealongai' } }] }) },
          mcpServers: { createOrUpdate: async () => ({}) }
        },
        catalogs: { modelProviders: { list: async () => [] } }, skills: { list: async () => [] }, models: { list: async () => ({ data: [{ name: 'openai/gpt-5.2', properties: { reasoningEfforts: ['medium'] } }] }) },
        mcpServers: { listTools: async () => ({ data: ['codealongai_get_walkthrough', 'codealongai_get_walkthrough_request', 'codealongai_list_workspace_files', 'codealongai_read_workspace_file', 'codealongai_search_workspace', 'codealongai_start_walkthrough', 'codealongai_replace_walkthrough', 'codealongai_reset_walkthrough', 'codealongai_commit_question_outcome', 'codealongai_navigate_walkthrough'].map((name) => ({ name })) }) },
        sessions: { create: async () => ({ data: { id: 'safe-terminal-session' } }), createTurn: async () => ({ data: { id: 'safe-terminal-turn' } }), subscribeToTurn: async () => (async function* () { yield { type: 'turn.done', state: { status: 'error', message: `authentication endpoint browser fetch failed; ${sentinel}` } }; })(), cancel: async () => undefined, delete: async () => undefined }
      })).prepareProducer({ model: 'openai/gpt-5.2', reasoningEffort: 'medium', mcpUrl: 'http://127.0.0.1:48123/mcp', skillCommit: '1111111111111111111111111111111111111111' });
      assert.deepEqual(result, { phase: 'network', outcome: 'failed' });
      assert.doesNotMatch(JSON.stringify({ result, logs }), new RegExp(sentinel));
    } finally { console.error = originalError; }
  });

  test('reconciles only the named skill and connector then discovers the complete loopback catalog', async () => {
    const calls: unknown[] = [];
    const catalogNames = ['codealongai_get_walkthrough', 'codealongai_get_walkthrough_request', 'codealongai_list_workspace_files', 'codealongai_read_workspace_file', 'codealongai_search_workspace', 'codealongai_start_walkthrough', 'codealongai_replace_walkthrough', 'codealongai_reset_walkthrough', 'codealongai_commit_question_outcome', 'codealongai_navigate_walkthrough'];
    let catalog: unknown = { data: catalogNames.map((name) => ({ name })) };
    const sdk = new SdkTrueForgeProducerRuntime('http://127.0.0.1:48123/', () => ({
      settings: {
        modelProviders: { list: async () => [] }, sandboxProviders: { get: async () => ({}), createOrUpdate: async () => ({}) },
        skills: { sentinel: 'skill', async createOrUpdate(request) { assert.equal((this as unknown as { sentinel: string }).sentinel, 'skill'); calls.push(request); return {}; }, list: async () => ({ data: [{ manifest: { name: 'codealongai', type: 'git', url: 'https://github.com/krishnakartik1/codealongai.git', ref: '1111111111111111111111111111111111111111', path: 'skills/codealongai' } }] }) },
        mcpServers: { sentinel: 'connector', async createOrUpdate(request) { assert.equal((this as unknown as { sentinel: string }).sentinel, 'connector'); calls.push(request); return {}; } }
      },
      catalogs: { modelProviders: { list: async () => [] } }, skills: { list: async () => [] }, models: { list: async () => ({ data: [{ name: 'openai/gpt-5.2', properties: { reasoningEfforts: ['medium'] } }] }) },
      mcpServers: { sentinel: 'catalog', async listTools() { assert.equal((this as unknown as { sentinel: string }).sentinel, 'catalog'); return catalog; } },
      sessions: { create: async (request) => { calls.push(request); return { data: { id: 'safe-readiness-session' } }; }, createTurn: async (id, request) => { calls.push([id, request]); return { data: { id: 'safe-readiness-turn' } }; }, subscribeToTurn: async () => (async function* () { yield { type: 'turn.done', state: { status: 'done', completedAt: '2026-08-29T18:00:00.000Z', output: { type: 'model.message', id: 'readiness-output', threadId: 'readiness-thread', createdAt: '2026-08-29T18:00:00.000Z', content: 'READY' }, requiredActions: [] } }; })(), cancel: async () => undefined, delete: async (id) => { calls.push(`delete:${id}`); return undefined; } }
    }));
    assert.deepEqual(await sdk.prepareProducer({ model: 'openai/gpt-5.2', reasoningEffort: 'medium', mcpUrl: 'http://127.0.0.1:48123/mcp', skillCommit: '1111111111111111111111111111111111111111' }), { phase: 'ready', outcome: 'ready' });
    assert.deepEqual(calls, [
      { manifest: { name: 'codealongai', description: 'Produce one grounded CodeAlongAI walkthrough transition.', type: 'git', url: 'https://github.com/krishnakartik1/codealongai.git', path: 'skills/codealongai', ref: '1111111111111111111111111111111111111111' } },
      { manifest: { name: 'codealongai-mcp', description: 'CodeAlongAI walkthrough MCP endpoint.', type: 'remote', url: 'http://127.0.0.1:48123/mcp' } },
      { agent: { spec: { model: { name: 'openai/gpt-5.2', params: { reasoningEffort: 'medium', parallelToolCalls: false } }, skills: [{ name: 'codealongai' }], mcpServers: [{ name: 'codealongai-mcp' }], config: { sandbox: { enabled: true, fileDownloads: false } }, instructions: 'This is a CodeAlongAI producer readiness check. Do not access workspace, editor, source, requests, credentials, or MCP tools.' } } },
      ['safe-readiness-session', { input: [{ type: 'user.message', content: 'Perform the configured-provider readiness check and reply READY.' }] }], 'delete:safe-readiness-session'
    ]);
    for (const malformed of [
      { data: [...catalogNames.map((name) => ({ name })), {}] },
      { data: [...catalogNames.slice(0, -1).map((name) => ({ name })), null] },
      { data: [...catalogNames.slice(0, -1).map((name) => ({ name })), { name: 7 }] },
      { data: [...catalogNames.slice(0, -1).map((name) => ({ name })), { name: catalogNames[0] }] }
    ]) {
      catalog = malformed;
      assert.deepEqual(await sdk.prepareProducer({ model: 'openai/gpt-5.2', reasoningEffort: 'medium', mcpUrl: 'http://127.0.0.1:48123/mcp', skillCommit: '1111111111111111111111111111111111111111' }), { phase: 'mcp-discovery', outcome: 'failed' });
    }
  });
});

const memorySource = (files: readonly WorkspaceFile[], count = 1): WorkspaceSource => ({ workspaceFolderCount: () => count, listFiles: async () => files.map((file) => file.path), readFile: async (requested) => files.find((file) => file.path.replace(/\\/g, '/') === requested) ?? { path: requested, dirty: false, failure: 'file_unsupported' } });

suite('walkthrough start authority', () => {
  test('publishes the stable walkthrough command, menu, and MCP-setting contract', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { contributes: { commands: { command: string; title: string; icon?: string }[]; menus: { commandPalette: { command: string; when: string }[]; 'comments/commentThread/context': { command: string; when: string; group?: string }[]; 'comments/commentThread/title': { command: string; when: string; group?: string }[] }; configuration: { properties: Record<string, { type: string; default: unknown; scope: string; description: string }> } }; keybindings?: unknown };
    assert.deepEqual(manifest.contributes.commands.filter((item) => item.command !== 'codealongai.walkthrough.submitComment').map(({ command, title }) => ({ command, title })), [
      { command: 'codealongai.walkthrough.ask', title: 'CodeAlongAI: Ask about this code' },
      { command: 'codealongai.trueforge.configure', title: 'CodeAlongAI: Configure TrueForge' },
      { command: 'codealongai.walkthrough.reset', title: 'CodeAlongAI: Reset walkthrough' },
      { command: 'codealongai.walkthrough.back', title: 'CodeAlongAI: Back' },
      { command: 'codealongai.walkthrough.next', title: 'CodeAlongAI: Next' },
      { command: 'codealongai.walkthrough.destinations', title: 'CodeAlongAI: Destinations' }
    ]);
    assert.equal(manifest.keybindings, undefined);
    assert.deepEqual(manifest.contributes.menus.commandPalette, [
      { command: 'codealongai.walkthrough.submitComment', when: 'false' },
      { command: 'codealongai.walkthrough.reset', when: 'false' },
      { command: 'codealongai.walkthrough.back', when: 'false' },
      { command: 'codealongai.walkthrough.next', when: 'false' },
      { command: 'codealongai.walkthrough.destinations', when: 'false' }
    ]);
    assert.deepEqual(manifest.contributes.configuration.properties, {
      'codealongai.mcp.enabled': { type: 'boolean', default: false, scope: 'window', description: 'Enable the local CodeAlongAI MCP endpoint.' },
      'codealongai.trueforge.nodePath': { type: 'string', scope: 'machine', description: 'Optional absolute Node.js executable for the local TrueForge sidecar.' },
      'codealongai.trueforge.model': { type: 'string', scope: 'machine', description: 'Fully qualified TrueForge provider/model selected for CodeAlongAI.' },
      'codealongai.trueforge.reasoningEffort': { type: 'string', scope: 'machine', description: 'Reasoning effort supported by the selected TrueForge model.' }
    });
    assert.ok(manifest.contributes.menus['comments/commentThread/context'].some((item) => item.command === 'codealongai.walkthrough.submitComment' && item.when === 'commentController == codealongai.walkthrough' && item.group === 'inline'));
    assert.ok(manifest.contributes.menus['comments/commentThread/title'].some((item) => item.command === 'codealongai.walkthrough.destinations' && item.when === 'commentThread =~ /codealongaiWalkthrough/ && commentThread =~ /hasDestinations/'));
    assert.deepEqual(manifest.contributes.commands.filter((item) => ['codealongai.walkthrough.back', 'codealongai.walkthrough.next', 'codealongai.walkthrough.destinations', 'codealongai.walkthrough.submitComment'].includes(item.command)).map((item) => item.icon), ['$(send)', '$(arrow-left)', '$(arrow-right)', '$(list-tree)']);
  });

  test('uses native comment context tokens for available navigation actions', () => {
    assert.equal(navigationContext({ id: 'origin', stopId: 'origin', displayName: 'Origin', explanation: '', document: 'checkout.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, destinationIds: ['definition'], recommendedNextId: 'definition', conversation: [] }), 'codealongaiWalkthrough-hasDestinations-hasNext');
    assert.equal(navigationContext({ id: 'terminal', stopId: 'terminal', displayName: 'Terminal', explanation: '', document: 'checkout.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, destinationIds: [], conversation: [] }), 'codealongaiWalkthrough-hasDestinations');
  });

  test('renders every generated stop with its initial CodeAlongAI explanation', () => {
    const stop = { id: 'definition', stopId: 'definition', displayName: 'Definition', explanation: 'This defines the subtotal calculation.', document: 'pricing.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, destinationIds: [], conversation: [] };
    assert.deepEqual(threadComments(stop), [{ author: 'CodeAlongAI', bodyMarkdown: 'This defines the subtotal calculation.' }]);
  });

  test('gives the native reply editor an actionable placeholder', () => {
    assert.equal(commentThreadOptions.placeHolder, 'Type a question (try “Why is this negative?”)');
  });

  test('uses the complete nonblank cursor line when there is no selection', () => {
    assert.deepEqual(deriveOrigin('checkout.ts', {
      start: { line: 2, character: 4 }, end: { line: 2, character: 4 }
    }, '  return subtotal(cart);'), {
      document: 'checkout.ts',
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 24 } }
    });
  });

  test('projects VS Code position coordinates into the MCP range shape', () => {
    const vsCodePosition = (line: number, character: number) => ({
      _line: line,
      _character: character,
      get line() { return this._line; },
      get character() { return this._character; }
    });
    const origin = deriveOrigin('checkout.ts', {
      start: vsCodePosition(2, 3), end: vsCodePosition(2, 8)
    }, 'return subtotal(cart);');

    assert.deepEqual(origin, {
      document: 'checkout.ts',
      range: { start: { line: 2, character: 3 }, end: { line: 2, character: 8 } }
    });
  });

  test('does not derive an origin from a blank cursor line', () => {
    assert.equal(deriveOrigin('checkout.ts', {
      start: { line: 2, character: 0 }, end: { line: 2, character: 0 }
    }, '   '), undefined);
  });

  test('commits only the exact single-use authorized origin', () => {
    const authority = new WalkthroughAuthority();
    const request = authority.captureStart({ document: 'checkout.ts', range: {
      start: { line: 1, character: 0 }, end: { line: 1, character: 3 }
    } });
    const session = authority.start(request.id, {
      ...request.origin, stopId: 'checkout-origin', displayName: 'Origin', explanation: 'What would you like to understand about this code?'
    });
    assert.equal(session.revision, 1);
    assert.equal(session.attentionStopId, 'checkout-origin');
    assert.throws(() => authority.start(request.id, {
      ...request.origin, stopId: 'other', displayName: 'Origin', explanation: 'again'
    }));
  });

  test('retains an immutable pending request until the learner discards it', () => {
    const authority = new WalkthroughAuthority();
    const request = authority.captureStart({ document: 'checkout.ts', range: {
      start: { line: 0, character: 0 }, end: { line: 0, character: 2 }
    } });
    request.origin.document = 'mutated.ts';
    assert.equal(authority.getPendingStart()?.origin.document, 'checkout.ts');
    authority.discardStart();
    assert.equal(authority.getPendingStart(), undefined);
  });

  test('keeps a tentative start private from ordinary session actions until its receipt is acknowledged', () => {
    const authority = new WalkthroughAuthority();
    const origin = { stopId: 'origin', displayName: 'Origin', explanation: 'Start', document: 'checkout.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } };
    const request = authority.captureStart(origin);
    const tentative = authority.startTentative(request.id, origin);
    assert.equal(authority.getSession(), undefined);
    assert.throws(() => authority.captureReplacement(origin));
    assert.throws(() => authority.captureReset());
    assert.throws(() => authority.captureQuestion(origin.stopId, 'Why?'));
    assert.throws(() => authority.navigateDestination({ sessionId: tentative.id, revision: tentative.revision, targetStopId: origin.stopId }));
    const receipt = { schemaVersion: 1 as const, requestId: request.id, sessionId: tentative.id, revision: tentative.revision, attentionStopId: tentative.attentionStopId };
    assert.equal(authority.acknowledgeStartReceipt(receipt), true);
    assert.deepEqual(authority.getSession(), tentative);
  });

  test('keeps a captured question snapshot immutable and refuses a second pending reply', () => {
    const authority = new WalkthroughAuthority();
    const origin = { stopId: 'checkout-origin', displayName: 'Origin', explanation: 'Ask', document: 'checkout.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } };
    const start = authority.captureStart(origin);
    authority.start(start.id, origin);
    const question = authority.captureQuestion(origin.stopId, 'Why?');
    question.snapshot.session.origin.document = 'mutated.ts';
    assert.equal(authority.getQuestionRequest(question.id)?.snapshot.session.origin.document, 'checkout.ts');
    assert.throws(() => authority.captureQuestion(origin.stopId, 'Different question'));
  });
});

suite('walkthrough replacement and reset authority', () => {
  const oldOrigin = { stopId: 'old', displayName: 'Old', explanation: 'Old walkthrough', document: 'checkout.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } };
  const newOrigin = { stopId: 'new', displayName: 'New', explanation: 'New walkthrough', document: 'pricing.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } };
  const startedAuthority = (): WalkthroughAuthority => {
    const authority = new WalkthroughAuthority();
    const start = authority.captureStart(oldOrigin);
    authority.start(start.id, oldOrigin);
    return authority;
  };

  test('replaces a populated walkthrough only after the authorized new origin validates', () => {
    const authority = startedAuthority();
    const question = authority.captureQuestion(oldOrigin.stopId, 'Why?');
    const old = authority.getSession()!;
    const questionReceipt = authority.commitQuestionOutcome({ requestId: question.id, sessionId: old.id, revision: old.revision }, { kind: 'explanation-only', answerMarkdown: 'Because.' });
    authority.acknowledgeQuestionReceipt(questionReceipt);
    const before = authority.getSession()!;
    const request = authority.captureReplacement({ document: newOrigin.document, range: newOrigin.range });
    assert.throws(() => authority.replace(request.id, before.id, before.revision, { ...newOrigin, document: 'wrong.ts' }));
    assert.deepEqual(authority.getSession(), before);
    const receipt = authority.replace(request.id, before.id, before.revision, newOrigin);
    assert.deepEqual(receipt, { schemaVersion: 1, status: 'committed', requestId: request.id, sessionId: authority.getSession()!.id, revision: 1, attentionStopId: 'new' });
    assert.deepEqual(authority.replace(request.id, before.id, before.revision, newOrigin), receipt);
    assert.equal(authority.getSession()!.stops.length, 1);
    assert.notEqual(authority.getSession()!.id, before.id);
  });

  test('resets only the expected revision, is idempotent, and does not reset a later walkthrough', () => {
    const authority = startedAuthority();
    const before = authority.getSession()!;
    const request = authority.captureReset();
    assert.throws(() => authority.reset(request.id, before.id, before.revision + 1));
    assert.deepEqual(authority.getSession(), before);
    const receipt = authority.reset(request.id, before.id, before.revision);
    assert.deepEqual(authority.reset(request.id, before.id, before.revision), receipt);
    assert.equal(authority.getSession(), undefined);
    const replacement = authority.captureStart(newOrigin);
    authority.start(replacement.id, newOrigin);
    assert.throws(() => authority.reset(request.id, before.id, before.revision));
    assert.equal(authority.getSession()!.origin.stopId, newOrigin.stopId);
  });
});

suite('bounded workspace context', () => {
  test('rejects an out-of-bounds line interval distinctly from a bad path', async () => {
    const reader = new WorkspaceReader(memorySource([{ path: 'safe.ts', text: 'safe', dirty: false }]));
    await assert.rejects(() => reader.read({ path: 'safe.ts', startLine: 2, endLine: 3 }), { code: 'range_invalid' });
  });
  test('reads an unsaved buffer by normalized relative path and selected lines', async () => {
    const reader = new WorkspaceReader(memorySource([{ path: 'src\\cart.ts', text: 'first\nsecond\nthird', dirty: true, documentVersion: 7 }]));
    assert.deepEqual(await reader.read({ path: 'src/cart.ts', startLine: 1, endLine: 3 }), { path: 'src/cart.ts', startLine: 1, endLine: 3, text: 'second\nthird', dirty: true, documentVersion: 7 });
  });

  test('uses UTF-16 ordering and literal case-sensitive search previews', async () => {
    const reader = new WorkspaceReader(memorySource([{ path: 'z.ts', text: 'needle', dirty: false }, { path: 'A.ts', text: `${'x'.repeat(100)}needle${'y'.repeat(120)}`, dirty: false }]));
    assert.deepEqual(await reader.list(), ['A.ts', 'z.ts']);
    const [match] = await reader.search('needle');
    assert.equal(match.path, 'A.ts');
    assert.equal(match.range.start.character, 100);
    assert.match(match.preview, /^…/);
    assert.match(match.preview, /…$/);
    assert.equal((await reader.search('NEEDLE')).length, 0);
  });

  test('does not disclose files when the workspace is unavailable or a path traverses it', async () => {
    const reader = new WorkspaceReader(memorySource([{ path: 'secret.ts', text: 'secret', dirty: false }], 0));
    await assert.rejects(() => reader.list(), { code: 'workspace_unavailable' });
    const available = new WorkspaceReader(memorySource([{ path: 'safe.ts', text: 'safe', dirty: false }]));
    await assert.rejects(() => available.read({ path: '../secret.ts' }), { code: 'path_outside_workspace' });
  });
});

suite('receipt-backed start producer turn', () => {
  const acceptExactOriginRead = (reducer: StartTurnReducer): void => {
    reducer.accept({ type: 'model.message', id: 'origin-call', threadId: 'main', createdAt: 'now', toolCalls: [{ id: 'origin', type: 'function', function: { name: 'codealongai_read_workspace_file', arguments: JSON.stringify({ schemaVersion: 1, path: 'checkout.ts', startLine: 2, endLine: 2 }) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] });
    reducer.accept({ type: 'tool.response', id: 'origin-response', threadId: 'main', createdAt: 'now', toolCallId: 'origin', content: JSON.stringify({ structuredContent: { schemaVersion: 1, path: 'checkout.ts', startLine: 2, endLine: 2, text: 'x' } }) });
  };
  const loopbackRuntime = (port: number, requestId: string, onTentative: () => void, releaseResponse: Promise<void>, deliverResponse: boolean): TrueForgeProducerRuntime => {
    const call = (id: string, name: string, args: object, sequenceNumber: number) => ({ sequenceNumber, event: { type: 'model.message', id: `call-${id}`, threadId: 'main', createdAt: 'now', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] } });
    const response = (id: string, result: unknown, sequenceNumber: number) => ({ sequenceNumber, event: { type: 'tool.response', id: `response-${id}`, threadId: 'main', createdAt: 'now', toolCallId: id, content: JSON.stringify(result) } });
    let delivered = false;
    return { ...emptyTrueForgeProducer, createSession: async () => ({ id: 'session' }), runTurn: async () => ({ id: 'turn' }), events: async function* () {
      if (delivered) return; delivered = true;
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
      const client = new Client({ name: 'receipt lifecycle test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(transport);
      try {
        yield call('authority', 'codealongai_get_walkthrough_request', { schemaVersion: 1, requestId }, 1);
        const authority = await client.callTool({ name: 'codealongai_get_walkthrough_request', arguments: { schemaVersion: 1, requestId } });
        yield response('authority', authority, 2);
        const origin = (authority.structuredContent as { input: { origin: { path: string; range: { start: { line: number }; end: { line: number; character: number } } } } }).input.origin;
        const endLine = origin.range.end.character === 0 ? origin.range.end.line : origin.range.end.line + 1;
        yield call('origin', 'codealongai_read_workspace_file', { schemaVersion: 1, path: origin.path, startLine: origin.range.start.line, endLine }, 3);
        const read = await client.callTool({ name: 'codealongai_read_workspace_file', arguments: { schemaVersion: 1, path: origin.path, startLine: origin.range.start.line, endLine } });
        yield response('origin', read, 4);
        const start = { schemaVersion: 1, requestId, origin: { stopId: 'origin', displayName: 'Origin', explanation: 'Start', document: origin.path, range: origin.range } };
        yield call('start', 'codealongai_start_walkthrough', start, 5);
        const receipt = await client.callTool({ name: 'codealongai_start_walkthrough', arguments: start });
        onTentative(); await releaseResponse;
        if (deliverResponse) { yield response('start', receipt, 6); yield { type: 'turn.done', id: 'done', threadId: 'main', state: { status: 'done' } }; }
      } finally { await transport.close(); }
    } };
  };
  const loopbackStart = (): { authority: WalkthroughAuthority; request: ReturnType<WalkthroughAuthority['captureStart']>; endpoint: LoopbackMcpEndpoint } => {
    const authority = new WalkthroughAuthority();
    const origin = { stopId: 'origin', displayName: 'Origin', explanation: 'Start', document: 'checkout.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } };
    const request = authority.captureStart(origin);
    return { authority, request, endpoint: new LoopbackMcpEndpoint(authority, memorySource([{ path: 'checkout.ts', text: 'const', dirty: false }])) };
  };
  const loopbackQuestion = (): { authority: WalkthroughAuthority; request: ReturnType<WalkthroughAuthority['captureQuestion']>; before: WalkthroughSession; endpoint: LoopbackMcpEndpoint } => {
    const authority = new WalkthroughAuthority();
    const origin = { stopId: 'origin', displayName: 'Origin', explanation: 'Start', document: 'checkout.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } };
    const start = authority.captureStart(origin);
    authority.start(start.id, origin);
    const before = authority.getSession()!;
    const request = authority.captureQuestion(origin.stopId, 'Why this code?');
    return { authority, request, before, endpoint: new LoopbackMcpEndpoint(authority, memorySource([{ path: 'checkout.ts', text: 'const', dirty: false }])) };
  };
  const loopbackQuestionRuntime = (port: number, requestId: string, onTentative: () => void, releaseResponse: Promise<void>, deliverResponse: boolean, cleanupFails = false): TrueForgeProducerRuntime => {
    const call = (id: string, name: string, args: object, sequenceNumber: number) => ({ sequenceNumber, event: { type: 'model.message', id: `question-call-${id}`, threadId: 'main', createdAt: 'now', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] } });
    const response = (id: string, result: unknown, sequenceNumber: number) => ({ sequenceNumber, event: { type: 'tool.response', id: `question-response-${id}`, threadId: 'main', createdAt: 'now', toolCallId: id, content: JSON.stringify(result) } });
    let delivered = false;
    return {
      ...emptyTrueForgeProducer,
      createSession: async () => ({ id: 'question-session' }),
      runTurn: async () => ({ id: 'question-turn' }),
      cancelTurn: async () => { if (cleanupFails) throw new Error('cleanup failed'); },
      deleteSession: async () => { if (cleanupFails) throw new Error('delete failed'); },
      events: async function* () {
        if (delivered) return; delivered = true;
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
        const client = new Client({ name: 'question receipt lifecycle test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(transport);
        try {
          yield call('authority', 'codealongai_get_walkthrough_request', { schemaVersion: 1, requestId }, 1);
          const authorized = await client.callTool({ name: 'codealongai_get_walkthrough_request', arguments: { schemaVersion: 1, requestId } });
          yield response('authority', authorized, 2);
          yield call('walkthrough', 'codealongai_get_walkthrough', {}, 3);
          const walkthrough = await client.callTool({ name: 'codealongai_get_walkthrough', arguments: {} });
          yield response('walkthrough', walkthrough, 4);
          const input = (authorized.structuredContent as { input: { sessionId: string; revision: number } }).input;
          const commit = { schemaVersion: 1, requestId, expectedSessionId: input.sessionId, expectedRevision: input.revision, outcome: { kind: 'explanation-only' as const, answerMarkdown: 'Because it is the source.' } };
          yield call('commit', 'codealongai_commit_question_outcome', commit, 5);
          const receipt = await client.callTool({ name: 'codealongai_commit_question_outcome', arguments: commit });
          onTentative(); await releaseResponse;
          if (deliverResponse) { yield response('commit', receipt, 6); yield { type: 'turn.done', id: 'question-done', threadId: 'main', state: { status: 'done' } }; }
        } finally { await transport.close(); }
      }
    };
  };
  test('returns the cached start receipt for an identical real MCP retry and conflicts on changed input', async () => {
    const { authority, request, endpoint } = loopbackStart();
    await endpoint.start(0);
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp`));
    const client = new Client({ name: 'start retry test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    const input = { schemaVersion: 1 as const, requestId: request.id, origin: { stopId: 'origin', displayName: 'Origin', explanation: 'Start', document: 'checkout.ts', range: request.origin.range } };
    try {
      await client.connect(transport);
      const first = await client.callTool({ name: 'codealongai_start_walkthrough', arguments: input });
      const second = await client.callTool({ name: 'codealongai_start_walkthrough', arguments: input });
      assert.deepEqual(second.structuredContent, first.structuredContent);
      assert.equal(authority.getSession(), undefined);
      assert.equal(authority.acknowledgeStartReceipt(first.structuredContent as StartReceipt), true);
      const session = authority.getSession()!;
      authority.navigateDestination({ sessionId: session.id, revision: session.revision, targetStopId: 'origin' });
      const acceptedRetry = await client.callTool({ name: 'codealongai_start_walkthrough', arguments: input });
      assert.deepEqual(acceptedRetry.structuredContent, first.structuredContent);
      const conflict = await client.callTool({ name: 'codealongai_start_walkthrough', arguments: { ...input, origin: { ...input.origin, explanation: 'Different' } } });
      assert.equal(conflict.isError, true);
    } finally { await transport.close(); await endpoint.stop(); }
  });
  test('rolls back a real loopback start whose committed response is lost', async () => {
    const { authority, request, endpoint } = loopbackStart();
    let tentative: (() => void) | undefined; const tentativeSeen = new Promise<void>((resolve) => { tentative = resolve; });
    await endpoint.start(0);
    try {
      const runtime = loopbackRuntime(endpoint.port!, request.id, () => tentative!(), Promise.resolve(), false);
      const result = await new ReceiptBackedStartCoordinator(runtime, 100, async () => undefined).start({ requestId: request.id, model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused', acceptReceipt: (receipt) => authority.acknowledgeStartReceipt(receipt), rollbackTentativeStart: () => authority.rollbackTentativeStart() });
      await tentativeSeen;
      assert.deepEqual(result, { status: 'failed', diagnostic: 'missing_receipt' });
      assert.equal(authority.getSession(), undefined);
      assert.deepEqual(authority.getPendingStart(), request);
    } finally { await endpoint.stop(); }
  });
  test('rolls back the exact pre-question session when a real loopback committed response is lost', async () => {
    const { authority, request, before, endpoint } = loopbackQuestion();
    let tentative: (() => void) | undefined; const tentativeSeen = new Promise<void>((resolve) => { tentative = resolve; });
    await endpoint.start(0);
    try {
      const runtime = loopbackQuestionRuntime(endpoint.port!, request.id, () => tentative!(), Promise.resolve(), false);
      const result = await new ReceiptBackedStartCoordinator(runtime, 100, async () => undefined).start({ kind: 'question', requestId: request.id, model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused', acceptReceipt: (receipt) => authority.acknowledgeQuestionReceipt(receipt as import('../walkthrough').QuestionReceipt), rollbackTentativeQuestion: () => authority.rollbackTentativeQuestion() });
      await tentativeSeen;
      assert.deepEqual(result, { status: 'failed', diagnostic: 'missing_receipt' });
      assert.deepEqual(authority.getSession(), before);
      assert.deepEqual(authority.getPendingQuestion(), request);
    } finally { await endpoint.stop(); }
  });
  test('does not roll back newer navigation state after a real loopback question response is lost', async () => {
    const { authority, request, endpoint } = loopbackQuestion();
    let tentative: (() => void) | undefined; const tentativeSeen = new Promise<void>((resolve) => { tentative = resolve; });
    await endpoint.start(0);
    try {
      const runtime = loopbackQuestionRuntime(endpoint.port!, request.id, () => tentative!(), Promise.resolve(), false);
      const operation = new ReceiptBackedStartCoordinator(runtime, 100, async () => undefined).start({ kind: 'question', requestId: request.id, model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused', acceptReceipt: (receipt) => authority.acknowledgeQuestionReceipt(receipt as import('../walkthrough').QuestionReceipt), rollbackTentativeQuestion: () => authority.rollbackTentativeQuestion() });
      await tentativeSeen;
      const committed = authority.getSession()!;
      authority.navigateDestination({ sessionId: committed.id, revision: committed.revision, targetStopId: 'origin' });
      const newer = authority.getSession()!;
      assert.deepEqual(await operation, { status: 'failed', diagnostic: 'missing_receipt' });
      assert.deepEqual(authority.getSession(), newer);
      assert.deepEqual(authority.getPendingQuestion(), request);
      const retryReceipt = authority.commitQuestionOutcome({ requestId: request.id, sessionId: newer.id, revision: newer.revision }, { kind: 'explanation-only', answerMarkdown: 'Because it is the source.' });
      assert.equal(authority.acknowledgeQuestionReceipt(retryReceipt), true);
      assert.equal(authority.getSession()!.revision, newer.revision + 1);
    } finally { await endpoint.stop(); }
  });
  test('cancels a real loopback committed question before its response and ignores the late response', async () => {
    const { authority, request, before, endpoint } = loopbackQuestion();
    let tentative: (() => void) | undefined; const tentativeSeen = new Promise<void>((resolve) => { tentative = resolve; });
    let release: (() => void) | undefined; const responseGate = new Promise<void>((resolve) => { release = resolve; });
    await endpoint.start(0);
    try {
      const runtime = loopbackQuestionRuntime(endpoint.port!, request.id, () => tentative!(), responseGate, true);
      const coordinator = new ReceiptBackedStartCoordinator(runtime, 100, async () => undefined);
      const operation = coordinator.start({ kind: 'question', requestId: request.id, model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused', acceptReceipt: (receipt) => authority.acknowledgeQuestionReceipt(receipt as import('../walkthrough').QuestionReceipt), rollbackTentativeQuestion: () => authority.rollbackTentativeQuestion() });
      await tentativeSeen;
      coordinator.cancel();
      release!();
      assert.deepEqual(await operation, { status: 'failed', diagnostic: 'cancelled' });
      await coordinator.settled;
      assert.deepEqual(authority.getSession(), before);
      assert.deepEqual(authority.getPendingQuestion(), request);
    } finally { release?.(); await endpoint.stop(); }
  });
  test('finalizes an accepted real loopback question receipt despite later cancellation and cleanup failure', async () => {
    const { authority, request, endpoint } = loopbackQuestion();
    await endpoint.start(0);
    try {
      const runtime = loopbackQuestionRuntime(endpoint.port!, request.id, () => undefined, Promise.resolve(), true, true);
      const coordinator = new ReceiptBackedStartCoordinator(runtime, 100, async () => undefined);
      const result = await coordinator.start({ kind: 'question', requestId: request.id, model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused', acceptReceipt: (receipt) => authority.acknowledgeQuestionReceipt(receipt as import('../walkthrough').QuestionReceipt), rollbackTentativeQuestion: () => authority.rollbackTentativeQuestion() });
      assert.equal(result.status, 'committed');
      const accepted = authority.getSession()!;
      coordinator.cancel();
      await coordinator.settled;
      assert.equal(authority.rollbackTentativeQuestion(), false);
      assert.deepEqual(authority.getSession(), accepted);
      assert.equal(authority.getPendingQuestion(), undefined);
    } finally { await endpoint.stop(); }
  });
  test('cancels a real loopback tentative start and ignores its late response', async () => {
    const { authority, request, endpoint } = loopbackStart();
    let tentative: (() => void) | undefined; const tentativeSeen = new Promise<void>((resolve) => { tentative = resolve; });
    let release: (() => void) | undefined; const responseGate = new Promise<void>((resolve) => { release = resolve; });
    await endpoint.start(0);
    try {
      const runtime = loopbackRuntime(endpoint.port!, request.id, () => tentative!(), responseGate, true);
      const coordinator = new ReceiptBackedStartCoordinator(runtime, 100, async () => undefined);
      const operation = coordinator.start({ requestId: request.id, model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused', acceptReceipt: (receipt) => authority.acknowledgeStartReceipt(receipt), rollbackTentativeStart: () => authority.rollbackTentativeStart() });
      await tentativeSeen;
      assert.equal(authority.getSession(), undefined, 'the loopback start must stay private before its response');
      coordinator.cancel();
      release!();
      assert.deepEqual(await operation, { status: 'failed', diagnostic: 'cancelled' });
      await coordinator.settled;
      assert.equal(authority.getSession(), undefined);
      assert.deepEqual(authority.getPendingStart(), request);
    } finally { release?.(); await endpoint.stop(); }
  });
  test('finalizes an accepted real loopback receipt and makes later rollback inert', async () => {
    const { authority, request, endpoint } = loopbackStart();
    await endpoint.start(0);
    try {
      const runtime = loopbackRuntime(endpoint.port!, request.id, () => undefined, Promise.resolve(), true);
      const coordinator = new ReceiptBackedStartCoordinator(runtime, 100, async () => undefined);
      const result = await coordinator.start({ requestId: request.id, model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused', acceptReceipt: (receipt) => authority.acknowledgeStartReceipt(receipt), rollbackTentativeStart: () => authority.rollbackTentativeStart() });
      assert.equal(result.status, 'committed');
      const session = authority.getSession();
      assert.ok(session);
      assert.equal(authority.rollbackTentativeStart(), false);
      assert.deepEqual(authority.getSession(), session);
    } finally { await endpoint.stop(); }
  });
  test('finalizes only a matching tentative receipt and rolls back no newer state', () => {
    const authority = new WalkthroughAuthority();
    const origin = { stopId: 'origin', displayName: 'Origin', explanation: 'Start', document: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } } };
    const request = authority.captureStart(origin);
    const session = authority.startTentative(request.id, origin)!;
    const receipt = { schemaVersion: 1 as const, requestId: request.id, sessionId: session.id, revision: session.revision, attentionStopId: session.attentionStopId };
    assert.equal(authority.acknowledgeStartReceipt({ ...receipt, revision: 99 }), false);
    assert.equal(authority.getSession(), undefined);
    assert.equal(authority.rollbackTentativeStart(), true);
    assert.equal(authority.getSession(), undefined);
    assert.deepEqual(authority.getPendingStart(), request);
    const retry = authority.startTentative(request.id, origin)!;
    const accepted = { ...receipt, sessionId: retry.id, revision: retry.revision, attentionStopId: retry.attentionStopId };
    assert.equal(authority.acknowledgeStartReceipt(accepted), true);
    assert.equal(authority.rollbackTentativeStart(accepted), false);
    assert.deepEqual(authority.getSession(), retry);
  });
  test('dedupes one request, rejects a different request as busy, and cancels on disposal', async () => {
    let cancelCalls = 0;
    const pending = new Promise<never>(() => undefined);
    let started: (() => void) | undefined; const startedSession = new Promise<void>((resolve) => { started = resolve; });
    const runtime: TrueForgeProducerRuntime = { ...emptyTrueForgeProducer, createSession: async () => { started!(); return { id: 'session' }; }, runTurn: async () => ({ id: 'turn' }), events: async function* (_s, _t, _after, options) { await Promise.race([pending, waitForAbort(options?.abortSignal)]); }, cancelTurn: async () => { cancelCalls += 1; } };
    const owner = new StartTurnOwner(); const input = { requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused' };
    assert.equal(owner.start(runtime, input), owner.start(runtime, input));
    assert.deepEqual(await owner.start(runtime, { ...input, requestId: 'request-2' }), { status: 'failed', diagnostic: 'start_busy' });
    await startedSession; await new Promise<void>((resolve) => setImmediate(resolve)); await owner.dispose();
    assert.equal(cancelCalls, 1);
  });
  test('holds ownership across cancellation until cleanup, then uses a replacement producer', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let aSessions = 0; let bSessions = 0; let cancelled = 0;
    const runtimeA: TrueForgeProducerRuntime = { ...emptyTrueForgeProducer, createSession: async () => { aSessions += 1; return { id: 'a-session' }; }, runTurn: async () => ({ id: 'a-turn' }), events: async function* () { await held; yield { type: 'turn.done', id: 'a-done', state: { status: 'done' } }; }, cancelTurn: async () => { cancelled += 1; } };
    const runtimeB: TrueForgeProducerRuntime = { ...emptyTrueForgeProducer, createSession: async () => { bSessions += 1; return { id: 'b-session' }; }, runTurn: async () => ({ id: 'b-turn' }), events: async function* () { yield { type: 'turn.done', id: 'b-done', state: { status: 'done' } }; } };
    const owner = new StartTurnOwner(); const input = { requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused' };
    const first = owner.start(runtimeA, input);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await owner.cancel();
    assert.deepEqual(await owner.start(runtimeB, { ...input, requestId: 'request-2' }), { status: 'failed', diagnostic: 'start_busy' });
    assert.equal(aSessions, 1); assert.equal(bSessions, 0); await eventually(() => cancelled === 1 ? true : undefined, 'native cancellation should begin');
    release!();
    await first;
    await eventually(() => owner.activeRequestId === undefined ? true : undefined, 'cleanup ownership should release after the stream settles');
    await owner.start(runtimeB, { ...input, requestId: 'request-2' });
    assert.equal(bSessions, 1);
  });
  test('retains a cancelled creating session until it is deleted before shutdown', async () => {
    let resolveSession: ((value: { id: string }) => void) | undefined;
    let turns = 0; const deleted: string[] = []; let createOptions: import('../trueforge-contract').TrueForgeRequestOptions | undefined;
    const runtime: TrueForgeProducerRuntime = { ...emptyTrueForgeProducer, createSession: async (_request, options) => { createOptions = options; return new Promise<{ id: string }>((resolve) => { resolveSession = resolve; }); }, runTurn: async () => { turns += 1; return { id: 'turn' }; }, deleteSession: async (id) => { deleted.push(id); } };
    const owner = new StartTurnOwner();
    const operation = owner.start(runtime, { requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused' });
    await eventually(() => resolveSession ? true : undefined, 'session creation should begin');
    await owner.cancel();
    assert.deepEqual(await operation, { status: 'failed', diagnostic: 'cancelled' });
    assert.equal(createOptions?.timeoutInSeconds, 180);
    assert.equal(createOptions?.abortSignal?.aborted, true);
    const disposing = owner.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(owner.activeRequestId, 'request-1');
    resolveSession!({ id: 'late-session' });
    await disposing;
    await eventually(() => deleted.length === 1 ? true : undefined, 'a late session must be deleted after cancellation');
    assert.deepEqual(deleted, ['late-session']);
    assert.equal(turns, 0);
    assert.equal(owner.activeRequestId, undefined);
  });
  test('waits for the one native cancellation before deletion and runtime shutdown', async () => {
    const calls: string[] = [];
    const never = new Promise<never>(() => undefined);
    let entered: (() => void) | undefined; const enteredEvents = new Promise<void>((resolve) => { entered = resolve; });
    let resolveCancel: (() => void) | undefined;
    const nativeCancel = new Promise<void>((resolve) => { resolveCancel = resolve; });
    const runtime: TrueForgeProducerRuntime = { ...emptyTrueForgeProducer, createSession: async () => ({ id: 'session' }), runTurn: async () => ({ id: 'turn' }), events: async function* (_s, _t, _after, options) { entered!(); await Promise.race([never, waitForAbort(options?.abortSignal)]); }, cancelTurn: async () => { calls.push('cancel'); await nativeCancel; }, deleteSession: async () => { calls.push('delete'); } };
    const owner = new StartTurnOwner();
    owner.start(runtime, { requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused' });
    await eventually(() => owner.activeRequestId === 'request-1' ? true : undefined, 'the owner should retain the active turn');
    await enteredEvents;
    const disposing = owner.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['cancel']);
    assert.equal(owner.activeRequestId, 'request-1');
    calls.push('runtime-shutdown-attempt');
    assert.deepEqual(calls, ['cancel', 'runtime-shutdown-attempt']);
    resolveCancel!();
    await disposing;
    assert.equal(owner.activeRequestId, undefined);
    calls.push('runtime-shutdown');
    assert.deepEqual(calls, ['cancel', 'runtime-shutdown-attempt', 'delete', 'runtime-shutdown']);
  });
  test('uses a teardown window after the request deadline before deleting', async () => {
    const calls: string[] = [];
    let releaseCancel: (() => void) | undefined; const cancelHeld = new Promise<void>((resolve) => { releaseCancel = resolve; });
    let enteredCancel: (() => void) | undefined; const cancelEntered = new Promise<void>((resolve) => { enteredCancel = resolve; });
    const runtime: TrueForgeProducerRuntime = { ...emptyTrueForgeProducer, createSession: async () => ({ id: 'session' }), runTurn: async () => ({ id: 'turn' }), events: async function* (_s, _t, _after, options) { await waitForAbort(options?.abortSignal); }, cancelTurn: async (_id, options) => { calls.push(`cancel:${String(options?.abortSignal?.aborted)}`); enteredCancel!(); await cancelHeld; }, deleteSession: async (_id, options) => { calls.push(`delete:${String(options?.abortSignal?.aborted)}`); } };
    const operation = new ReceiptBackedStartCoordinator(runtime, 5, async () => undefined, 100).start({ requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused' });
    await cancelEntered;
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseCancel!();
    assert.deepEqual(await operation, { status: 'failed', diagnostic: 'deadline_exceeded' });
    assert.deepEqual(calls, ['cancel:false', 'delete:false']);
  });
  test('passes the configured teardown timeout and one signal to cancel and delete', async () => {
    const options: { readonly abortSignal?: AbortSignal; readonly timeoutInSeconds?: number }[] = [];
    const runtime: TrueForgeProducerRuntime = { ...emptyTrueForgeProducer, createSession: async () => ({ id: 'session' }), runTurn: async () => ({ id: 'turn' }), events: async function* (_s, _t, _after, requestOptions) { await waitForAbort(requestOptions?.abortSignal); }, cancelTurn: async (_id, requestOptions) => { options.push(requestOptions ?? {}); }, deleteSession: async (_id, requestOptions) => { options.push(requestOptions ?? {}); } };
    await new ReceiptBackedStartCoordinator(runtime, 5, async () => undefined, 123).start({ requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused' });
    assert.equal(options.length, 2);
    assert.equal(options[0].timeoutInSeconds, 0.123);
    assert.equal(options[1].timeoutInSeconds, 0.123);
    assert.equal(options[0].abortSignal, options[1].abortSignal);
    assert.equal(options[0].abortSignal?.aborted, false);
  });
  test('aborts a stalled native cancellation before owner disposal releases runtime shutdown', async () => {
    const calls: string[] = [];
    let entered: (() => void) | undefined; const enteredEvents = new Promise<void>((resolve) => { entered = resolve; });
    const runtime: TrueForgeProducerRuntime = { ...emptyTrueForgeProducer, createSession: async () => ({ id: 'session' }), runTurn: async () => ({ id: 'turn' }), events: async function* (_s, _t, _after, options) { entered!(); await waitForAbort(options?.abortSignal); }, cancelTurn: async (_id, options) => new Promise<void>((_resolve, reject) => { calls.push('cancel'); options?.abortSignal?.addEventListener('abort', () => { calls.push('cancel-aborted'); reject(new Error('aborted')); }, { once: true }); }), deleteSession: async () => { calls.push('delete'); } };
    const owner = new StartTurnOwner((activeRuntime) => new ReceiptBackedStartCoordinator(activeRuntime, 100_000, async () => undefined, 5));
    const operation = owner.start(runtime, { requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused' });
    await enteredEvents;
    await owner.dispose();
    assert.deepEqual(await operation, { status: 'failed', diagnostic: 'cancelled' });
    assert.equal(owner.activeRequestId, undefined);
    calls.push('runtime-shutdown');
    assert.deepEqual(calls, ['cancel', 'cancel-aborted', 'runtime-shutdown']);
  });
  test('aborts a stalled deletion before owner disposal releases runtime shutdown', async () => {
    const calls: string[] = [];
    let entered: (() => void) | undefined; const enteredEvents = new Promise<void>((resolve) => { entered = resolve; });
    const runtime: TrueForgeProducerRuntime = { ...emptyTrueForgeProducer, createSession: async () => ({ id: 'session' }), runTurn: async () => ({ id: 'turn' }), events: async function* (_s, _t, _after, options) { entered!(); await waitForAbort(options?.abortSignal); }, cancelTurn: async () => { calls.push('cancel'); }, deleteSession: async (_id, options) => new Promise<void>((_resolve, reject) => { calls.push('delete'); options?.abortSignal?.addEventListener('abort', () => { calls.push('delete-aborted'); reject(new Error('aborted')); }, { once: true }); }) };
    const owner = new StartTurnOwner((activeRuntime) => new ReceiptBackedStartCoordinator(activeRuntime, 100_000, async () => undefined, 5));
    const operation = owner.start(runtime, { requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused' });
    await enteredEvents;
    await owner.dispose();
    assert.deepEqual(await operation, { status: 'failed', diagnostic: 'cancelled' });
    assert.equal(owner.activeRequestId, undefined);
    calls.push('runtime-shutdown');
    assert.deepEqual(calls, ['cancel', 'delete', 'delete-aborted', 'runtime-shutdown']);
  });
  test('disables pinned SDK request retries and stream reconnects at client construction', () => {
    assert.deepEqual(trueForgeClientOptions('http://127.0.0.1:1234'), { baseUrl: 'http://127.0.0.1:1234', maxRetries: 0, stream: { reconnectionEnabled: false, maxReconnectionAttempts: 0 } });
  });
  test('accepts only a correlated start receipt after matching request authority', () => {
    const reducer = new StartTurnReducer('request-1');
    reducer.accept({ type: 'model.message', id: 'call-1', threadId: 'main', createdAt: 'now', toolCalls: [{ id: 'authority', type: 'function', function: { name: 'codealongai_get_walkthrough_request', arguments: JSON.stringify({ requestId: 'request-1' }) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] });
    reducer.accept({ type: 'tool.response', id: 'authority-result', threadId: 'main', createdAt: 'now', toolCallId: 'authority', content: JSON.stringify({ schemaVersion: 1, requestId: 'request-1', kind: 'start', authorizedAction: 'start', status: 'pending', input: { origin: { path: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } } } } }) });
    acceptExactOriginRead(reducer);
    reducer.accept({ type: 'model.message', id: 'call-2', threadId: 'main', createdAt: 'now', toolCalls: [{ id: 'start', type: 'function', function: { name: 'codealongai_start_walkthrough', arguments: JSON.stringify({ requestId: 'request-1' }) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] });
    reducer.accept({ type: 'tool.response', id: 'response-start', threadId: 'main', createdAt: 'now', toolCallId: 'start', content: JSON.stringify({ schemaVersion: 1, requestId: 'request-1', sessionId: 'session', revision: 1, attentionStopId: 'origin' }) });
    assert.deepEqual(reducer.result, { status: 'committed', receipt: { schemaVersion: 1, requestId: 'request-1', sessionId: 'session', revision: 1, attentionStopId: 'origin' } });
  });

  test('rejects actionable events without the pinned main-thread identity', () => {
    const missing = new StartTurnReducer('request-1');
    missing.accept({ type: 'model.message', threadId: 'main', toolCalls: [] });
    assert.deepEqual(missing.result, { status: 'failed', diagnostic: 'tool_provenance' });
    const foreign = new StartTurnReducer('request-1');
    foreign.accept({ type: 'model.message', id: 'call', threadId: 'main', toolCalls: [{ id: 'authority', type: 'function', function: { name: 'codealongai_get_walkthrough_request', arguments: JSON.stringify({ requestId: 'request-1' }) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] });
    foreign.accept({ type: 'tool.response', id: 'response', threadId: 'other', toolCallId: 'authority', content: '{}' });
    assert.deepEqual(foreign.result, { status: 'failed', diagnostic: 'tool_provenance' });
  });

  test('requires the exact public origin read schema before transition', () => {
    const reducer = new StartTurnReducer('request-1');
    reducer.accept({ type: 'model.message', id: 'authority', threadId: 'main', toolCalls: [{ id: 'authority', type: 'function', function: { name: 'codealongai_get_walkthrough_request', arguments: JSON.stringify({ requestId: 'request-1' }) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] });
    reducer.accept({ type: 'tool.response', id: 'authority-response', threadId: 'main', toolCallId: 'authority', content: JSON.stringify({ schemaVersion: 1, requestId: 'request-1', kind: 'start', authorizedAction: 'start', status: 'pending', input: { origin: { path: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } } } } }) });
    reducer.accept({ type: 'model.message', id: 'origin', threadId: 'main', toolCalls: [{ id: 'origin', type: 'function', function: { name: 'codealongai_read_workspace_file', arguments: JSON.stringify({ path: 'checkout.ts', startLine: 2, endLine: 2 }) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] });
    reducer.accept({ type: 'tool.response', id: 'origin-response', threadId: 'main', toolCallId: 'origin', content: JSON.stringify({ structuredContent: { schemaVersion: 1, path: 'checkout.ts', startLine: 2, endLine: 2, text: '' } }) });
    assert.deepEqual(reducer.result, { status: 'failed', diagnostic: 'origin_read_invalid' });
  });

  test('allows exactly eight completed pre-transition calls and rejects the ninth', () => {
    const authorityResult = { schemaVersion: 1, requestId: 'request-1', kind: 'start', authorizedAction: 'start', status: 'pending', input: { origin: { path: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 4, character: 0 } } } } };
    const call = (reducer: StartTurnReducer, id: string, name: string, args: object, result: object): void => { reducer.accept({ type: 'model.message', id: `call-${id}`, threadId: 'main', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] }); reducer.accept({ type: 'tool.response', id: `result-${id}`, threadId: 'main', toolCallId: id, content: JSON.stringify(result) }); };
    const allowed = new StartTurnReducer('request-1');
    call(allowed, 'authority', 'codealongai_get_walkthrough_request', { requestId: 'request-1' }, authorityResult);
    call(allowed, 'origin', 'codealongai_read_workspace_file', { path: 'checkout.ts', startLine: 2, endLine: 4 }, { structuredContent: { schemaVersion: 1, path: 'checkout.ts', startLine: 2, endLine: 4, text: 'x' } });
    for (let index = 0; index < 6; index += 1) call(allowed, `search-${index}`, 'codealongai_search_workspace', { query: 'literal' }, { structuredContent: {} });
    allowed.accept({ type: 'model.message', id: 'call-start', threadId: 'main', toolCalls: [{ id: 'start', type: 'function', function: { name: 'codealongai_start_walkthrough', arguments: JSON.stringify({ requestId: 'request-1' }) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] });
    assert.equal(allowed.result, undefined);
    const ninth = new StartTurnReducer('request-1');
    call(ninth, 'authority', 'codealongai_get_walkthrough_request', { requestId: 'request-1' }, authorityResult);
    for (let index = 0; index < 8; index += 1) call(ninth, `search-${index}`, 'codealongai_search_workspace', { query: 'literal' }, { structuredContent: {} });
    ninth.accept({ type: 'model.message', id: 'call-nine', threadId: 'main', toolCalls: [{ id: 'nine', type: 'function', function: { name: 'codealongai_search_workspace', arguments: JSON.stringify({ query: 'literal' }) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] });
    assert.deepEqual(ninth.result, { status: 'failed', diagnostic: 'call_budget_exceeded' });
  });

  test('rejects a second sequential workspace list before any transition', () => {
    const reducer = new StartTurnReducer('request-1');
    const call = (id: string, name: string, args: object, content: object): void => { reducer.accept({ type: 'model.message', id: `call-${id}`, threadId: 'main', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] }); reducer.accept({ type: 'tool.response', id: `result-${id}`, threadId: 'main', toolCallId: id, content: JSON.stringify(content) }); };
    call('authority', 'codealongai_get_walkthrough_request', { requestId: 'request-1' }, { schemaVersion: 1, requestId: 'request-1', kind: 'start', authorizedAction: 'start', status: 'pending', input: { origin: { path: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } } } } });
    call('origin', 'codealongai_read_workspace_file', { path: 'checkout.ts', startLine: 2, endLine: 3 }, { structuredContent: { schemaVersion: 1, path: 'checkout.ts', startLine: 2, endLine: 3, text: 'x' } });
    call('list-one', 'codealongai_list_workspace_files', {}, { structuredContent: { paths: [] } });
    reducer.accept({ type: 'model.message', id: 'call-list-two', threadId: 'main', toolCalls: [{ id: 'list-two', type: 'function', function: { name: 'codealongai_list_workspace_files', arguments: '{}' }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] });
    assert.deepEqual(reducer.result, { status: 'failed', diagnostic: 'workspace_list_repeated' });
  });

  test('uses the smallest exclusive origin line interval for multi-line authority ranges', () => {
    const accept = (endCharacter: number, readEndLine: number): StartTurnReducer => {
      const reducer = new StartTurnReducer('request-1');
      reducer.accept({ type: 'model.message', id: 'authority-call', threadId: 'main', toolCalls: [{ id: 'authority', type: 'function', function: { name: 'codealongai_get_walkthrough_request', arguments: JSON.stringify({ requestId: 'request-1' }) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] });
      reducer.accept({ type: 'tool.response', id: 'authority-result', threadId: 'main', toolCallId: 'authority', content: JSON.stringify({ schemaVersion: 1, requestId: 'request-1', kind: 'start', authorizedAction: 'start', status: 'pending', input: { origin: { path: 'checkout.ts', range: { start: { line: 2, character: 3 }, end: { line: 5, character: endCharacter } } } } }) });
      reducer.accept({ type: 'model.message', id: 'read-call', threadId: 'main', toolCalls: [{ id: 'read', type: 'function', function: { name: 'codealongai_read_workspace_file', arguments: JSON.stringify({ path: 'checkout.ts', startLine: 2, endLine: readEndLine }) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] });
      return reducer;
    };
    assert.equal(accept(0, 5).result, undefined);
    assert.deepEqual(accept(0, 6).result, { status: 'failed', diagnostic: 'origin_range_required' });
    assert.equal(accept(4, 6).result, undefined);
    assert.deepEqual(accept(4, 5).result, { status: 'failed', diagnostic: 'origin_range_required' });
  });

  test('fails an out-of-order tool call and refuses sandbox command events', () => {
    const reducer = new StartTurnReducer('request-1');
    reducer.accept({ type: 'model.message', id: 'call-start', threadId: 'main', createdAt: 'now', toolCalls: [{ id: 'start', type: 'function', function: { name: 'codealongai_start_walkthrough', arguments: JSON.stringify({ requestId: 'request-1' }) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] });
    assert.deepEqual(reducer.result, { status: 'failed', diagnostic: 'request_authority_required' });
    const command = new StartTurnReducer('request-1');
    command.accept({ type: 'sandbox.command' });
    assert.deepEqual(command.result, { status: 'failed', diagnostic: 'unexpected_command' });
  });

  test('deduplicates a replayed pinned event by its stable string id', () => {
    const reducer = new StartTurnReducer('request-1');
    const authority = { type: 'model.message', id: 'replayed-call', threadId: 'main', createdAt: 'now', toolCalls: [{ id: 'authority', type: 'function', function: { name: 'codealongai_get_walkthrough_request', arguments: JSON.stringify({ requestId: 'request-1' }) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] };
    reducer.accept(authority); reducer.accept(authority);
    reducer.accept({ type: 'tool.response', id: 'authority-response', threadId: 'main', createdAt: 'now', toolCallId: 'authority', content: JSON.stringify({ schemaVersion: 1, requestId: 'request-1', kind: 'start', authorizedAction: 'start', status: 'pending', input: { origin: { path: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } } } } }) });
    acceptExactOriginRead(reducer);
    reducer.accept({ type: 'model.message', id: 'start-call', threadId: 'main', createdAt: 'now', toolCalls: [{ id: 'start', type: 'function', function: { name: 'codealongai_start_walkthrough', arguments: JSON.stringify({ requestId: 'request-1' }) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] });
    reducer.accept({ type: 'tool.response', id: 'start-response', threadId: 'main', createdAt: 'now', toolCallId: 'start', content: JSON.stringify({ schemaVersion: 1, requestId: 'request-1', sessionId: 'session', revision: 1, attentionStopId: 'origin' }) });
    assert.equal(reducer.result?.status, 'committed');
  });

  test('normalizes the pinned deferred MCP call_tool wrapper only for CodeAlongAI', () => {
    const reducer = new StartTurnReducer('request-1');
    reducer.accept({ type: 'model.message', id: 'wrapped-authority', threadId: 'main', createdAt: 'now', toolCalls: [{ id: 'authority', type: 'function', function: { name: 'call_tool', arguments: JSON.stringify({ mcp_server: 'codealongai-mcp', tool_name: 'codealongai_get_walkthrough_request', input: JSON.stringify({ requestId: 'request-1' }) }) }, toolInfo: { type: 'truefoundry-system', name: 'call_tool' } }] });
    reducer.accept({ type: 'tool.response', id: 'wrapped-authority-result', threadId: 'main', createdAt: 'now', toolCallId: 'authority', content: JSON.stringify({ schemaVersion: 1, requestId: 'request-1', kind: 'start', authorizedAction: 'start', status: 'pending', input: { origin: { path: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } } } } }) });
    acceptExactOriginRead(reducer);
    reducer.accept({ type: 'model.message', id: 'wrapped-start', threadId: 'main', createdAt: 'now', toolCalls: [{ id: 'start', type: 'function', function: { name: 'call_tool', arguments: JSON.stringify({ mcp_server: 'codealongai-mcp', tool_name: 'codealongai_start_walkthrough', input: JSON.stringify({ requestId: 'request-1' }) }) }, toolInfo: { type: 'truefoundry-system', name: 'call_tool' } }] });
    reducer.accept({ type: 'tool.response', id: 'receipt', threadId: 'main', createdAt: 'now', toolCallId: 'start', content: JSON.stringify({ schemaVersion: 1, requestId: 'request-1', sessionId: 'session', revision: 1, attentionStopId: 'origin' }) });
    assert.equal(reducer.result?.status, 'committed');
    const foreign = new StartTurnReducer('request-1');
    foreign.accept({ type: 'model.message', id: 'foreign', threadId: 'main', createdAt: 'now', toolCalls: [{ id: 'authority', type: 'function', function: { name: 'call_tool', arguments: JSON.stringify({ mcp_server: 'other', tool_name: 'codealongai_get_walkthrough_request', input: '{}' }) }, toolInfo: { type: 'truefoundry-system', name: 'call_tool' } }] });
    assert.deepEqual(foreign.result, { status: 'failed', diagnostic: 'tool_provenance' });
  });

  test('requires a successful authority result before bounded origin context', () => {
    const reducer = new StartTurnReducer('request-1');
    const call = (id: string, name: string, arguments_: object) => reducer.accept({ type: 'model.message', id, threadId: 'main', createdAt: 'now', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(arguments_) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] });
    call('authority', 'codealongai_get_walkthrough_request', { requestId: 'request-1' });
    call('too-early', 'codealongai_list_workspace_files', {});
    assert.deepEqual(reducer.result, { status: 'failed', diagnostic: 'result_required' });
    const malformed = new StartTurnReducer('request-1');
    malformed.accept({ type: 'model.message', id: 'authority', threadId: 'main', createdAt: 'now', toolCalls: [{ id: 'authority', type: 'function', function: { name: 'codealongai_get_walkthrough_request', arguments: JSON.stringify({ requestId: 'request-1' }) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] });
    malformed.accept({ type: 'tool.response', id: 'authority-result', threadId: 'main', createdAt: 'now', toolCallId: 'authority', content: JSON.stringify({ isError: true }) });
    assert.deepEqual(malformed.result, { status: 'failed', diagnostic: 'tool_result_invalid' });
  });
  test('rejects a mismatched start authority receipt before any context call', () => {
    const reducer = new StartTurnReducer('request-1');
    reducer.accept({ type: 'model.message', id: 'authority', threadId: 'main', toolCalls: [{ id: 'authority', type: 'function', function: { name: 'codealongai_get_walkthrough_request', arguments: JSON.stringify({ requestId: 'request-1' }) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] });
    reducer.accept({ type: 'tool.response', id: 'authority-result', threadId: 'main', toolCallId: 'authority', content: JSON.stringify({ schemaVersion: 1, requestId: 'other-request', kind: 'question', authorizedAction: 'question', status: 'pending', input: { origin: { path: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } } } } }) });
    assert.deepEqual(reducer.result, { status: 'failed', diagnostic: 'request_authority_invalid' });
  });
  test('preserves safe workspace error codes without retaining tool text', () => {
    const reducer = new StartTurnReducer('request-1');
    reducer.accept({ type: 'model.message', id: 'authority', threadId: 'main', toolCalls: [{ id: 'authority', type: 'function', function: { name: 'codealongai_get_walkthrough_request', arguments: JSON.stringify({ requestId: 'request-1' }) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] });
    reducer.accept({ type: 'tool.response', id: 'authority-result', threadId: 'main', toolCallId: 'authority', content: JSON.stringify({ isError: true, structuredContent: { code: 'path_invalid', message: 'secret provider text' } }) });
    assert.deepEqual(reducer.result, { status: 'failed', diagnostic: 'path_invalid' });
  });

  test('normalizes pinned MCP error arrays without retaining their text', () => {
    const reject = (content: object): unknown => {
      const reducer = new StartTurnReducer('request-1');
      reducer.accept({ type: 'model.message', id: 'authority', threadId: 'main', toolCalls: [{ id: 'authority', type: 'function', function: { name: 'codealongai_get_walkthrough_request', arguments: JSON.stringify({ requestId: 'request-1' }) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] });
      reducer.accept({ type: 'tool.response', id: 'authority-response', threadId: 'main', toolCallId: 'authority', content: JSON.stringify(content) });
      return reducer.result;
    };
    assert.deepEqual(reject({ error: [{ type: 'text', text: '{"schemaVersion":1,"code":"path_invalid","message":"sentinel-path"}' }] }), { status: 'failed', diagnostic: 'path_invalid' });
    assert.deepEqual(reject({ error: [{ type: 'text', text: '{"schemaVersion":1,"code":"range_invalid","message":"sentinel-range"}' }] }), { status: 'failed', diagnostic: 'range_invalid' });
    const mixed = reject({ error: [{ type: 'text', text: 'prefix {"schemaVersion":1,"code":"path_invalid"} suffix sentinel-mixed' }] });
    assert.deepEqual(mixed, { status: 'failed', diagnostic: 'tool_result_invalid' });
    assert.deepEqual(reject({ error: [{ type: 'text', text: '{"schemaVersion":1,"code":"generic_error","message":"sentinel-generic"}' }] }), { status: 'failed', diagnostic: 'tool_result_invalid' });
    assert.equal(JSON.stringify(mixed).includes('sentinel'), false);
  });

  test('applies one absolute deadline to stalled create, turn, and stream operations', async () => {
    const never = new Promise<never>(() => undefined);
    const input = { requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'http://127.0.0.1:1/mcp' };
    const base = (overrides: Partial<TrueForgeProducerRuntime>): TrueForgeProducerRuntime => ({ ...emptyTrueForgeProducer, createSession: async () => ({ data: { id: 'session' } }), runTurn: async () => ({ data: { id: 'turn' } }), events: async function* () { yield* []; }, ...overrides });
    assert.deepEqual(await new ReceiptBackedStartCoordinator(base({ createSession: async () => never }), 5).start(input), { status: 'failed', diagnostic: 'deadline_exceeded' });
    const cleanup: string[] = [];
    assert.deepEqual(await new ReceiptBackedStartCoordinator(base({ runTurn: async () => never, cancelTurn: async () => { cleanup.push('cancel'); }, deleteSession: async () => { cleanup.push('delete'); } }), 5).start(input), { status: 'failed', diagnostic: 'deadline_exceeded' });
    assert.deepEqual(cleanup, ['cancel', 'delete']);
    cleanup.length = 0;
    assert.deepEqual(await new ReceiptBackedStartCoordinator(base({ events: async function* (_s, _t, _after, options) { await Promise.race([never, waitForAbort(options?.abortSignal)]); }, cancelTurn: async () => { cleanup.push('cancel'); }, deleteSession: async () => { cleanup.push('delete'); } }), 5).start(input), { status: 'failed', diagnostic: 'deadline_exceeded' });
    assert.deepEqual(cleanup, ['cancel', 'delete']);
  });

  test('reconciles a persisted response-before-call trace into a receipt', async () => {
    const response = (id: string, content: object, sequenceNumber: number) => ({ sequenceNumber, event: { type: 'tool.response', id: `response-${id}`, threadId: 'main', createdAt: 'now', toolCallId: id, content: JSON.stringify(id === 'authority' ? { schemaVersion: 1, requestId: 'request-1', kind: 'start', authorizedAction: 'start', status: 'pending', ...content } : content) } });
    const call = (id: string, name: string, arguments_: object, sequenceNumber: number) => ({ sequenceNumber, event: { type: 'model.message', id: `call-${id}`, threadId: 'main', createdAt: 'now', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(arguments_) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] } });
    const receipt = { schemaVersion: 1, requestId: 'request-1', sessionId: 'session', revision: 1, attentionStopId: 'origin' };
    const runtime: TrueForgeProducerRuntime = { ...emptyTrueForgeProducer, createSession: async () => ({ id: 'session' }), runTurn: async () => ({ id: 'turn' }), events: async function* () { yield response('start', receipt, 1); }, listTurnEvents: async () => [call('authority', 'codealongai_get_walkthrough_request', { requestId: 'request-1' }, 2), response('authority', { input: { origin: { path: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } } } } }, 3), call('origin', 'codealongai_read_workspace_file', { path: 'checkout.ts', startLine: 2, endLine: 2 }, 4), response('origin', { structuredContent: { schemaVersion: 1, path: 'checkout.ts', startLine: 2, endLine: 2, text: 'x' } }, 5), call('start', 'codealongai_start_walkthrough', { requestId: 'request-1', origin: {} }, 6), { sequenceNumber: 7, event: { type: 'turn.done', state: { status: 'done' } } }] };
    assert.deepEqual(await new ReceiptBackedStartCoordinator(runtime, 100, async () => undefined).start({ requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused' }), { status: 'committed', receipt });
  });

  test('restores a persisted lower-sequence call before a live higher-sequence response', async () => {
    const subscriptions: (number | undefined)[] = [];
    const call = (id: string, name: string, arguments_: object, sequenceNumber: number) => ({ sequenceNumber, event: { type: 'model.message', id: `call-${id}`, threadId: 'main', createdAt: 'now', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(arguments_) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] } });
    const response = (id: string, content: object, sequenceNumber: number) => ({ sequenceNumber, event: { type: 'tool.response', id: `response-${id}`, threadId: 'main', createdAt: 'now', toolCallId: id, content: JSON.stringify(id === 'authority' ? { schemaVersion: 1, requestId: 'request-1', kind: 'start', authorizedAction: 'start', status: 'pending', ...content } : content) } });
    const receipt = { schemaVersion: 1, requestId: 'request-1', sessionId: 'session', revision: 1, attentionStopId: 'origin' };
    const runtime: TrueForgeProducerRuntime = { ...emptyTrueForgeProducer, createSession: async () => ({ id: 'session' }), runTurn: async () => ({ id: 'turn' }), events: async function* (_s, _t, after) { subscriptions.push(after); if (after === undefined) { yield response('authority', { input: { origin: { path: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } } } } }, 2); return; } yield call('origin', 'codealongai_read_workspace_file', { path: 'checkout.ts', startLine: 2, endLine: 2 }, 3); yield response('origin', { structuredContent: { schemaVersion: 1, path: 'checkout.ts', startLine: 2, endLine: 2, text: 'x' } }, 4); yield call('start', 'codealongai_start_walkthrough', { requestId: 'request-1' }, 5); yield response('start', receipt, 6); yield { sequenceNumber: 7, event: { type: 'turn.done', state: { status: 'done' } } }; }, listTurnEvents: async () => [call('authority', 'codealongai_get_walkthrough_request', { requestId: 'request-1' }, 1)] };
    assert.deepEqual(await new ReceiptBackedStartCoordinator(runtime, 100, async () => undefined).start({ requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused' }), { status: 'committed', receipt });
    assert.deepEqual(subscriptions, [undefined, 2]);
  });

  test('bounds a stalled persisted-event reconciliation by the start deadline', async () => {
    const never = new Promise<readonly unknown[]>(() => undefined);
    const calls: string[] = [];
    const runtime: TrueForgeProducerRuntime = { ...emptyTrueForgeProducer, createSession: async () => ({ id: 'session' }), runTurn: async () => ({ id: 'turn' }), events: async function* () { yield* []; }, listTurnEvents: async () => never, cancelTurn: async () => { calls.push('cancel'); }, deleteSession: async () => { calls.push('delete'); } };
    assert.deepEqual(await new ReceiptBackedStartCoordinator(runtime, 5).start({ requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused' }), { status: 'failed', diagnostic: 'deadline_exceeded' });
    assert.deepEqual(calls, ['cancel', 'delete']);
  });

  test('reconciles an incomplete live trace then resubscribes exactly once at its numeric cursor', async () => {
    const subscriptions: (number | undefined)[] = [];
    const call = (id: string, name: string, arguments_: object, sequenceNumber: number) => ({ sequenceNumber, event: { type: 'model.message', id: `call-${id}`, threadId: 'main', createdAt: 'now', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(arguments_) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] } });
    const response = (id: string, content: object, sequenceNumber: number) => ({ sequenceNumber, event: { type: 'tool.response', id: `response-${id}`, threadId: 'main', createdAt: 'now', toolCallId: id, content: JSON.stringify(id === 'authority' ? { schemaVersion: 1, requestId: 'request-1', kind: 'start', authorizedAction: 'start', status: 'pending', ...content } : content) } });
    const receipt = { schemaVersion: 1, requestId: 'request-1', sessionId: 'session', revision: 1, attentionStopId: 'origin' };
    let cancels = 0;
    const runtime: TrueForgeProducerRuntime = { ...emptyTrueForgeProducer, createSession: async () => ({ id: 'session' }), runTurn: async () => ({ id: 'turn' }), events: async function* (_s, _t, after) { subscriptions.push(after); if (after === undefined) { yield call('authority', 'codealongai_get_walkthrough_request', { requestId: 'request-1' }, 7); return; } assert.equal(cancels, 0, 'recoverable EOF must not cancel before reconciliation and resubscription'); yield response('authority', { input: { origin: { path: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } } } } }, 8); yield call('origin', 'codealongai_read_workspace_file', { path: 'checkout.ts', startLine: 2, endLine: 2 }, 9); yield response('origin', { structuredContent: { schemaVersion: 1, path: 'checkout.ts', startLine: 2, endLine: 2, text: 'x' } }, 10); yield call('start', 'codealongai_start_walkthrough', { requestId: 'request-1' }, 11); yield response('start', receipt, 12); yield { sequenceNumber: 13, event: { type: 'turn.done', state: { status: 'done' } } }; }, listTurnEvents: async () => [], cancelTurn: async () => { cancels += 1; } };
    assert.equal((await new ReceiptBackedStartCoordinator(runtime, 100, async () => undefined).start({ requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused' })).status, 'committed');
    assert.deepEqual(subscriptions, [undefined, 7]);
  });

  test('recovers one thrown pinned stream interruption before its cursor resubscription', async () => {
    const subscriptions: (number | undefined)[] = []; let cancels = 0;
    const call = (id: string, name: string, arguments_: object, sequenceNumber: number) => ({ sequenceNumber, event: { type: 'model.message', id: `call-${id}`, threadId: 'main', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(arguments_) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] } });
    const response = (id: string, content: object, sequenceNumber: number) => ({ sequenceNumber, event: { type: 'tool.response', id: `response-${id}`, threadId: 'main', toolCallId: id, content: JSON.stringify(id === 'authority' ? { schemaVersion: 1, requestId: 'request-1', kind: 'start', authorizedAction: 'start', status: 'pending', ...content } : content) } });
    const receipt = { schemaVersion: 1, requestId: 'request-1', sessionId: 'session', revision: 1, attentionStopId: 'origin' };
    const runtime: TrueForgeProducerRuntime = { ...emptyTrueForgeProducer, createSession: async () => ({ id: 'session' }), runTurn: async () => ({ id: 'turn' }), events: async function* (_s, _t, after) { subscriptions.push(after); if (after === undefined) { yield call('authority', 'codealongai_get_walkthrough_request', { requestId: 'request-1' }, 7); throw new Error('interrupted'); } assert.equal(cancels, 0, 'the first interruption must not cancel before recovery'); yield response('authority', { input: { origin: { path: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } } } } }, 8); yield call('origin', 'codealongai_read_workspace_file', { path: 'checkout.ts', startLine: 2, endLine: 2 }, 9); yield response('origin', { structuredContent: { schemaVersion: 1, path: 'checkout.ts', startLine: 2, endLine: 2, text: 'x' } }, 10); yield call('start', 'codealongai_start_walkthrough', { requestId: 'request-1' }, 11); yield response('start', receipt, 12); yield { sequenceNumber: 13, event: { type: 'turn.done', state: { status: 'done' } } }; }, listTurnEvents: async () => [], cancelTurn: async () => { cancels += 1; } };
    assert.deepEqual(await new ReceiptBackedStartCoordinator(runtime, 100, async () => undefined).start({ requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused' }), { status: 'committed', receipt });
    assert.deepEqual(subscriptions, [undefined, 7]);
  });

  test('fails a second thrown pinned stream interruption', async () => {
    let attempts = 0;
    const runtime: TrueForgeProducerRuntime = { ...emptyTrueForgeProducer, createSession: async () => ({ id: 'session' }), runTurn: async () => ({ id: 'turn' }), events: async function* () { attempts += 1; throw new Error('interrupted'); }, listTurnEvents: async () => [] };
    assert.deepEqual(await new ReceiptBackedStartCoordinator(runtime, 100, async () => undefined).start({ requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused' }), { status: 'failed', diagnostic: 'producer_error' });
    assert.equal(attempts, 2);
  });

  test('waits one injected five-second grace after receipt without done, then cancels before deletion', async () => {
    const calls: string[] = []; const grace: number[] = [];
    let releaseTerminal: (() => void) | undefined; const terminalReleased = new Promise<void>((resolve) => { releaseTerminal = resolve; });
    let receiptPublished: (() => void) | undefined; const receiptSeen = new Promise<void>((resolve) => { receiptPublished = resolve; });
    const runtime: TrueForgeProducerRuntime = { ...emptyTrueForgeProducer, createSession: async () => ({ id: 'session' }), runTurn: async () => ({ id: 'turn' }), events: async function* () { const call = (id: string, name: string, args: object, sequenceNumber: number) => ({ sequenceNumber, event: { type: 'model.message', id, threadId: 'main', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] } }); const response = (id: string, content: object, sequenceNumber: number) => ({ sequenceNumber, event: { type: 'tool.response', id: `${id}-response`, threadId: 'main', toolCallId: id, content: JSON.stringify(content) } }); yield call('authority', 'codealongai_get_walkthrough_request', { requestId: 'request-1' }, 1); yield response('authority', { schemaVersion: 1, requestId: 'request-1', kind: 'start', authorizedAction: 'start', status: 'pending', input: { origin: { path: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } } } } }, 2); yield call('origin', 'codealongai_read_workspace_file', { path: 'checkout.ts', startLine: 2, endLine: 2 }, 3); yield response('origin', { structuredContent: { schemaVersion: 1, path: 'checkout.ts', startLine: 2, endLine: 2, text: 'x' } }, 4); yield call('start', 'codealongai_start_walkthrough', { requestId: 'request-1' }, 5); yield response('start', { schemaVersion: 1, requestId: 'request-1', sessionId: 'session', revision: 1, attentionStopId: 'origin' }, 6); receiptPublished!(); await terminalReleased; yield { sequenceNumber: 7, event: { type: 'turn.done', state: { status: 'error' } } }; }, cancelTurn: async () => { calls.push('cancel'); }, deleteSession: async () => { calls.push('delete'); } };
    const coordinator = new ReceiptBackedStartCoordinator(runtime, 100_000, async (ms) => { grace.push(ms); });
    const operation = coordinator.start({ requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused' });
    await receiptSeen;
    assert.equal((await operation).status, 'committed');
    releaseTerminal!();
    await coordinator.settled;
    assert.deepEqual(grace, [5_000]); assert.deepEqual(calls, ['cancel', 'delete']);
  });
  test('settles final receipt grace when the pending native next never releases', async () => {
    const calls: string[] = [];
    const never = new Promise<never>(() => undefined);
    const call = (id: string, name: string, args: object, sequenceNumber: number) => ({ sequenceNumber, event: { type: 'model.message', id, threadId: 'main', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] } });
    const response = (id: string, content: object, sequenceNumber: number) => ({ sequenceNumber, event: { type: 'tool.response', id: `${id}-response`, threadId: 'main', toolCallId: id, content: JSON.stringify(content) } });
    const runtime: TrueForgeProducerRuntime = { ...emptyTrueForgeProducer, createSession: async () => ({ id: 'session' }), runTurn: async () => ({ id: 'turn' }), events: async function* () {
      yield call('authority', 'codealongai_get_walkthrough_request', { requestId: 'request-1' }, 1);
      yield response('authority', { schemaVersion: 1, requestId: 'request-1', kind: 'start', authorizedAction: 'start', status: 'pending', input: { origin: { path: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } } } } }, 2);
      yield call('origin', 'codealongai_read_workspace_file', { path: 'checkout.ts', startLine: 2, endLine: 2 }, 3);
      yield response('origin', { structuredContent: { schemaVersion: 1, path: 'checkout.ts', startLine: 2, endLine: 2, text: 'x' } }, 4);
      yield call('start', 'codealongai_start_walkthrough', { requestId: 'request-1' }, 5);
      yield response('start', { schemaVersion: 1, requestId: 'request-1', sessionId: 'session', revision: 1, attentionStopId: 'origin' }, 6);
      await never;
    }, cancelTurn: async () => { calls.push('cancel'); }, deleteSession: async () => { calls.push('delete'); } };
    const coordinator = new ReceiptBackedStartCoordinator(runtime, 100, async () => undefined, 20);
    assert.equal((await coordinator.start({ requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused' })).status, 'committed');
    assert.deepEqual(await coordinator.settled, { status: 'committed', receipt: { schemaVersion: 1, requestId: 'request-1', sessionId: 'session', revision: 1, attentionStopId: 'origin' } });
    assert.deepEqual(calls, ['cancel', 'delete']);
  });
  test('cancels an in-progress receipt grace before cleanup', async () => {
    const calls: string[] = [];
    let enteredGrace: (() => void) | undefined; const graceEntered = new Promise<void>((resolve) => { enteredGrace = resolve; });
    let resolveGrace: (() => void) | undefined; const graceReleased = new Promise<void>((resolve) => { resolveGrace = resolve; });
    const call = (id: string, name: string, args: Record<string, unknown>, sequenceNumber: number) => ({ sequenceNumber, event: { type: 'model.message', id, threadId: 'main', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) }, toolInfo: { type: 'mcp', serverName: 'codealongai-mcp' } }] } });
    const response = (id: string, content: Record<string, unknown>, sequenceNumber: number) => ({ sequenceNumber, event: { type: 'tool.response', id: `${id}-response`, threadId: 'main', toolCallId: id, content: JSON.stringify(content) } });
    const runtime: TrueForgeProducerRuntime = { ...emptyTrueForgeProducer, createSession: async () => ({ id: 'session' }), runTurn: async () => ({ id: 'turn' }), events: async function* () {
      yield call('authority', 'codealongai_get_walkthrough_request', { requestId: 'request-1' }, 1);
      yield response('authority', { schemaVersion: 1, requestId: 'request-1', kind: 'start', authorizedAction: 'start', status: 'pending', input: { origin: { path: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } } } } }, 2);
      yield call('origin', 'codealongai_read_workspace_file', { path: 'checkout.ts', startLine: 2, endLine: 2 }, 3);
      yield response('origin', { structuredContent: { schemaVersion: 1, path: 'checkout.ts', startLine: 2, endLine: 2, text: 'x' } }, 4);
      yield call('start', 'codealongai_start_walkthrough', { requestId: 'request-1' }, 5);
      yield response('start', { schemaVersion: 1, requestId: 'request-1', sessionId: 'session', revision: 1, attentionStopId: 'origin' }, 6);
    }, cancelTurn: async () => { calls.push('cancel'); }, deleteSession: async () => { calls.push('delete'); } };
    const coordinator = new ReceiptBackedStartCoordinator(runtime, 100_000, async (_ms, signal) => { enteredGrace!(); signal?.addEventListener('abort', () => resolveGrace!(), { once: true }); await graceReleased; });
    const operation = coordinator.start({ requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'unused' });
    await graceEntered;
    assert.equal((await operation).status, 'committed');
    coordinator.cancel();
    assert.deepEqual(await coordinator.settled, { status: 'failed', diagnostic: 'cancelled' });
    assert.deepEqual(calls, ['cancel', 'delete']);
  });

  test('creates a capability-minimal Daytona agent spec with a selected skill', () => {
    const spec = startProducerAgentSpec({ requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'http://127.0.0.1:1/mcp' }) as unknown as Record<string, unknown>;
    assert.deepEqual(spec.skills, [{ name: 'codealongai' }]);
    assert.equal(((spec.config as Record<string, unknown>).sandbox as Record<string, unknown>).fileDownloads, false);
    assert.deepEqual(spec.mcpServers, [{ name: 'codealongai-mcp', enableTools: ['codealongai_get_walkthrough_request', 'codealongai_get_walkthrough', 'codealongai_list_workspace_files', 'codealongai_read_workspace_file', 'codealongai_search_workspace', 'codealongai_start_walkthrough'], requireApprovalForTools: [] }]);
    assert.equal(JSON.stringify(spec).includes('url'), false);
  });

  test('creates the exact native Reply capability set', () => {
    const spec = startProducerAgentSpec({ kind: 'question', requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'http://ignored/mcp' }) as unknown as { mcpServers: { enableTools: string[]; requireApprovalForTools: string[] }[]; skills: { name: string }[]; config: { sandbox: { enabled: boolean; fileDownloads: boolean }; dynamicSubAgents: { enabled: boolean }; askUserQuestions: { enabled: boolean }; iterationLimit: number }; model: { params: { parallelToolCalls: boolean } }; instructions: string };
    assert.deepEqual(spec.mcpServers, [{ name: 'codealongai-mcp', enableTools: ['codealongai_get_walkthrough_request', 'codealongai_get_walkthrough', 'codealongai_list_workspace_files', 'codealongai_read_workspace_file', 'codealongai_search_workspace', 'codealongai_commit_question_outcome'], requireApprovalForTools: [] }]);
    assert.deepEqual(spec.skills, [{ name: 'codealongai' }]);
    assert.equal(spec.config.sandbox.enabled, true); assert.equal(spec.config.sandbox.fileDownloads, false); assert.equal(spec.config.dynamicSubAgents.enabled, false); assert.equal(spec.config.askUserQuestions.enabled, false); assert.equal(spec.config.iterationLimit, 9); assert.equal(spec.model.params.parallelToolCalls, false);
    assert.equal(spec.instructions, 'Produce exactly one CodeAlongAI question outcome. First read the exact authorized question, then read the active walkthrough, then use only bounded supplemental context before one matching question-outcome transition. Use only the registered codealongai skill and MCP tools. Do not run sandbox commands, skill files, downloads, ask for approval, ask the user, retry, or create subagents.');
  });

  test('serializes the pinned start AgentSpec without a connector URL', async () => {
    let received: { url?: string; body?: Record<string, unknown> } = {};
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => { received = { url: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: 'session' })); });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    try {
      await new TrueForge({ baseUrl: `http://127.0.0.1:${address.port}` }).sessions.create({ agent: { spec: startProducerAgentSpec({ requestId: 'request-1', model: 'openai/gpt', reasoningEffort: 'medium', mcpUrl: 'http://ignored/mcp' }) } });
      assert.equal(received.url, '/api/v1/sessions');
      assert.deepEqual(received.body, { agent: { spec: { model: { name: 'openai/gpt', params: { reasoning_effort: 'medium', parallel_tool_calls: false } }, skills: [{ name: 'codealongai' }], mcp_servers: [{ name: 'codealongai-mcp', enable_tools: ['codealongai_get_walkthrough_request', 'codealongai_get_walkthrough', 'codealongai_list_workspace_files', 'codealongai_read_workspace_file', 'codealongai_search_workspace', 'codealongai_start_walkthrough'], require_approval_for_tools: [] }], config: { sandbox: { enabled: true, file_downloads: false }, dynamic_sub_agents: { enabled: false }, ask_user_questions: { enabled: false }, iteration_limit: 9 }, instructions: 'Produce exactly one CodeAlongAI start transition. Use only the registered codealongai skill and MCP tools. Do not run sandbox commands, download files, ask for approval, ask the user, retry, or create subagents.' } } });
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});

suite('workspace context over loopback MCP', () => {
  test('exposes only normalized unsaved workspace text through the public tools', async () => {
    const endpoint = new LoopbackMcpEndpoint(new WalkthroughAuthority(), memorySource([{ path: 'src\\draft.ts', text: 'const draft = true;\n', dirty: true, documentVersion: 3 }]));
    await endpoint.start(0);
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp`));
    const client = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
        'codealongai_commit_question_outcome', 'codealongai_get_walkthrough', 'codealongai_get_walkthrough_request', 'codealongai_list_workspace_files', 'codealongai_navigate_walkthrough', 'codealongai_read_workspace_file', 'codealongai_replace_walkthrough', 'codealongai_reset_walkthrough', 'codealongai_search_workspace', 'codealongai_start_walkthrough'
      ]);
      const listed = await client.callTool({ name: 'codealongai_list_workspace_files', arguments: { schemaVersion: 1 } });
      assert.deepEqual(listed.structuredContent, { schemaVersion: 1, paths: ['src/draft.ts'] });
      const read = await client.callTool({ name: 'codealongai_read_workspace_file', arguments: { schemaVersion: 1, path: 'src/draft.ts' } });
      assert.deepEqual(read.structuredContent, { schemaVersion: 1, path: 'src/draft.ts', startLine: 0, endLine: 2, text: 'const draft = true;\n', dirty: true, documentVersion: 3 });
      const rejected = await client.callTool({ name: 'codealongai_read_workspace_file', arguments: { schemaVersion: 1, path: '../secret.ts' } });
      assert.equal(rejected.isError, true);
      assert.deepEqual(rejected.structuredContent, { schemaVersion: 1, code: 'path_invalid', message: 'The requested workspace file is unavailable.', retryable: false });
      const missing = await client.callTool({ name: 'codealongai_read_workspace_file', arguments: { schemaVersion: 1, path: 'missing.ts' } });
      assert.deepEqual(missing.structuredContent, { schemaVersion: 1, code: 'path_invalid', message: 'The requested workspace file is unavailable.', retryable: false });
      const invalidRange = await client.callTool({ name: 'codealongai_read_workspace_file', arguments: { schemaVersion: 1, path: 'src/draft.ts', startLine: 3, endLine: 4 } });
      assert.deepEqual(invalidRange.structuredContent, { schemaVersion: 1, code: 'range_invalid', message: 'The requested line interval is invalid.', retryable: false });
      for (const arguments_ of [
        { schemaVersion: 1, path: 'src/draft.ts', startLine: -1, endLine: 0 },
        { schemaVersion: 1, path: 'src/draft.ts', startLine: 0.5, endLine: 1 },
        { schemaVersion: 1, path: 'src/draft.ts', startLine: 1, endLine: 0 },
        { schemaVersion: 1, path: 'src/draft.ts', startLine: 0 }
      ]) {
        const malformedRange = await client.callTool({ name: 'codealongai_read_workspace_file', arguments: arguments_ });
        assert.deepEqual(malformedRange.structuredContent, { schemaVersion: 1, code: 'range_invalid', message: 'The requested line interval is invalid.', retryable: false });
      }
      for (const path of ['', 42, undefined]) {
        const malformedPath = await client.callTool({ name: 'codealongai_read_workspace_file', arguments: { schemaVersion: 1, path } });
        assert.deepEqual(malformedPath.structuredContent, { schemaVersion: 1, code: 'path_invalid', message: 'The requested workspace file is unavailable.', retryable: false });
      }
    } finally {
      await transport.close();
      await endpoint.stop();
    }
  });

  test('normalizes an unreadable workspace document at the real MCP boundary', async () => {
    const source: WorkspaceSource = { workspaceFolderCount: () => 1, listFiles: async () => ['unreadable.ts'], readFile: async () => { throw new Error('host filesystem detail must not cross MCP'); } };
    const endpoint = new LoopbackMcpEndpoint(new WalkthroughAuthority(), source);
    await endpoint.start(0);
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp`));
    const client = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'codealongai_read_workspace_file', arguments: { schemaVersion: 1, path: 'unreadable.ts' } });
      assert.deepEqual(result.structuredContent, { schemaVersion: 1, code: 'path_invalid', message: 'The requested workspace file is unavailable.', retryable: false });
    } finally { await transport.close(); await endpoint.stop(); }
  });
});

suite('loopback endpoint traffic guard', () => {
  test('fails closed before parsing unexpected routes, origins, hosts, and oversized bodies', async () => {
    const endpoint = new LoopbackMcpEndpoint(new WalkthroughAuthority());
    await endpoint.start(0);
    const url = `http://127.0.0.1:${endpoint.port}`;
    try {
      for (const [path, init, expected] of [
        ['/health', {}, 404],
        ['/mcp', { headers: { origin: 'http://127.0.0.1' } }, 403],
        ['/mcp', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } }, 400],
        ['/mcp', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1), headers: { 'content-type': 'application/json' } }, 413]
      ] as const) {
        const response = await fetch(`${url}${path}`, init);
        assert.equal(response.status, expected);
        const body = await response.json() as { error: { message: string } };
        assert.ok(['Not found', 'Invalid request', 'Parse error', 'Request too large'].includes(body.error.message));
      }
      const invalidHost = await new Promise<number>((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: endpoint.port, path: '/mcp', headers: { host: 'localhost:1' } }, (response) => resolve(response.statusCode!));
        request.on('error', reject);
        request.end();
      });
      assert.equal(invalidHost, 403);
    } finally { await endpoint.stop(); }
  });

  test('returns a structured 413 for an oversized chunked body', async () => {
    const endpoint = new LoopbackMcpEndpoint(new WalkthroughAuthority());
    await endpoint.start(0);
    try {
      const rejected = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: endpoint.port, path: '/mcp', method: 'POST', headers: { 'transfer-encoding': 'chunked' } }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        });
        request.on('error', reject);
        request.end(Buffer.alloc(1024 * 1024 + 1));
      });
      assert.equal(rejected.status, 413);
      assert.deepEqual(rejected.body, { jsonrpc: '2.0', error: { code: -32600, message: 'Request too large' }, id: null });
    } finally { await endpoint.stop(); }
  });

  test('bounds an incomplete body when its client aborts after the deadline', async () => {
    const endpoint = new LoopbackMcpEndpoint(new WalkthroughAuthority(), undefined, 20);
    await endpoint.start(0);
    let slowRequest: http.ClientRequest | undefined;
    try {
      const expired = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        slowRequest = http.request({ host: '127.0.0.1', port: endpoint.port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        });
        slowRequest.on('error', reject);
        slowRequest.write('{');
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const busy = await fetch(`http://127.0.0.1:${endpoint.port}/mcp`, { method: 'POST', body: '{' });
      assert.equal(busy.status, 503);
      const timeout = await expired;
      assert.equal(timeout.status, 408);
      assert.deepEqual(timeout.body, { jsonrpc: '2.0', error: { code: -32600, message: 'Request timed out' }, id: null });
      slowRequest?.destroy();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const released = await fetch(`http://127.0.0.1:${endpoint.port}/mcp`, { method: 'POST', body: '{' });
      assert.equal(released.status, 400);
    } finally {
      slowRequest?.destroy();
      await endpoint.stop();
    }
  });

  test('returns a retryable busy tool result through the MCP client', async () => {
    let beginList: (() => void) | undefined;
    const endpoint = new LoopbackMcpEndpoint(new WalkthroughAuthority(), {
      workspaceFolderCount: () => 1,
      listFiles: async () => new Promise<string[]>((resolve) => { beginList = () => resolve([]); }),
      readFile: async (path) => ({ path, dirty: false, failure: 'file_unsupported' })
    });
    await endpoint.start(0);
    const firstTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp`));
    const firstClient = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await firstClient.connect(firstTransport);
    const firstCall = firstClient.callTool({ name: 'codealongai_list_workspace_files', arguments: { schemaVersion: 1 } });
    try {
      while (!beginList) await new Promise<void>((resolve) => setImmediate(resolve));
      const busyResponse = await fetch(`http://127.0.0.1:${endpoint.port}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'busy', method: 'tools/call', params: { name: 'codealongai_get_walkthrough_request', arguments: { schemaVersion: 1, requestId: 'missing' } } })
      });
      assert.equal(busyResponse.status, 200);
      assert.deepEqual(await busyResponse.json(), { jsonrpc: '2.0', id: 'busy', result: { isError: true, structuredContent: { schemaVersion: 1, code: 'endpoint_busy', message: 'The endpoint is busy. Retry the tool call.', retryable: true }, content: [{ type: 'text', text: JSON.stringify({ schemaVersion: 1, code: 'endpoint_busy', message: 'The endpoint is busy. Retry the tool call.', retryable: true }) }] } });
    } finally {
      beginList?.();
      await firstCall;
      await firstTransport.close();
      await endpoint.stop();
    }
  });

  test('releases the tool-call guard after an expired read request', async () => {
    let beginList: (() => void) | undefined;
    const authority = new WalkthroughAuthority();
    const origin = { stopId: 'origin', displayName: 'Origin', explanation: 'Start', document: 'checkout.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } };
    const start = authority.captureStart(origin);
    const endpoint = new LoopbackMcpEndpoint(authority, {
      workspaceFolderCount: () => 1,
      listFiles: async () => new Promise<string[]>((resolve) => { beginList = () => resolve([]); }),
      readFile: async (path) => ({ path, dirty: false, failure: 'file_unsupported' })
    }, 10);
    await endpoint.start(0);
    const firstTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp`));
    const firstClient = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await firstClient.connect(firstTransport);
    const firstCall = firstClient.callTool({ name: 'codealongai_list_workspace_files', arguments: { schemaVersion: 1 } });
    void firstCall.catch(() => undefined);
    try {
      while (!beginList) await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const retryTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp`));
      const retryClient = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
      await retryClient.connect(retryTransport);
      try {
        const result = await retryClient.callTool({ name: 'codealongai_start_walkthrough', arguments: { schemaVersion: 1, requestId: start.id, origin } });
        assert.equal(result.isError, undefined);
      } finally { await retryTransport.close(); }
    } finally {
      beginList?.();
      await firstTransport.close();
      await endpoint.stop();
    }
  });
});

suite('replacement and reset over loopback MCP', () => {
  const origin = { stopId: 'origin', displayName: 'Origin', explanation: 'Start', document: 'checkout.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } };
  test('uses strict revisions and clears only the authorized populated walkthrough', async () => {
    const authority = new WalkthroughAuthority();
    const start = authority.captureStart(origin);
    authority.start(start.id, origin);
    const endpoint = new LoopbackMcpEndpoint(authority);
    await endpoint.start(0);
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp`));
    const client = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(transport);
    try {
      const old = authority.getSession()!;
      const replacement = authority.captureReplacement({ document: 'pricing.ts', range: origin.range });
      const rejected = await client.callTool({ name: 'codealongai_replace_walkthrough', arguments: { schemaVersion: 1, requestId: replacement.id, expectedSessionId: old.id, expectedRevision: old.revision + 1, origin: { ...origin, stopId: 'replacement', document: 'pricing.ts' } } });
      assert.equal(rejected.isError, true);
      assert.deepEqual(authority.getSession(), old);
      const replaced = await client.callTool({ name: 'codealongai_replace_walkthrough', arguments: { schemaVersion: 1, requestId: replacement.id, expectedSessionId: old.id, expectedRevision: old.revision, origin: { ...origin, stopId: 'replacement', document: 'pricing.ts' } } });
      assert.equal(replaced.isError, undefined);
      const current = authority.getSession()!;
      const reset = authority.captureReset();
      const cleared = await client.callTool({ name: 'codealongai_reset_walkthrough', arguments: { schemaVersion: 1, requestId: reset.id, expectedSessionId: current.id, expectedRevision: current.revision } });
      assert.deepEqual(cleared.structuredContent, { schemaVersion: 1, status: 'committed', requestId: reset.id, sessionId: current.id, revision: current.revision });
      assert.equal(authority.getSession(), undefined);
    } finally { await transport.close(); await endpoint.stop(); }
  });
});

suite('question-generated walkthrough graph', () => {
  test('commits an injected generated graph atomically over the real loopback boundary', async () => {
    const authority = new WalkthroughAuthority();
    const origin = { stopId: 'checkout-origin', displayName: 'Origin', explanation: 'Ask away', document: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 22 } } };
    const start = authority.captureStart(origin);
    authority.start(start.id, origin);
    const question = authority.captureQuestion('checkout-origin', 'Walk me through this code');
    const endpoint = new LoopbackMcpEndpoint(authority, memorySource([{ path: 'checkout.ts', text: "import { subtotal } from './pricing';\n\nconst cart = [12, 18];\n", dirty: false }, { path: 'pricing.ts', text: 'export function subtotal(prices: readonly number[]): number {\n  return prices.reduce((total, price) => total - price, 0);\n}\n', dirty: false }]));
    await endpoint.start(0);
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp`));
    const client = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(transport);
    const outcome: QuestionOutcome = { kind: 'generated-walkthrough', answerMarkdown: 'Here is the flow.', patch: {
      addedStops: [
        { id: 'pricing-function', displayName: 'Definition', explanationMarkdown: 'Definition', path: 'pricing.ts', range: { start: { line: 0, character: 16 }, end: { line: 0, character: 51 } }, destinationIds: ['pricing-reducer'], recommendedNextId: 'pricing-reducer', backId: 'checkout-origin' },
        { id: 'pricing-reducer', displayName: 'Reducer', explanationMarkdown: 'Reducer', path: 'pricing.ts', range: { start: { line: 1, character: 41 }, end: { line: 1, character: 54 } }, destinationIds: ['pricing-reducer-revisit'], recommendedNextId: 'pricing-reducer-revisit', backId: 'pricing-function' },
        { id: 'pricing-reducer-revisit', displayName: 'Reducer', explanationMarkdown: 'Revisit', path: 'pricing.ts', range: { start: { line: 1, character: 41 }, end: { line: 1, character: 54 } }, destinationIds: [], backId: 'pricing-reducer' },
        { id: 'checkout-cart', displayName: 'Cart input', explanationMarkdown: 'Cart', path: 'checkout.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 22 } }, destinationIds: ['pricing-function'], recommendedNextId: 'pricing-function', backId: 'checkout-origin' }
      ],
      appendedDestinations: [{ sourceStopId: 'checkout-origin', destinationIds: ['pricing-function', 'checkout-cart'] }],
      recommendedNextUpdates: [{ sourceStopId: 'checkout-origin', targetStopId: 'pricing-function' }]
    } };
    try {
      const committed = await client.callTool({ name: 'codealongai_commit_question_outcome', arguments: { schemaVersion: 1, requestId: question.id, expectedSessionId: authority.getSession()!.id, expectedRevision: 1, outcome } });
      assert.deepEqual(committed.structuredContent, { schemaVersion: 1, status: 'committed', requestId: question.id, sessionId: authority.getSession()!.id, revision: 2, attentionStopId: 'checkout-origin' });
      assert.equal(authority.acknowledgeQuestionReceipt(committed.structuredContent as import('../walkthrough').QuestionReceipt), true);
      for (const nextOutcome of [
        { kind: 'explanation-only', answerMarkdown: '**Opaque** Markdown is not an instruction.' },
        { kind: 'destination-offer', answerMarkdown: 'A metadata-only offer.', destinationIds: ['pricing-function', 'checkout-cart'] },
        { kind: 'explicit-unsupported', answerMarkdown: 'This request is _unsupported_.' }
      ] as const) {
        const followUpQuestion = authority.captureQuestion('checkout-origin', `Follow-up: ${nextOutcome.kind}`);
        const currentSession = authority.getSession()!;
        const reply = await client.callTool({ name: 'codealongai_commit_question_outcome', arguments: { schemaVersion: 1, requestId: followUpQuestion.id, expectedSessionId: currentSession.id, expectedRevision: currentSession.revision, outcome: nextOutcome } });
        assert.notEqual(reply.isError, true);
        assert.equal(authority.acknowledgeQuestionReceipt(reply.structuredContent as import('../walkthrough').QuestionReceipt), true);
        assert.equal(authority.getSession()!.attentionStopId, 'checkout-origin');
      }
      const snapshot = await client.callTool({ name: 'codealongai_get_walkthrough', arguments: {} });
      const stops = (snapshot.structuredContent as { stops: { id: string; destinationIds: string[]; conversation: unknown[] }[] }).stops;
      assert.deepEqual(stops.map((stop) => stop.id), ['checkout-origin', 'pricing-function', 'pricing-reducer', 'pricing-reducer-revisit', 'checkout-cart']);
      assert.deepEqual(stops[0].destinationIds, ['pricing-function', 'checkout-cart']);
      assert.equal(stops[2].id, 'pricing-reducer');
      assert.equal(stops[3].id, 'pricing-reducer-revisit');
      assert.equal(stops[2].conversation.length, 0);
      assert.deepEqual(stops[0].conversation.slice(0, 3), [{ author: 'CodeAlongAI', bodyMarkdown: 'Ask away' }, { author: 'You', bodyMarkdown: 'Walk me through this code' }, { author: 'CodeAlongAI', bodyMarkdown: 'Here is the flow.' }]);
    } finally { await transport.close(); await endpoint.stop(); }
  });
});

suite('non-branching question outcomes and recovery', () => {
  const origin = { stopId: 'checkout-origin', displayName: 'Origin', explanation: 'Ask away', document: 'checkout.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } } };
  const createStartedAuthority = (): WalkthroughAuthority => {
    const authority = new WalkthroughAuthority();
    const request = authority.captureStart(origin);
    authority.start(request.id, origin);
    return authority;
  };

  test('keeps ordinary outcomes opaque and leaves graph attention unchanged', () => {
    for (const outcome of [
      { kind: 'explanation-only', answerMarkdown: '**not a command** [next](#ignored)' },
      { kind: 'explicit-unsupported', answerMarkdown: 'I cannot do that, but this is still *Markdown*.' }
    ] as const) {
      const authority = createStartedAuthority();
      const request = authority.captureQuestion(origin.stopId, 'Why?');
      const before = authority.getSession()!;
      const receipt = authority.commitQuestionOutcome({ requestId: request.id, sessionId: before.id, revision: before.revision }, outcome);
      assert.equal(authority.acknowledgeQuestionReceipt(receipt), true);
      const after = authority.getSession()!;
      assert.equal(after.attentionStopId, before.attentionStopId);
      assert.deepEqual(after.stops.map((stop) => stop.id), before.stops.map((stop) => stop.id));
      assert.equal(after.stops[0].conversation.at(-1)?.bodyMarkdown, outcome.answerMarkdown);
    }
  });

  test('keeps a tentative question candidate private until its exact receipt is accepted or discarded', () => {
    const authority = createStartedAuthority();
    const before = authority.getSession()!;
    const request = authority.captureQuestion(origin.stopId, 'Add a child');
    const receipt = authority.commitQuestionOutcome({ requestId: request.id, sessionId: before.id, revision: before.revision }, { kind: 'generated-walkthrough', answerMarkdown: 'Added privately.', patch: { addedStops: [{ id: 'child', displayName: 'Child', explanationMarkdown: 'Child', path: 'child.ts', range: origin.range, destinationIds: [], backId: origin.stopId }], appendedDestinations: [{ sourceStopId: origin.stopId, destinationIds: ['child'] }], recommendedNextUpdates: [] } });
    assert.deepEqual(authority.getSession(), before);
    authority.discardQuestion(request.id);
    assert.deepEqual(authority.getSession(), before);
    const replacement = authority.captureQuestion(origin.stopId, 'Answer instead');
    const replacementReceipt = authority.commitQuestionOutcome({ requestId: replacement.id, sessionId: before.id, revision: before.revision }, { kind: 'explanation-only', answerMarkdown: 'Accepted once.' });
    assert.equal(authority.acknowledgeQuestionReceipt(replacementReceipt), true);
    assert.equal(authority.acknowledgeQuestionReceipt(replacementReceipt), false);
    assert.deepEqual(authority.getSession()!.stops.map((stop) => stop.id), [origin.stopId]);
    assert.equal(authority.getSession()!.stops[0].conversation.at(-1)?.bodyMarkdown, 'Accepted once.');
    assert.equal(receipt.revision, before.revision + 1);
  });

  test('validates a destination offer without changing the graph or attention', () => {
    const authority = createStartedAuthority();
    const generated = authority.captureQuestion(origin.stopId, 'Add a destination');
    const session = authority.getSession()!;
    const generatedReceipt = authority.commitQuestionOutcome({ requestId: generated.id, sessionId: session.id, revision: session.revision }, { kind: 'generated-walkthrough', answerMarkdown: 'Added.', patch: { addedStops: [{ id: 'child', displayName: 'Child', explanationMarkdown: 'Child', path: 'child.ts', range: origin.range, destinationIds: [], backId: origin.stopId }], appendedDestinations: [{ sourceStopId: origin.stopId, destinationIds: ['child'] }], recommendedNextUpdates: [] } });
    assert.equal(authority.acknowledgeQuestionReceipt(generatedReceipt), true);
    const request = authority.captureQuestion(origin.stopId, 'Where next?');
    const before = authority.getSession()!;
    const receipt = authority.commitQuestionOutcome({ requestId: request.id, sessionId: before.id, revision: before.revision }, { kind: 'destination-offer', answerMarkdown: 'Try child.', destinationIds: ['child'] });
    assert.equal(authority.acknowledgeQuestionReceipt(receipt), true);
    const after = authority.getSession()!;
    assert.equal(after.attentionStopId, origin.stopId);
    assert.deepEqual(after.stops.map((stop) => ({ id: stop.id, destinationIds: stop.destinationIds })), before.stops.map((stop) => ({ id: stop.id, destinationIds: stop.destinationIds })));
  });

  test('preserves a terminal receipt for an identical delayed retry and rejects invalid outcomes atomically', () => {
    const authority = createStartedAuthority();
    const request = authority.captureQuestion(origin.stopId, 'Why?');
    const session = authority.getSession()!;
    const outcome: QuestionOutcome = { kind: 'explanation-only', answerMarkdown: 'Answer.' };
    const receipt = authority.commitQuestionOutcome({ requestId: request.id, sessionId: session.id, revision: session.revision }, outcome);
    assert.deepEqual(authority.commitQuestionOutcome({ requestId: request.id, sessionId: session.id, revision: session.revision }, outcome), receipt);
    assert.equal(authority.acknowledgeQuestionReceipt(receipt), true);
    const next = authority.captureQuestion(origin.stopId, 'Offer?');
    const before = authority.getSession()!;
    assert.throws(() => authority.commitQuestionOutcome({ requestId: next.id, sessionId: before.id, revision: before.revision }, { kind: 'destination-offer', answerMarkdown: 'Bad', destinationIds: [origin.stopId] }));
    assert.deepEqual(authority.getSession(), before);
    authority.discardQuestion();
    assert.throws(() => authority.commitQuestionOutcome({ requestId: next.id, sessionId: before.id, revision: before.revision }, outcome));
  });
});

suite('walkthrough navigation', () => {
  const origin = { stopId: 'origin', displayName: 'Origin', explanation: 'Start', document: 'checkout.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } };
  const startedAuthority = (): WalkthroughAuthority => {
    const authority = new WalkthroughAuthority();
    const start = authority.captureStart(origin);
    authority.start(start.id, origin);
    const question = authority.captureQuestion(origin.stopId, 'Add stops');
    const session = authority.getSession()!;
    const receipt = authority.commitQuestionOutcome({ requestId: question.id, sessionId: session.id, revision: session.revision }, { kind: 'generated-walkthrough', answerMarkdown: 'Added.', patch: { addedStops: [
      { id: 'same-file', displayName: 'Same', explanationMarkdown: 'Same', path: 'checkout.ts', range: origin.range, destinationIds: ['other-file'], recommendedNextId: 'other-file', backId: 'origin' },
      { id: 'other-file', displayName: 'Other', explanationMarkdown: 'Other', path: 'pricing.ts', range: origin.range, destinationIds: [], backId: 'same-file' }
    ], appendedDestinations: [{ sourceStopId: 'origin', destinationIds: ['same-file'] }], recommendedNextUpdates: [{ sourceStopId: 'origin', targetStopId: 'same-file' }] } });
    authority.acknowledgeQuestionReceipt(receipt);
    return authority;
  };

  test('uses graph Back and producer-selected Next, never visit history', () => {
    const authority = startedAuthority();
    const before = authority.getSession()!;
    assert.deepEqual(authority.navigate({ sessionId: before.id, revision: before.revision, sourceStopId: 'origin', direction: 'next' }), { schemaVersion: 1, sessionId: before.id, revision: before.revision + 1, attentionStopId: 'same-file', sourceStopId: 'origin', targetStopId: 'same-file' });
    const afterNext = authority.getSession()!;
    assert.equal(authority.navigate({ sessionId: afterNext.id, revision: afterNext.revision, sourceStopId: 'same-file', direction: 'back' }).targetStopId, 'origin');
  });

  test('uses an explicitly supplied historical source instead of current attention', () => {
    const authority = startedAuthority();
    let session = authority.getSession()!;
    authority.navigate({ sessionId: session.id, revision: session.revision, sourceStopId: 'origin', direction: 'next' });
    session = authority.getSession()!;
    authority.navigate({ sessionId: session.id, revision: session.revision, sourceStopId: 'same-file', direction: 'next' });
    session = authority.getSession()!;
    const receipt = authority.navigate({ sessionId: session.id, revision: session.revision, sourceStopId: 'same-file', direction: 'back' });
    assert.equal(receipt.targetStopId, 'origin');
    assert.equal(receipt.attentionStopId, 'origin');
  });

  test('navigates directly to every known destination without inferring a graph edge', () => {
    const authority = startedAuthority();
    for (const targetStopId of ['origin', 'same-file', 'other-file']) {
      const session = authority.getSession()!;
      const receipt = authority.navigateDestination({ sessionId: session.id, revision: session.revision, targetStopId });
      assert.equal(receipt.targetStopId, targetStopId);
      assert.equal(authority.getSession()!.attentionStopId, targetStopId);
    }
  });

  test('rejects terminal and stale navigation without changing the session', () => {
    const authority = startedAuthority();
    const session = authority.getSession()!;
    assert.throws(() => authority.navigate({ sessionId: session.id, revision: session.revision, sourceStopId: 'other-file', direction: 'next' }));
    assert.throws(() => authority.navigate({ sessionId: session.id, revision: session.revision - 1, sourceStopId: 'origin', direction: 'next' }));
    assert.deepEqual(authority.getSession(), session);
  });

  test('navigates through the real loopback endpoint and reports conflicts', async () => {
    const authority = startedAuthority();
    const endpoint = new LoopbackMcpEndpoint(authority);
    await endpoint.start(0);
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp`));
    const client = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(transport);
    try {
      const session = authority.getSession()!;
      const moved = await client.callTool({ name: 'codealongai_navigate_walkthrough', arguments: { schemaVersion: 1, expectedSessionId: session.id, expectedRevision: session.revision, sourceStopId: 'origin', direction: 'next' } });
      assert.deepEqual(moved.structuredContent, { schemaVersion: 1, sessionId: session.id, revision: session.revision + 1, attentionStopId: 'same-file', sourceStopId: 'origin', targetStopId: 'same-file' });
      const conflict = await client.callTool({ name: 'codealongai_navigate_walkthrough', arguments: { schemaVersion: 1, expectedSessionId: session.id, expectedRevision: session.revision, sourceStopId: 'origin', direction: 'next' } });
      assert.equal(conflict.isError, true);
      assert.equal(authority.getSession()!.revision, session.revision + 1);
      const direct = await client.callTool({ name: 'codealongai_navigate_walkthrough', arguments: { schemaVersion: 1, expectedSessionId: authority.getSession()!.id, expectedRevision: authority.getSession()!.revision, targetStopId: 'other-file' } });
      assert.deepEqual(direct.structuredContent, { schemaVersion: 1, sessionId: session.id, revision: session.revision + 2, attentionStopId: 'other-file', sourceStopId: 'same-file', targetStopId: 'other-file' });
      const malformed = await client.callTool({ name: 'codealongai_navigate_walkthrough', arguments: { schemaVersion: 1, expectedSessionId: session.id, expectedRevision: session.revision + 2, targetStopId: 'other-file', direction: 'next' } });
      assert.equal(malformed.isError, true);
    } finally { await transport.close(); await endpoint.stop(); }
  });
});

suite('walkthrough destination projection', () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
  test('emits a recommended-first spanning tree, keeps same-range identities, and marks rejoins on their source', () => {
    const session: WalkthroughSession = { id: 'walkthrough', revision: 1, attentionStopId: 'again', origin: { stopId: 'origin', displayName: 'Origin', explanation: 'Start', document: 'a.ts', range }, stops: [
      { id: 'origin', stopId: 'origin', displayName: 'Origin', explanation: 'Start', document: 'a.ts', range, destinationIds: ['alternative', 'recommended'], recommendedNextId: 'recommended', conversation: [] },
      { id: 'recommended', stopId: 'recommended', displayName: 'Reducer', explanation: '', document: 'a.ts', range, destinationIds: ['again'], conversation: [] },
      { id: 'again', stopId: 'again', displayName: 'Reducer', explanation: '', document: 'a.ts', range, destinationIds: [], conversation: [] },
      { id: 'alternative', stopId: 'alternative', displayName: 'Alternative', explanation: '', document: 'b.ts', range, destinationIds: ['again'], conversation: [] }
    ] };
    assert.deepEqual(projectDestinations(session), [
      { stopId: 'origin', depth: 0, isLast: true, ancestorIsLast: [], rejoinDisplayNames: [] },
      { stopId: 'recommended', depth: 1, isLast: false, ancestorIsLast: [true], rejoinDisplayNames: [] },
      { stopId: 'again', depth: 2, isLast: true, ancestorIsLast: [true, false], rejoinDisplayNames: [] },
      { stopId: 'alternative', depth: 1, isLast: true, ancestorIsLast: [true], rejoinDisplayNames: ['Reducer'] }
    ]);
  });

  test('renders only graph data and marks only current attention with a location icon', () => {
    const session: WalkthroughSession = { id: 'walkthrough', revision: 1, attentionStopId: 'second', origin: { stopId: 'origin', displayName: 'Origin', explanation: '', document: 'a.ts', range }, stops: [
      { id: 'origin', stopId: 'origin', displayName: 'Origin', explanation: '', document: 'a.ts', range, destinationIds: ['second'], recommendedNextId: 'second', conversation: [] },
      { id: 'second', stopId: 'second', displayName: 'Reducer', explanation: '', document: 'a.ts', range, destinationIds: [], conversation: [] }
    ] };
    assert.deepEqual(destinationQuickPickItems(session).map((item) => item.label), ['Origin L1:C1', '   └─ $(location) Reducer L1:C1']);
  });

  test('assigns stable ordinals to same-range thread identities and adds Initial value without moving attention', () => {
    const session: WalkthroughSession = { id: 'walkthrough', revision: 4, attentionStopId: 'pricing-reducer', origin: { stopId: 'origin', displayName: 'Origin', explanation: '', document: 'checkout.ts', range }, stops: [
      { id: 'origin', stopId: 'origin', displayName: 'Origin', explanation: '', document: 'checkout.ts', range, destinationIds: ['pricing-function'], conversation: [] },
      { id: 'pricing-function', stopId: 'pricing-function', displayName: 'Definition', explanation: '', document: 'pricing.ts', range, destinationIds: ['pricing-reducer'], conversation: [] },
      { id: 'pricing-reducer', stopId: 'pricing-reducer', displayName: 'Reducer', explanation: '', document: 'pricing.ts', range, destinationIds: ['pricing-reducer-revisit'], recommendedNextId: 'pricing-reducer-revisit', conversation: [] },
      { id: 'pricing-reducer-revisit', stopId: 'pricing-reducer-revisit', displayName: 'Reducer', explanation: '', document: 'pricing.ts', range, destinationIds: [], conversation: [] }
    ] };
    assert.equal(threadLabel(session.stops[2], session), 'CodeAlongAI · Reducer (1)');
    assert.equal(threadLabel(session.stops[3], session), 'CodeAlongAI · Reducer (2)');
    assert.deepEqual(deterministicQuestionOutcome(session), { kind: 'generated-walkthrough', answerMarkdown: 'The reducer begins with its initial value.', patch: { addedStops: [
      { id: 'initial-value', displayName: 'Initial value', explanationMarkdown: 'The reduction starts from its initial value.', path: 'pricing.ts', range: { start: { line: 1, character: 41 }, end: { line: 1, character: 42 } }, destinationIds: [], backId: 'pricing-reducer-revisit' }
    ], appendedDestinations: [{ sourceStopId: 'pricing-reducer-revisit', destinationIds: ['initial-value'] }], recommendedNextUpdates: [] } });
  });
});
