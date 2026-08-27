import assert from 'node:assert/strict';
import {
  deterministicReplayFixture,
  type DocumentRange
} from '../replay';
import { InteractionController } from '../interaction';

const humanSelection: DocumentRange = {
  document: 'checkout.ts',
  range: {
    start: { line: 4, character: 31 },
    end: { line: 4, character: 39 }
  }
};

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
});
