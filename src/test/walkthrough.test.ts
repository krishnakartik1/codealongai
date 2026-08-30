import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import * as vscode from 'vscode';
import { deriveOrigin, projectDestinations, WalkthroughAuthority, type QuestionOutcome, type WalkthroughSession } from '../walkthrough';
import { WorkspaceReader } from '../workspace';
import type { WorkspaceFile, WorkspaceSource } from '../workspace';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { LoopbackMcpEndpoint } from '../mcp';
import { commentThreadOptions, destinationQuickPickItems, deterministicQuestionOutcome, navigationContext, threadComments, threadLabel } from '../extension';
import { McpLifecycle } from '../lifecycle';

interface WalkthroughTestApi {
  readonly endpointState: string;
  readonly session: WalkthroughSession | undefined;
  replyTargetAt(stopId: string): object | undefined;
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

suite('Extension Development Host walkthrough', () => {
  test('starts at the learner selection and commits the first deterministic branch through a native reply', async () => {
    const api = await activeWalkthrough();
    await withMcpEnabled(api, async () => {
      const workspace = vscode.workspace.workspaceFolders?.[0];
      assert.ok(workspace, 'the approved two-file workspace should be open');
      const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspace.uri, 'checkout.ts'));
      const editor = await vscode.window.showTextDocument(document);
      const selection = new vscode.Selection(2, 0, 2, 22);
      editor.selection = selection;
      const sourceBefore = document.getText();

      await vscode.commands.executeCommand('codealongai.walkthrough.ask');
      const origin = await eventually(() => api.session, 'the public Ask command should create a walkthrough session');
      assert.deepEqual(origin.origin, {
      stopId: 'checkout-origin',
      displayName: 'Origin',
      explanation: 'What would you like to understand about this code?',
      document: 'checkout.ts',
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 22 } }
      });

      const replyTarget = await eventually(() => api.replyTargetAt('checkout-origin'), 'the origin should render a native CodeAlongAI comment thread');
      assert.equal(Object.isFrozen(replyTarget), true);
      await vscode.commands.executeCommand('codealongai.walkthrough.submitComment', { thread: replyTarget, text: 'Follow this value.' });
      const branched = await eventually(() => api.session?.stops.length === 5 ? api.session : undefined, 'the native reply should grow the deterministic first branch');
      assert.deepEqual(branched.stops.map((stop) => stop.id), ['checkout-origin', 'pricing-function', 'pricing-reducer', 'pricing-reducer-revisit', 'checkout-cart']);
      assert.equal(document.getText(), sourceBefore);
      assert.deepEqual(editor.selection, selection);

      await vscode.commands.executeCommand('codealongai.walkthrough.next');
      const definitionSession = await eventually(() => api.session?.attentionStopId === 'pricing-function' ? api.session : undefined, 'the public Next command should move walkthrough attention to Definition');
      const definitionReplyTarget = await eventually(() => api.replyTargetAt(definitionSession.attentionStopId), 'Definition should render a native CodeAlongAI comment thread');
      await vscode.commands.executeCommand('codealongai.walkthrough.submitComment', { thread: definitionReplyTarget, text: 'Where does the reducer start?' });
      const complete = await eventually(() => api.session?.stops.length === 6 ? api.session : undefined, 'the second native reply should add Initial value');
      assert.deepEqual(complete.stops.map((stop) => stop.id), ['checkout-origin', 'pricing-function', 'pricing-reducer', 'pricing-reducer-revisit', 'checkout-cart', 'initial-value']);
      assert.equal(complete.attentionStopId, 'pricing-function');
      assert.equal(complete.stops.find((stop) => stop.id === 'initial-value')?.explanation, 'The reduction starts from its initial value.');
    });
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

const memorySource = (files: readonly WorkspaceFile[], count = 1): WorkspaceSource => ({ workspaceFolderCount: () => count, listFiles: async () => files.map((file) => file.path), readFile: async (requested) => files.find((file) => file.path.replace(/\\/g, '/') === requested) ?? { path: requested, dirty: false, failure: 'file_unsupported' } });

suite('walkthrough start authority', () => {
  test('publishes the stable walkthrough command, menu, and MCP-setting contract', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { contributes: { commands: { command: string; title: string; icon?: string }[]; menus: { commandPalette: { command: string; when: string }[]; 'comments/commentThread/context': { command: string; when: string; group?: string }[]; 'comments/commentThread/title': { command: string; when: string; group?: string }[] }; configuration: { properties: Record<string, { type: string; default: unknown; scope: string; description: string }> } }; keybindings?: unknown };
    assert.deepEqual(manifest.contributes.commands.filter((item) => item.command !== 'codealongai.walkthrough.submitComment').map(({ command, title }) => ({ command, title })), [
      { command: 'codealongai.walkthrough.ask', title: 'CodeAlongAI: Ask about this code' },
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
      'codealongai.mcp.enabled': { type: 'boolean', default: false, scope: 'window', description: 'Enable the local CodeAlongAI MCP endpoint.' }
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
    authority.commitQuestionOutcome({ requestId: question.id, sessionId: old.id, revision: old.revision }, { kind: 'explanation-only', answerMarkdown: 'Because.' });
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

suite('workspace context over loopback MCP', () => {
  test('exposes only normalized unsaved workspace text through the public tools', async () => {
    const endpoint = new LoopbackMcpEndpoint(new WalkthroughAuthority(), memorySource([{ path: 'src\\draft.ts', text: 'const draft = true;\n', dirty: true, documentVersion: 3 }]));
    await endpoint.start(0);
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp`));
    const client = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 10);
      const listed = await client.callTool({ name: 'codealongai_list_workspace_files', arguments: { schemaVersion: 1 } });
      assert.deepEqual(listed.structuredContent, { schemaVersion: 1, paths: ['src/draft.ts'] });
      const read = await client.callTool({ name: 'codealongai_read_workspace_file', arguments: { schemaVersion: 1, path: 'src/draft.ts' } });
      assert.deepEqual(read.structuredContent, { schemaVersion: 1, path: 'src/draft.ts', startLine: 0, endLine: 2, text: 'const draft = true;\n', dirty: true, documentVersion: 3 });
      const rejected = await client.callTool({ name: 'codealongai_read_workspace_file', arguments: { schemaVersion: 1, path: '../secret.ts' } });
      assert.equal(rejected.isError, true);
      assert.deepEqual(rejected.structuredContent, { schemaVersion: 1, code: 'path_outside_workspace', message: 'The requested workspace file is unavailable.', retryable: false });
    } finally {
      await transport.close();
      await endpoint.stop();
    }
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
      for (const nextOutcome of [
        { kind: 'explanation-only', answerMarkdown: '**Opaque** Markdown is not an instruction.' },
        { kind: 'destination-offer', answerMarkdown: 'A metadata-only offer.', destinationIds: ['pricing-function', 'checkout-cart'] },
        { kind: 'explicit-unsupported', answerMarkdown: 'This request is _unsupported_.' }
      ] as const) {
        const followUpQuestion = authority.captureQuestion('checkout-origin', `Follow-up: ${nextOutcome.kind}`);
        const currentSession = authority.getSession()!;
        const reply = await client.callTool({ name: 'codealongai_commit_question_outcome', arguments: { schemaVersion: 1, requestId: followUpQuestion.id, expectedSessionId: currentSession.id, expectedRevision: currentSession.revision, outcome: nextOutcome } });
        assert.notEqual(reply.isError, true);
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
      authority.commitQuestionOutcome({ requestId: request.id, sessionId: before.id, revision: before.revision }, outcome);
      const after = authority.getSession()!;
      assert.equal(after.attentionStopId, before.attentionStopId);
      assert.deepEqual(after.stops.map((stop) => stop.id), before.stops.map((stop) => stop.id));
      assert.equal(after.stops[0].conversation.at(-1)?.bodyMarkdown, outcome.answerMarkdown);
    }
  });

  test('validates a destination offer without changing the graph or attention', () => {
    const authority = createStartedAuthority();
    const generated = authority.captureQuestion(origin.stopId, 'Add a destination');
    const session = authority.getSession()!;
    authority.commitQuestionOutcome({ requestId: generated.id, sessionId: session.id, revision: session.revision }, { kind: 'generated-walkthrough', answerMarkdown: 'Added.', patch: { addedStops: [{ id: 'child', displayName: 'Child', explanationMarkdown: 'Child', path: 'child.ts', range: origin.range, destinationIds: [], backId: origin.stopId }], appendedDestinations: [{ sourceStopId: origin.stopId, destinationIds: ['child'] }], recommendedNextUpdates: [] } });
    const request = authority.captureQuestion(origin.stopId, 'Where next?');
    const before = authority.getSession()!;
    authority.commitQuestionOutcome({ requestId: request.id, sessionId: before.id, revision: before.revision }, { kind: 'destination-offer', answerMarkdown: 'Try child.', destinationIds: ['child'] });
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
    authority.commitQuestionOutcome({ requestId: question.id, sessionId: session.id, revision: session.revision }, { kind: 'generated-walkthrough', answerMarkdown: 'Added.', patch: { addedStops: [
      { id: 'same-file', displayName: 'Same', explanationMarkdown: 'Same', path: 'checkout.ts', range: origin.range, destinationIds: ['other-file'], recommendedNextId: 'other-file', backId: 'origin' },
      { id: 'other-file', displayName: 'Other', explanationMarkdown: 'Other', path: 'pricing.ts', range: origin.range, destinationIds: [], backId: 'same-file' }
    ], appendedDestinations: [{ sourceStopId: 'origin', destinationIds: ['same-file'] }], recommendedNextUpdates: [{ sourceStopId: 'origin', targetStopId: 'same-file' }] } });
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
