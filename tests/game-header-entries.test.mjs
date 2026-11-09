import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendGameHeaderEntries } from '../src/game-header-entries.ts';

test('Nexus retains Steam and other plugin anchors in their original array and order', () => {
  const steam = { key: 'steam-header' }, proton = { key: null, type: 'ProtonMedal' }, playcount = { key: 'player-count' };
  const children = [steam, proton, playcount, false, null, { key: 'native-tabs' }];
  const reference = children;
  const before = [...children];
  const score = { key: 'nexus-game-view-score' }, button = { key: 'nexus-game-achievements' };
  appendGameHeaderEntries(children, [score, button]);
  assert.equal(children, reference);
  assert.deepEqual(children.slice(0, before.length), before);
  assert.deepEqual(children.slice(-2), [score, button]);
  appendGameHeaderEntries(children, [score, button]);
  assert.equal(children.length, before.length + 2);
});
test('other plugins can insert before or after Nexus without losing their entries', () => {
  const children = [{ key: 'steam-header' }, { key: 'native-tabs' }];
  appendGameHeaderEntries(children, [{ key: 'nexus-game-view-score' }]);
  const badge = { key: 'player-count' };
  children.splice(1, 0, badge);
  appendGameHeaderEntries(children, [{ key: 'nexus-game-view-score' }, { key: 'nexus-game-achievements' }]);
  assert.equal(children[1], badge);
  assert.equal(children.filter(child => child.key === 'nexus-game-view-score').length, 1);
});
