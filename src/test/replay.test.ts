import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deterministicReplayFixture, ReplayController } from '../replay';

const fixtureDirectory = resolve(__dirname, '../../demo-workspace');

suite('deterministic replay', () => {
  test('starts and advances through the fixed walkthrough in order', () => {
    const replay = new ReplayController(deterministicReplayFixture.events);

    const events = [
      replay.start(),
      replay.advance(),
      replay.advance(),
      replay.advance(),
      replay.advance()
    ];

    assert.deepEqual(
      events.map((event) => event?.kind),
      ['point', 'walkthrough', 'explain', 'propose', 'ask']
    );
    assert.deepEqual(events[0]?.target, {
      document: 'checkout.ts',
      range: {
        start: { line: 4, character: 31 },
        end: { line: 4, character: 39 }
      }
    });
    assert.deepEqual(events[3]?.target, {
      document: 'pricing.ts',
      range: {
        start: { line: 1, character: 47 },
        end: { line: 1, character: 48 }
      }
    });
    assert.equal(events[3]?.kind, 'propose');
    if (events[3]?.kind === 'propose') {
      assert.equal(events[3].baseDocumentVersion, 1);
      assert.equal(events[3].replacement, '+');
    }
    assert.equal(replay.advance(), undefined);
  });

  test('cancels, resets, and replays the known scenario unchanged', () => {
    const replay = new ReplayController(deterministicReplayFixture.events);

    const firstEvent = replay.start();
    replay.cancel();
    assert.equal(replay.advance(), undefined);

    replay.reset();
    const replayedEvents = [
      replay.start(),
      replay.advance(),
      replay.advance(),
      replay.advance(),
      replay.advance()
    ];

    assert.deepEqual(firstEvent, replayedEvents[0]);
    assert.deepEqual(replayedEvents, deterministicReplayFixture.events);
  });

  test('keeps every event target and the known patch within the demo fixture', () => {
    const targetedText = deterministicReplayFixture.events.map((event) => {
      const lines = readFileSync(
        resolve(fixtureDirectory, event.target.document),
        'utf8'
      ).split('\n');
      const line = lines[event.target.range.start.line];
      assert.notEqual(line, undefined, `missing target line for ${event.kind}`);

      return line!.slice(event.target.range.start.character, event.target.range.end.character);
    });

    assert.deepEqual(targetedText, ['subtotal', 'subtotal', '-', '-', '-']);

    const proposal = deterministicReplayFixture.events[3];
    assert.equal(proposal?.kind, 'propose');
    if (proposal?.kind === 'propose') {
      const line = readFileSync(
        resolve(fixtureDirectory, proposal.target.document),
        'utf8'
      ).split('\n')[proposal.target.range.start.line]!;
      const patchedLine =
        line.slice(0, proposal.target.range.start.character) +
        proposal.replacement +
        line.slice(proposal.target.range.end.character);

      assert.equal(
        patchedLine,
        '  return prices.reduce((total, price) => total + price, 0);'
      );
    }
  });
});
