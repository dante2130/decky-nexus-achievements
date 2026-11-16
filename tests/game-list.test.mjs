import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uniqueGames } from '../src/game-list.ts';

const nexus = { titleId: '42', titleName: 'Game', updatedAt: 100 };
const unifideck = { ...nexus, titleId: 'unifideck.42', updatedAt: 200 };
const other = { ...nexus, titleId: '43' };

test('All Games groups the same Xbox title and keeps different IDs with the same name', () => {
  assert.deepEqual(uniqueGames([nexus, other, unifideck, unifideck]), [unifideck, other]);
  const installed = { ...nexus, installed: true };
  assert.deepEqual(uniqueGames([unifideck, installed]), [installed]);
});

test('the running row suppresses both copies of its title', () => {
  for (const id of [nexus.titleId, unifideck.titleId]) {
    assert.deepEqual(uniqueGames([nexus, unifideck, other], id), [other]);
  }
});
