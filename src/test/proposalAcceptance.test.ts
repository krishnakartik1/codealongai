import assert from 'node:assert/strict';
import { ProposalAcceptanceAuthority } from '../proposalAcceptance';
import type { ProposalCapture } from '../interaction';

const proposal: ProposalCapture = {
  target: {
    document: 'pricing.ts',
    range: { start: { line: 1, character: 47 }, end: { line: 1, character: 48 } }
  },
  baseDocumentVersion: 23,
  stagedContents: 'export function subtotal() { return total + price; }'
};

suite('proposal acceptance authority', () => {
  test('applies the staged known proposal when the live document version still matches', async () => {
    let contents = 'export function subtotal() { return total - price; }';
    const authority = new ProposalAcceptanceAuthority({
      applyIfVersionMatches: async (candidate) => {
        contents = candidate.stagedContents;
        return { outcome: 'applied' };
      }
    });

    authority.beginAcceptance(proposal);
    const result = await authority.accept();

    assert.deepEqual(result, { outcome: 'applied' });
    assert.equal(contents, proposal.stagedContents);
  });

  test('refuses a changed document without applying any part of the proposal', async () => {
    const originalContents = 'export function subtotal() { return total - price; }\n// human edit';
    let contents = originalContents;
    let applicationCalls = 0;
    const authority = new ProposalAcceptanceAuthority({
      applyIfVersionMatches: async () => {
        applicationCalls += 1;
        return { outcome: 'stale' };
      }
    });

    authority.beginAcceptance(proposal);
    const result = await authority.accept();

    assert.deepEqual(result, { outcome: 'stale' });
    assert.equal(applicationCalls, 1);
    assert.equal(contents, originalContents);
  });

  test('cancels an in-flight acceptance before the document gateway can mutate', async () => {
    let releaseGateway: (() => void) | undefined;
    let gatewayWouldMutate = false;
    const authority = new ProposalAcceptanceAuthority({
      applyIfVersionMatches: async (_candidate, current) => {
        await new Promise<void>((resolve) => { releaseGateway = resolve; });
        gatewayWouldMutate = current();
        return gatewayWouldMutate ? { outcome: 'applied' } : { outcome: 'cancelled' };
      }
    });

    authority.beginAcceptance(proposal);
    const acceptance = authority.accept();
    authority.cancelAcceptance();
    assert.ok(releaseGateway);
    releaseGateway();
    const result = await acceptance;

    assert.deepEqual(result, { outcome: 'cancelled' });
    assert.equal(gatewayWouldMutate, false);
  });
});
