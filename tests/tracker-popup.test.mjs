import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const code = ts.transpileModule(readFileSync(new URL('../src/tracker-popup.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
function fixture(fail = false) {
  const calls = [];
  let poll;
  let timeout;
  let popup;
  const host = { style: {}, ownerDocument: { documentElement: { style: {} }, body: { style: {} } } };
  const view = { closed: false, document: { write() {}, close() {}, documentElement: { style: {} }, getElementById: () => host } };
  const browserView = {
    SetBounds: (...args) => calls.push(['bounds', ...args]),
    SetVisible: value => calls.push([value ? 'show' : 'hide']),
    SetWindowStackingOrder: order => calls.push(['stack', order]),
  };
  const owner = { innerWidth: 854, innerHeight: 534, SteamClient: { Browser: { GetBrowserID: () => 2 } } };
  const client = { BrowserView: {
    CreatePopup: options => { calls.push(['create', options]); return { strCreateURL: 'about:blank?browserviewpopup=1', browserView }; },
    Destroy: () => { view.closed = true; calls.push(['close']); },
  } };
  popup = view;
  const menu = { visible: false };
  const composition = { m_eLatestCompositionState: 0,
    AddMinimumCompositionStateRequest: (...args) => { calls.push(['request', ...args]); if (fail) throw new Error('unavailable'); },
    RemoveMinimumCompositionStateRequest: (...args) => calls.push(['release', ...args]),
  };
  const output = {};
  const hosts = [];
  let errors = 0;
  vm.runInNewContext(code, { exports: output, window: { SteamClient: client,
    open: (url) => { calls.push(['open', url]); return view; },
    SteamUIStore: { WindowStore: { GamepadUIMainWindowInstance: { BrowserWindow: owner, MenuStore: { IsAnySideMenuVisible: () => menu.visible }, m_CompositionStateStore: composition } } } },
    setInterval: fn => { poll = fn; return 1; }, setTimeout: fn => { timeout = fn; return 2; },
    clearInterval: () => calls.push(['clearInterval']), clearTimeout: () => calls.push(['clearTimeout']) });
  const handle = output.createTrackerPopup(host => hosts.push(host), () => errors++);
  return { calls, hosts, handle, popup, host, menu, composition, errors: () => errors, poll: () => poll(), timeout: () => timeout() };
}
test('tracker is a non-focusable notification overlay with controlled placement', () => {
  const state = fixture();
  state.handle.update('lower-left', 3);
  state.poll();
  assert.match(state.calls.find(call => call[0] === 'open')[1], /createflags=512/);
  assert.deepEqual(state.calls.find(call => call[0] === 'stack'), ['stack', 1]);
  assert.deepEqual(state.calls.find(call => call[0] === 'request'), ['request', 1, 'NexusAchievementTracker']);
  assert.deepEqual(state.calls.find(call => call[0] === 'bounds'), ['bounds', 12, 386, 200, 136]);
  assert.equal(state.hosts[0], state.host);
  state.handle.close();
  state.handle.close();
  assert.equal(state.calls.filter(call => call[0] === 'close').length, 1);
  assert.equal(state.calls.filter(call => call[0] === 'request').length, state.calls.filter(call => call[0] === 'release').length);
  assert.equal(state.hosts.at(-1), null);
});
test('overlay failures close the popup and preserve a visible retry state', () => {
  const state = fixture(true);
  state.poll();
  assert.equal(state.errors(), 1);
  assert.equal(state.calls.filter(call => call[0] === 'request').length, state.calls.filter(call => call[0] === 'release').length);
  assert.equal(state.popup.closed, true);
  assert.equal(state.hosts.at(-1), null);
});
test('a late window cannot mount after the overlay is closed', () => {
  const state = fixture();
  state.handle.close();
  state.poll();
  assert.deepEqual(state.hosts, [null]);
});

test('tracker hides while Steam menus or the main UI are open and returns to the game', () => {
  const state = fixture();
  state.poll();
  state.menu.visible = true;
  state.poll();
  assert.equal(state.calls.filter(call => call[0] === 'hide').length, 2);
  assert.equal(state.calls.filter(call => call[0] === 'release').at(-1)[1], 1);
  state.menu.visible = false;
  state.composition.m_eLatestCompositionState = 3;
  state.poll();
  assert.equal(state.calls.filter(call => call[0] === 'show').length, 1);
  state.composition.m_eLatestCompositionState = 0;
  state.poll();
  assert.equal(state.calls.filter(call => call[0] === 'show').length, 2);
  assert.equal(state.calls.filter(call => call[0] === 'bounds').at(-1)[1], 642);
  state.handle.close();
});

test('notification requests are balanced across repeated game and menu transitions', () => {
  const state = fixture();
  for (let i = 0; i < 3; i++) {
    state.menu.visible = false; state.poll();
    state.menu.visible = true; state.poll();
  }
  state.handle.close();
  assert.equal(state.calls.filter(call => call[0] === 'request').length, 3);
  assert.equal(state.calls.filter(call => call[0] === 'release').length, 3);
});

 test('all eight positions stay within the scaled viewport', () => {
  const state = fixture(); state.poll();
  for (const [position, x, y] of [
    ['upper-left', 12, 12], ['center-top', 327, 12], ['upper-right', 642, 12],
    ['center-left', 12, 239], ['center-right', 642, 239],
    ['lower-left', 12, 466], ['center-bottom', 327, 466], ['lower-right', 642, 466],
  ]) {
    state.handle.update(position, 1);
    assert.deepEqual(state.calls.filter(call => call[0] === 'bounds').at(-1), ['bounds', x, y, 200, 56]);
  }
  state.handle.close();
});
