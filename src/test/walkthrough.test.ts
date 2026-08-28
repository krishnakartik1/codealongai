import assert from 'node:assert/strict';
import { deriveOrigin, WalkthroughAuthority, type QuestionOutcome } from '../walkthrough';
import { WorkspaceReader } from '../workspace';
import type { WorkspaceFile, WorkspaceSource } from '../workspace';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { LoopbackMcpEndpoint } from '../mcp';

const memorySource = (files: readonly WorkspaceFile[], count = 1): WorkspaceSource => ({ workspaceFolderCount: () => count, listFiles: async () => files.map((file) => file.path), readFile: async (requested) => files.find((file) => file.path.replace(/\\/g, '/') === requested) ?? { path: requested, dirty: false, failure: 'file_unsupported' } });

suite('walkthrough start authority', () => {
  test('uses the complete nonblank cursor line when there is no selection', () => {
    assert.deepEqual(deriveOrigin('checkout.ts', {
      start: { line: 2, character: 4 }, end: { line: 2, character: 4 }
    }, '  return subtotal(cart);'), {
      document: 'checkout.ts',
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 24 } }
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
      const snapshot = await client.callTool({ name: 'codealongai_get_walkthrough', arguments: {} });
      const stops = (snapshot.structuredContent as { stops: { id: string; destinationIds: string[]; conversation: unknown[] }[] }).stops;
      assert.deepEqual(stops.map((stop) => stop.id), ['checkout-origin', 'pricing-function', 'pricing-reducer', 'pricing-reducer-revisit', 'checkout-cart']);
      assert.deepEqual(stops[0].destinationIds, ['pricing-function', 'checkout-cart']);
      assert.equal(stops[2].id, 'pricing-reducer');
      assert.equal(stops[3].id, 'pricing-reducer-revisit');
      assert.equal(stops[2].conversation.length, 0);
      assert.deepEqual(stops[0].conversation, [{ author: 'CodeAlongAI', bodyMarkdown: 'Ask away' }, { author: 'You', bodyMarkdown: 'Walk me through this code' }, { author: 'CodeAlongAI', bodyMarkdown: 'Here is the flow.' }]);
    } finally { await transport.close(); await endpoint.stop(); }
  });
});
