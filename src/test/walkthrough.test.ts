import assert from 'node:assert/strict';
import { deriveOrigin, projectDestinations, WalkthroughAuthority, type QuestionOutcome, type WalkthroughSession } from '../walkthrough';
import { WorkspaceReader } from '../workspace';
import type { WorkspaceFile, WorkspaceSource } from '../workspace';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { LoopbackMcpEndpoint } from '../mcp';
import { destinationQuickPickItems, deterministicQuestionOutcome, threadLabel } from '../extension';

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
    assert.deepEqual(destinationQuickPickItems(session).map((item) => item.label), ['Origin L1:C1', '$(location)    └─ Reducer L1:C1']);
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
