import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const { outputText } = ts.transpileModule(readFileSync(new URL('../src/steam-main-menu.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const element = (type, { key = null, ...props } = {}, children) => ({ type, key, props: { ...props, children: children ?? props.children } });
const nativeRow = () => {};
const onGamepadFocus = () => {};
const library = element(nativeRow, { key: 'library', route: '/library', label: 'Library', icon: 'library', onGamepadFocus });
const home = element(nativeRow, { key: 'home', route: '/home', label: 'Home', icon: 'home', onGamepadFocus });
const power = element(nativeRow, { key: 'power' });

function setup(sibling) {
  const idleRows = [home, library, ...(sibling ? [sibling] : []), power];
  const storage = new Map([["STEAMCORD_MENU_POSITION", "8"]]);
  let positionMenu;
  const renderList = () => ({ props: { children: [idleRows] } });
  const original = () => ({ props: { children: { props: { children: [element(renderList)] } } } });
  const parent = { type: original, alternate: { type: original } };
  const root = { child: { memoizedProps: { navID: 'MainNavMenuContainer' }, return: parent } };
  const window = {};
  function findInReactTree(node, predicate) {
    if (!node || typeof node !== 'object') return;
    if (predicate(node)) return node;
    return (Array.isArray(node) ? node : [node.props, node.children, node.child])
      .map(child => findInReactTree(child, predicate)).find(Boolean);
  }
  const exports = {};
  vm.runInNewContext(outputText, {
    exports, window, document: { getElementById: () => root },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, setInterval: () => 1, clearInterval() {},
    require: name => ({
      '@decky/ui': { getReactRoot: node => node, findInReactTree,
        Menu: 'menu', MenuItem: 'menu-item', showContextMenu: menu => { positionMenu = menu; } },
      react: { createElement: element },
      './i18n': { getPluginLanguage: () => 'en', translate: (_, label) => label },
    })[name],
  });
  const render = () => parent.type().props.children.props.children[0].type().props.children[0];
  return { exports, parent, original, render, window, storage, positionMenu: () => positionMenu };
}

test('the mounted idle STEAM menu adds one native achievements route', () => {
  const { exports, parent, original, render } = setup();
  assert.deepEqual(render().map(row => row.key), ['home', 'library', 'power']);
  const remove = exports.installSteamMainMenuEntry('/nexus-achievements', 'trophy', () => true);
  for (let renderCount = 0; renderCount < 2; renderCount++) {
    const rows = render();
    assert.deepEqual(rows.map(row => row.key), ['home', 'library', 'nexus-achievements', 'power']);
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

test('X changes only the Nexus slot, and hiding or showing it preserves Steamcord', () => {
  const steamcord = element(nativeRow, { key: 'necro-menu:steamcord', route: '/discord' });
  const { exports, render, window, storage, positionMenu } = setup(steamcord);
  let visible = true;
  const remove = exports.installSteamMainMenuEntry('/nexus-achievements', 'trophy', () => visible);
  const entry = render().find(row => row.key === 'nexus-achievements');
  assert.equal(entry.props.onSecondaryActionDescription, 'Change menu position');
  entry.props.onSecondaryButton();
  assert.equal(positionMenu().props.children.length, 9);
  assert.equal(positionMenu().props.children[2].props.selected, true);
  positionMenu().props.children[0].props.onSelected();
  assert.equal(render()[0].key, 'nexus-achievements');
  assert.equal(storage.get('STEAMCORD_MENU_POSITION'), '8');
  assert.equal(window.__necroSteamMenuV1, undefined);
  visible = false;
  assert.equal(render().includes(steamcord), true);
  assert.equal(render().some(row => row.key === 'nexus-achievements'), false);
  visible = true;
  assert.equal(render()[0].key, 'nexus-achievements');
  assert.equal(render().includes(steamcord), true);
  remove();
});

test('Steamcord keeps its shortcut when it has cached the Nexus-wrapped list renderer', () => {
  const { exports, parent, render } = setup();
  let visible = true;
  const remove = exports.installSteamMainMenuEntry('/nexus-achievements', 'trophy', () => visible);
  const renderMenu = parent.type;
  let capturedList;
  const steamcord = element(nativeRow, { key: 'necro-menu:steamcord', route: '/discord' });
  const steamcordList = (...args) => {
    const result = capturedList(...args);
    const rows = result.props.children[0];
    if (!rows.includes(steamcord)) rows.push(steamcord);
    return result;
  };
  parent.type = () => {
    const result = renderMenu();
    const list = result.props.children.props.children[0];
    capturedList ??= list.type;
    if (list.type === capturedList) list.type = steamcordList;
    return result;
  };
  const initialRows = render();
  assert.equal(initialRows.includes(steamcord), true);
  initialRows.splice(initialRows.indexOf(steamcord), 1);
  visible = false;
  assert.equal(render().includes(steamcord), true);
  assert.equal(render().some(row => row.key === 'nexus-achievements'), false);
  visible = true;
  assert.equal(render().some(row => row.key === 'nexus-achievements'), true);
  const rows = render();
  rows.splice(rows.indexOf(steamcord), 1);
  remove();
  assert.equal(render().includes(steamcord), true);
  assert.equal(render().some(row => row.key === 'nexus-achievements'), false);
});
