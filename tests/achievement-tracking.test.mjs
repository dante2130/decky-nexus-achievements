import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../src/achievement-tracking.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
function fixture() {
  const values = new Map();
  const calls = [];
  let fail = false;
  let optionsFail = false;
  const options = { enabled: false, position: 'upper-right', count: 5, opacity: 75 };
  const get = id => values.get(id) ?? { favorites: [], tracked: [] };
  const api = { callable: name => async (...args) => {
    calls.push([name, ...args]);
    if (name === 'get_achievement_preferences') return structuredClone(get(args[0]));
    if (name === 'set_achievement_favorite' || name === 'set_achievement_tracked') {
      if (fail) { fail = false; throw new Error('save failed'); }
      const [title, id, enabled] = args;
      const key = name === 'set_achievement_favorite' ? 'favorites' : 'tracked';
      const next = structuredClone(get(title));
      next[key] = next[key].filter(value => value !== id);
      if (enabled) next[key].push(id);
      values.set(title, next);
      return structuredClone(next);
    }
    if (name === 'get_tracker_state') return { options, running: null, achievements: [] };
    if (name === 'set_tracker_options') {
      if (optionsFail) { optionsFail = false; throw new Error('save failed'); }
      Object.assign(options, { enabled: args[0], position: args[1], opacity: args[2], count: args[3] });
      return { ...options };
    }
    return options;
  } };
  const output = {};
  vm.runInNewContext(code, { exports: output, require: name => name === '@decky/api' ? api : {
    useEffect() {}, useSyncExternalStore: (_, snapshot) => snapshot(),
  }, setInterval: () => 1, clearInterval() {}, console });
  return { output, calls, failNextOptions: () => { optionsFail = true; }, failNext: () => { fail = true; } };
}
test('favorite mutations serialize quick presses without losing toggles', async () => {
  const { output, calls } = fixture();
  await Promise.all([output.toggleAchievementFavorite('42', '1'), output.toggleAchievementFavorite('42', '1')]);
  assert.deepEqual(calls.filter(call => call[0] === 'set_achievement_favorite').map(call => call[3]), [true, false]);
  assert.equal(output.useAchievementPreferences('42').favorites.length, 0);
});
test('favorites and tracking are independent and tracking is limited to five', async () => {
  const { output, calls } = fixture();
  await output.toggleAchievementFavorite('42', '7');
  for (let i = 1; i <= 5; i++) await output.toggleAchievementTracked('42', String(i));
  await assert.rejects(output.toggleAchievementTracked('42', '6'), /five/);
  const preferences = output.useAchievementPreferences('42');
  assert.deepEqual(Array.from(preferences.favorites), ['7']);
  assert.deepEqual(Array.from(preferences.tracked), ['1', '2', '3', '4', '5']);
  assert.equal(calls.filter(call => call[0] === 'set_achievement_tracked').length, 5);
  await output.toggleAchievementTracked('42', '2');
  await output.toggleAchievementTracked('42', '6');
  assert.equal(output.useAchievementPreferences('42').tracked.includes('6'), true);
});
test('a failed mutation preserves previous state and does not poison the queue', async () => {
  const { output, failNext } = fixture();
  await output.toggleAchievementFavorite('42', '1');
  failNext();
  await assert.rejects(output.toggleAchievementFavorite('42', '1'), /save failed/);
  assert.equal(output.useAchievementPreferences('42').favorites.includes('1'), true);
  await output.toggleAchievementFavorite('42', '1');
  assert.equal(output.useAchievementPreferences('42').favorites.length, 0);
});
test('favorites form their own sorted group without duplicates or stale IDs', () => {
  const { output } = fixture();
  const items = [{ id: '2' }, { id: '1' }, { id: '3' }];
  const groups = output.splitFavoriteAchievements(items, ['1', '2', 'missing']);
  assert.deepEqual(Array.from(groups.favorites, item => item.id), ['2', '1']);
  assert.deepEqual(Array.from(groups.others, item => item.id), ['3']);
  assert.equal(items.length, 3);
});

test('hide is immediate and remains hidden if saving fails or a poll returns enabled', async () => {
  const { output, failNextOptions } = fixture();
  await output.updateTrackerOptions({ enabled: true });
  assert.equal(output.useTrackerState().options.enabled, true);
  failNextOptions();
  const save = output.updateTrackerOptions({ enabled: false });
  assert.equal(output.useTrackerState().options.enabled, false);
  await assert.rejects(save, /save failed/);
  await output.refreshTrackerState();
  assert.equal(output.useTrackerState().options.enabled, false);
  await output.updateTrackerOptions({ enabled: true });
  assert.equal(output.useTrackerState().options.enabled, true);
});
