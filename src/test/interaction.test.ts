import assert from 'node:assert/strict';
import {
  deterministicReplayFixture,
  type DocumentRange
} from '../replay';
import { InteractionController, type ProposalCapture } from '../interaction';
import type { ProposalAcceptanceResult } from '../proposalAcceptance';

const humanSelection: DocumentRange = {
  document: 'checkout.ts',
  range: {
    start: { line: 4, character: 31 },
    end: { line: 4, character: 39 }
  }
};

function stageKnownProposal(
  interaction: InteractionController,
  capture: ProposalCapture
) {
  interaction.start(humanSelection);
  interaction.advance();
  interaction.advance();
  interaction.acceptFollow();
  interaction.advance();
  return interaction.stageProposal(capture);
}

suite('shared attention interaction', () => {
  test('captures the human selection and points the named AI at it when Ask pair starts', () => {
    const interaction = new InteractionController(deterministicReplayFixture.events);

    const state = interaction.start(humanSelection);

    assert.deepEqual(state.humanSelection, humanSelection);
    assert.deepEqual(state.aiAttention, {
      name: 'CodeAlongAI',
      target: humanSelection
    });
    assert.equal(state.follow, 'not-following');
    assert.deepEqual(state.explanations, []);
  });

  test('requests consent before following the AI to an explanation in another file', () => {
    const interaction = new InteractionController(deterministicReplayFixture.events);

    interaction.start(humanSelection);
    interaction.advance();
    const state = interaction.advance();

    assert.deepEqual(state.aiAttention?.target, {
      document: 'pricing.ts',
      range: {
        start: { line: 1, character: 47 },
        end: { line: 1, character: 48 }
      }
    });
    assert.equal(state.follow, 'awaiting-consent');
    assert.deepEqual(state.followTarget, state.aiAttention?.target);
    assert.deepEqual(state.explanations, []);
  });

  test('pauses replay while a cross-file follow decision is awaiting consent', () => {
    const interaction = new InteractionController([
      deterministicReplayFixture.events[0]!,
      deterministicReplayFixture.events[2]!,
      deterministicReplayFixture.events[1]!
    ]);

    interaction.start(humanSelection);
    interaction.advance();
    const awaitingConsent = interaction.advance();

    assert.deepEqual(interaction.advance(), awaitingConsent);
    interaction.acceptFollow();
    assert.deepEqual(interaction.advance().aiAttention?.target, {
      document: 'checkout.ts',
      range: {
        start: { line: 0, character: 9 },
        end: { line: 0, character: 17 }
      }
    });
  });

  test('anchors a same-file explanation without requesting follow consent', () => {
    const interaction = new InteractionController([
      deterministicReplayFixture.events[0]!,
      {
        kind: 'explain',
        message: 'The checkout call uses the subtotal result.',
        target: {
          document: 'checkout.ts',
          range: { start: { line: 4, character: 31 }, end: { line: 4, character: 39 } }
        }
      }
    ]);

    interaction.start(humanSelection);
    const state = interaction.advance();

    assert.equal(state.follow, 'not-following');
    assert.deepEqual(state.explanations, [{
      message: 'The checkout call uses the subtotal result.',
      target: humanSelection
    }]);
  });

  test('follows by consent and anchors the explanation without changing the human selection', () => {
    const interaction = new InteractionController(deterministicReplayFixture.events);

    interaction.start(humanSelection);
    interaction.advance();
    interaction.advance();
    const state = interaction.acceptFollow();

    assert.equal(state.follow, 'following');
    assert.deepEqual(state.humanSelection, humanSelection);
    assert.deepEqual(state.explanations, [
      {
        message: 'Subtotal subtracts each price instead of adding it.',
        target: {
          document: 'pricing.ts',
          range: {
            start: { line: 1, character: 47 },
            end: { line: 1, character: 48 }
          }
        }
      }
    ]);
  });

  test('refuses a cross-file follow without revealing its explanation', () => {
    const interaction = new InteractionController(deterministicReplayFixture.events);

    interaction.start(humanSelection);
    interaction.advance();
    interaction.advance();
    const state = interaction.refuseFollow();

    assert.equal(state.follow, 'not-following');
    assert.equal(state.followTarget, undefined);
    assert.deepEqual(state.explanations, []);
    assert.deepEqual(state.humanSelection, humanSelection);
  });

  test('breaks away from a followed explanation while preserving the human selection', () => {
    const interaction = new InteractionController(deterministicReplayFixture.events);

    interaction.start(humanSelection);
    interaction.advance();
    interaction.advance();
    interaction.acceptFollow();
    const state = interaction.breakAway();

    assert.equal(state.follow, 'not-following');
    assert.equal(state.followTarget, undefined);
    assert.equal(state.aiAttention, undefined);
    assert.deepEqual(state.explanations, []);
    assert.deepEqual(state.humanSelection, humanSelection);
  });

  test('resets all interaction cues and starts the deterministic replay over', () => {
    const interaction = new InteractionController(deterministicReplayFixture.events);

    interaction.start(humanSelection);
    interaction.advance();
    interaction.advance();
    interaction.acceptFollow();
    const reset = interaction.reset();

    assert.equal(reset.humanSelection, undefined);
    assert.equal(reset.aiAttention, undefined);
    assert.equal(reset.follow, 'not-following');
    assert.equal(reset.followTarget, undefined);
    assert.deepEqual(reset.explanations, []);

    assert.deepEqual(interaction.start(humanSelection).aiAttention?.target, humanSelection);
  });

  test('stages the known proposal against the live document version without changing the live document', () => {
    const interaction = new InteractionController(deterministicReplayFixture.events);

    const state = stageKnownProposal(interaction, {
      target: {
        document: 'pricing.ts',
        range: { start: { line: 1, character: 47 }, end: { line: 1, character: 48 } }
      },
      baseDocumentVersion: 23,
      baseContents: 'export function subtotal() { return total - price; }',
      replacement: '+',
      stagedContents: 'export function subtotal() { return total + price; }'
    });

    assert.deepEqual(state.proposal, {
      target: {
        document: 'pricing.ts',
        range: { start: { line: 1, character: 47 }, end: { line: 1, character: 48 } }
      },
      baseDocumentVersion: 23,
      baseContents: 'export function subtotal() { return total - price; }',
      replacement: '+',
      stagedContents: 'export function subtotal() { return total + price; }',
      review: 'ready'
    });
    assert.equal(state.proposalCaptureTarget, undefined);
  });

  test('rejects a staged proposal without making a mutation request and replays cleanly', () => {
    const interaction = new InteractionController(deterministicReplayFixture.events);

    stageKnownProposal(interaction, {
      target: deterministicReplayFixture.events[3]!.target,
      baseDocumentVersion: 23,
      baseContents: 'staged base',
      replacement: '+',
      stagedContents: 'staged only'
    });
    const rejected = interaction.rejectProposal();

    assert.equal(rejected.proposal, undefined);
    assert.equal(rejected.mutationRequest, undefined);

    const reset = interaction.reset();
    assert.equal(reset.proposal, undefined);
    interaction.start(humanSelection);
    interaction.advance();
    interaction.advance();
    interaction.acceptFollow();
    const replayed = interaction.advance();
    assert.deepEqual(replayed.proposalCaptureTarget, deterministicReplayFixture.events[3]!.target);
  });

  test('routes acceptance to the extension authority gate without applying a workspace mutation', () => {
    const interaction = new InteractionController(deterministicReplayFixture.events);

    stageKnownProposal(interaction, {
      target: deterministicReplayFixture.events[3]!.target,
      baseDocumentVersion: 23,
      baseContents: 'staged base',
      replacement: '+',
      stagedContents: 'staged only'
    });
    const accepted = interaction.requestProposalAcceptance();

    assert.deepEqual(accepted.proposal, {
      target: deterministicReplayFixture.events[3]!.target,
      baseDocumentVersion: 23,
      baseContents: 'staged base',
      replacement: '+',
      stagedContents: 'staged only',
      review: 'accept-requested'
    });
    assert.deepEqual(accepted.mutationRequest, {
      target: deterministicReplayFixture.events[3]!.target,
      baseDocumentVersion: 23,
      baseContents: 'staged base',
      replacement: '+',
      stagedContents: 'staged only',
      requestId: 1
    });
  });

  test('marks a refused acceptance stale and prevents the staged request from being replayed', () => {
    const interaction = new InteractionController(deterministicReplayFixture.events);

    stageKnownProposal(interaction, {
      target: deterministicReplayFixture.events[3]!.target,
      baseDocumentVersion: 23,
      baseContents: 'staged base',
      replacement: '+',
      stagedContents: 'staged only'
    });
    const requested = interaction.requestProposalAcceptance();
    assert.ok(requested.mutationRequest);
    const acceptanceResult: ProposalAcceptanceResult = { outcome: 'stale' };
    const stale = interaction.completeProposalAcceptance(requested.mutationRequest, acceptanceResult);

    assert.equal(stale.proposal?.review, 'stale');
    assert.equal(stale.mutationRequest, undefined);
    assert.equal(stale.proposalAcceptance.message, 'The proposal is stale. Replay or restage it before accepting.');
  });

  test('clears an applied proposal after the authority completes it', () => {
    const interaction = new InteractionController(deterministicReplayFixture.events);

    stageKnownProposal(interaction, {
      target: deterministicReplayFixture.events[3]!.target,
      baseDocumentVersion: 23,
      baseContents: 'staged base',
      replacement: '+',
      stagedContents: 'staged only'
    });
    const requested = interaction.requestProposalAcceptance();
    assert.ok(requested.mutationRequest);
    const completed = interaction.completeProposalAcceptance(requested.mutationRequest, { outcome: 'applied' });

    assert.equal(completed.proposal, undefined);
    assert.equal(completed.mutationRequest, undefined);
    assert.equal(completed.proposalAcceptance.closeReview, true);
  });

  test('makes cancellation terminal no-mutation and ignores an old completion after a new request', () => {
    const interaction = new InteractionController(deterministicReplayFixture.events);
    const capture = {
      target: deterministicReplayFixture.events[3]!.target,
      baseDocumentVersion: 23,
      baseContents: 'staged base',
      replacement: '+',
      stagedContents: 'staged only'
    };

    stageKnownProposal(interaction, capture);
    const oldRequest = interaction.requestProposalAcceptance().mutationRequest;
    assert.ok(oldRequest);
    const cancelled = interaction.completeProposalAcceptance(oldRequest, { outcome: 'cancelled' });
    assert.equal(cancelled.proposal, undefined);
    assert.equal(cancelled.mutationRequest, undefined);

    stageKnownProposal(interaction, capture);
    const newRequest = interaction.requestProposalAcceptance().mutationRequest;
    assert.ok(newRequest);
    const untouched = interaction.completeProposalAcceptance(oldRequest, { outcome: 'applied' });
    assert.equal(untouched.mutationRequest?.requestId, newRequest.requestId);
    assert.equal(untouched.proposal?.review, 'accept-requested');
  });

  test('makes gateway failure terminal and supplies acceptance-specific guidance', () => {
    const interaction = new InteractionController(deterministicReplayFixture.events);
    stageKnownProposal(interaction, {
      target: deterministicReplayFixture.events[3]!.target,
      baseDocumentVersion: 23,
      baseContents: 'staged base',
      replacement: '+',
      stagedContents: 'staged only'
    });
    const acceptanceRequest = interaction.requestProposalAcceptance().mutationRequest;
    assert.ok(acceptanceRequest);

    const failed = interaction.completeProposalAcceptance(acceptanceRequest, { outcome: 'failed' });

    assert.equal(failed.proposal, undefined);
    assert.equal(failed.mutationRequest, undefined);
    assert.equal(failed.proposalAcceptance.message, 'CodeAlongAI could not accept the proposal. Restage it and try again.');
  });

  test('makes rejection and reset terminal no-mutation paths for an acceptance request', () => {
    const interaction = new InteractionController(deterministicReplayFixture.events);
    const capture = {
      target: deterministicReplayFixture.events[3]!.target,
      baseDocumentVersion: 23,
      baseContents: 'staged base',
      replacement: '+',
      stagedContents: 'staged only'
    };

    stageKnownProposal(interaction, capture);
    interaction.requestProposalAcceptance();
    const rejected = interaction.rejectProposal();
    assert.equal(rejected.proposal, undefined);
    assert.equal(rejected.mutationRequest, undefined);

    stageKnownProposal(interaction, capture);
    interaction.requestProposalAcceptance();
    const reset = interaction.reset();
    assert.equal(reset.proposal, undefined);
    assert.equal(reset.mutationRequest, undefined);
  });
});
