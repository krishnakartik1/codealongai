import assert from 'node:assert/strict';
import { deriveOrigin, WalkthroughAuthority } from '../walkthrough';
import { WorkspaceReader } from '../workspace';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { LoopbackMcpEndpoint } from '../mcp';

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
    const reader = new WorkspaceReader({ workspaceFolderCount: () => 1, files: async () => [{ path: 'src\\cart.ts', text: 'first\nsecond\nthird', dirty: true, documentVersion: 7 }] });
    assert.deepEqual(await reader.read('src/cart.ts', 1, 3), { path: 'src/cart.ts', startLine: 1, endLine: 3, text: 'second\nthird', dirty: true, documentVersion: 7 });
  });

  test('uses UTF-16 ordering and literal case-sensitive search previews', async () => {
    const reader = new WorkspaceReader({ workspaceFolderCount: () => 1, files: async () => [{ path: 'z.ts', text: 'needle', dirty: false }, { path: 'A.ts', text: `${'x'.repeat(100)}needle${'y'.repeat(120)}`, dirty: false }] });
    assert.deepEqual(await reader.list(), ['A.ts', 'z.ts']);
    const [match] = await reader.search('needle');
    assert.equal(match.path, 'A.ts');
    assert.equal(match.range.start.character, 100);
    assert.match(match.preview, /^…/);
    assert.match(match.preview, /…$/);
    assert.equal((await reader.search('NEEDLE')).length, 0);
  });

  test('does not disclose files when the workspace is unavailable or a path traverses it', async () => {
    const reader = new WorkspaceReader({ workspaceFolderCount: () => 0, files: async () => [{ path: 'secret.ts', text: 'secret', dirty: false }] });
    await assert.rejects(() => reader.list(), { code: 'workspace_unavailable' });
    const available = new WorkspaceReader({ workspaceFolderCount: () => 1, files: async () => [{ path: 'safe.ts', text: 'safe', dirty: false }] });
    await assert.rejects(() => available.read('../secret.ts'), { code: 'path_outside_workspace' });
  });
});

suite('workspace context over loopback MCP', () => {
  test('exposes only normalized unsaved workspace text through the public tools', async () => {
    const endpoint = new LoopbackMcpEndpoint(new WalkthroughAuthority(), { workspaceFolderCount: () => 1, files: async () => [{ path: 'src\\draft.ts', text: 'const draft = true;\n', dirty: true, documentVersion: 3 }] });
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
