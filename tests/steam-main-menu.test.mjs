import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const { outputText } = ts.transpileModule(readFileSync(new URL('../src/steam-main-menu.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const element = (type, { key = null, ...props } = {}) => ({ type, key, props });
const nativeRow = () => {};
const onGamepadFocus = () => {};
const library = element(nativeRow, { key: 'library', route: '/library', label: 'Library', icon: 'library', onGamepadFocus });
const home = element(nativeRow, { key: 'home', route: '/home', label: 'Home', icon: 'home', onGamepadFocus });
const power = element(nativeRow, { key: 'power' });

function setup(registry) {
  const idleRows = [home, library, power];
  const renderList = () => ({ props: { children: [idleRows] } });
  const original = () => ({ props: { children: { props: { children: [element(renderList)] } } } });
  const parent = { type: original, alternate: { type: original } };
  const root = { child: { memoizedProps: { navID: 'MainNavMenuContainer' }, return: parent } };
  const window = { __necroSteamMenuV1: registry };
  function findInReactTree(node, predicate) {
    if (!node || typeof node !== 'object') return;
    if (predicate(node)) return node;
    return (Array.isArray(node) ? node : [node.props, node.children, node.child])
      .map(child => findInReactTree(child, predicate)).find(Boolean);
  }
  const exports = {};
  vm.runInNewContext(outputText, {
    exports, window, document: { getElementById: () => root },
    localStorage: { getItem: () => null }, setInterval: () => 1, clearInterval() {},
    require: name => ({
      '@decky/ui': { getReactRoot: node => node, findInReactTree },
      react: { createElement: element },
      './i18n': { getPluginLanguage: () => 'en', translate: (_, label) => label },
    })[name],
  });
  const render = () => parent.type().props.children.props.children[0].type().props.children[0];
  return { exports, parent, original, render, window };
}

test('the mounted idle STEAM menu adds one native achievements route', () => {
  const { exports, parent, original, render } = setup();
  assert.deepEqual(render().map(row => row.key), ['home', 'library', 'power']);
  const remove = exports.installSteamMainMenuEntry('/nexus-achievements', 'trophy');
  for (let renderCount = 0; renderCount < 2; renderCount++) {
    const rows = render();
    assert.deepEqual(rows.map(row => row.key), ['home', 'library', 'necro-menu:nexus-achievements', 'power']);
    const entry = rows[2];
    assert.equal(entry.type, nativeRow);
    assert.equal(entry.props.route, '/nexus-achievements');
    assert.equal(entry.props.label, 'Nexus Achievements');
    assert.equal(entry.props.onGamepadFocus, onGamepadFocus);
    assert.equal(entry.props.icon, 'trophy');
  }
  const cachedRows = render();
  remove();
  assert.equal(parent.type, original);
  assert.equal(parent.alternate.type, original);
  assert.deepEqual(cachedRows.map(row => row.key), ['home', 'library', 'power']);
});

test('Nexus shares an existing Steamcord-owned menu without replacing its patch', () => {
  const steamcord = { id: 'steamcord', route: '/discord', label: 'Steamcord', order: 10 };
  const registry = {
    revision: 3, entries: new Map([[steamcord.id, steamcord]]),
    dispose: () => assert.fail('Steamcord still owns the patch'),
  };
  const { exports, parent, original } = setup(registry);
  const remove = exports.installSteamMainMenuEntry('/nexus-achievements', 'trophy');
  assert.equal(parent.type, original);
  assert.equal(registry.entries.get('nexus-achievements').route, '/nexus-achievements');
  remove();
  assert.deepEqual([...registry.entries.values()], [steamcord]);
});
