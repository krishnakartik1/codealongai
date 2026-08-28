import assert from 'node:assert/strict';
import { deriveOrigin, WalkthroughAuthority } from '../walkthrough';

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
