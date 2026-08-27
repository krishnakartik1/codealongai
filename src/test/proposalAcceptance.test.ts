import assert from 'node:assert/strict';
import { ProposalAcceptanceAuthority } from '../proposalAcceptance';
import type { ProposalCapture, ProposalMutationRequest } from '../interaction';

const proposal: ProposalCapture = {
  target: {
    document: 'pricing.ts',
    range: { start: { line: 1, character: 47 }, end: { line: 1, character: 48 } }
  },
  baseDocumentVersion: 23,
  baseContents: 'export function subtotal() { return total - price; }',
  replacement: '+',
  stagedContents: 'export function subtotal() { return total + price; }'
};

function proposalMutationRequest(requestId = 1): ProposalMutationRequest {
  return { ...proposal, requestId };
}

suite('proposal acceptance authority', () => {
  test('applies the staged known proposal when the live document version still matches', async () => {
    let contents = 'export function subtotal() { return total - price; }';
    const authority = new ProposalAcceptanceAuthority({
      applyIfVersionMatches: async (candidate) => {
        contents = candidate.stagedContents;
        return { outcome: 'applied' };
      }
    });

    const acceptanceRequest = proposalMutationRequest();
    authority.beginAcceptance(acceptanceRequest);
    const result = await authority.accept(acceptanceRequest);

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

    const acceptanceRequest = proposalMutationRequest();
    authority.beginAcceptance(acceptanceRequest);
    const result = await authority.accept(acceptanceRequest);

    assert.deepEqual(result, { outcome: 'stale' });
    assert.equal(applicationCalls, 1);
    assert.equal(contents, originalContents);
  });

  test('cancels an acceptance before the document gateway can mutate', async () => {
    let releaseGateway: (() => void) | undefined;
    let gatewayWouldMutate = false;
    const authority = new ProposalAcceptanceAuthority({
      applyIfVersionMatches: async (_candidate, current) => {
        await new Promise<void>((resolve) => { releaseGateway = resolve; });
        gatewayWouldMutate = current();
        return gatewayWouldMutate ? { outcome: 'applied' } : { outcome: 'cancelled' };
      }
    });

    const acceptanceRequest = proposalMutationRequest();
    authority.beginAcceptance(acceptanceRequest);
    const acceptance = authority.accept(acceptanceRequest);
    authority.cancelAcceptance();
    assert.ok(releaseGateway);
    releaseGateway();
    const result = await acceptance;

    assert.deepEqual(result, { outcome: 'cancelled' });
    assert.equal(gatewayWouldMutate, false);
  });

  test('waits for a submitted document edit instead of reporting it as a cancelled no-op', async () => {
    let releaseEdit: (() => void) | undefined;
    let contents = proposal.baseContents;
    const authority = new ProposalAcceptanceAuthority({
      applyIfVersionMatches: async (candidate, _current, beginApplication) => {
        assert.equal(beginApplication(), true);
        await new Promise<void>((resolve) => { releaseEdit = resolve; });
        contents = candidate.stagedContents;
        return { outcome: 'applied' };
      }
    });

    const acceptanceRequest = proposalMutationRequest();
    authority.beginAcceptance(acceptanceRequest);
    const acceptance = authority.accept(acceptanceRequest);
    const cancellation = authority.cancelAcceptance();
    assert.ok(releaseEdit);
    releaseEdit();

    assert.deepEqual(await acceptance, { outcome: 'applied' });
    await cancellation;
    assert.equal(contents, proposal.stagedContents);
  });

  test('starts one gateway acceptance for concurrent attempts for the same request', async () => {
    let gatewayCalls = 0;
    let releaseGateway: (() => void) | undefined;
    const authority = new ProposalAcceptanceAuthority({
      applyIfVersionMatches: async () => {
        gatewayCalls += 1;
        await new Promise<void>((resolve) => { releaseGateway = resolve; });
        return { outcome: 'applied' };
      }
    });
    const acceptanceRequest = proposalMutationRequest();

    assert.equal(authority.beginAcceptance(acceptanceRequest), true);
    const first = authority.accept(acceptanceRequest);
    const second = authority.accept(acceptanceRequest);
    assert.equal(first, second);
    assert.equal(gatewayCalls, 1);
    assert.ok(releaseGateway);
    releaseGateway();

    assert.deepEqual(await first, { outcome: 'applied' });
  });

  test('does not repeat a completed gateway acceptance for the same request identity', async () => {
    let gatewayCalls = 0;
    const authority = new ProposalAcceptanceAuthority({
      applyIfVersionMatches: async () => {
        gatewayCalls += 1;
        return { outcome: 'applied' };
      }
    });
    const acceptanceRequest = proposalMutationRequest();

    authority.beginAcceptance(acceptanceRequest);
    assert.deepEqual(await authority.accept(acceptanceRequest), { outcome: 'applied' });
    assert.equal(authority.beginAcceptance(acceptanceRequest), true);
    assert.deepEqual(await authority.accept(acceptanceRequest), { outcome: 'applied' });

    assert.equal(gatewayCalls, 1);
  });

  test('does not let an old completion clear a new request after cancellation', async () => {
    let releaseOldGateway: (() => void) | undefined;
    const authority = new ProposalAcceptanceAuthority({
      applyIfVersionMatches: async (candidate) => {
        if (candidate.requestId === 1) {
          await new Promise<void>((resolve) => { releaseOldGateway = resolve; });
        }
        return { outcome: 'applied' };
      }
    });
    const oldRequest = proposalMutationRequest(1);
    const newRequest = proposalMutationRequest(2);

    authority.beginAcceptance(oldRequest);
    const oldAcceptance = authority.accept(oldRequest);
    await authority.cancelAcceptance();
    assert.equal(authority.beginAcceptance(newRequest), true);
    assert.ok(releaseOldGateway);
    releaseOldGateway();
    assert.deepEqual(await oldAcceptance, { outcome: 'cancelled' });

    assert.deepEqual(await authority.accept(newRequest), { outcome: 'applied' });
  });

  test('turns a gateway exception into a failed terminal result', async () => {
    const authority = new ProposalAcceptanceAuthority({
      applyIfVersionMatches: async () => { throw new Error('disk is unavailable'); }
    });
    const acceptanceRequest = proposalMutationRequest();

    authority.beginAcceptance(acceptanceRequest);

    assert.deepEqual(await authority.accept(acceptanceRequest), { outcome: 'failed' });
  });
});
