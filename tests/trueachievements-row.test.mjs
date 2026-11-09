import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const row = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'AchievementRow');
const code = ts.transpileModule(row.getText(ast), { compilerOptions: { jsx: ts.JsxEmit.React } }).outputText;
function fixture(secret = false, reveal = false, missable = true, unlocked = false, favorite = false) {
  const opened = [];
  const filters = [];
  let toggles = 0;
  let favorites = 0;
  const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: 'fragment' };
  const context = { React, pluginLocales: { en: "en-US" }, useRef: () => ({ current: null }), usePluginTranslation: () => ({ locale: 'en', t: text => text }),
    GamepadButton: { BUMPER_RIGHT: 6 }, FaStar: 'star', FaRegStar: 'star-outline', FaThumbtack: 'pin', TAIcon: 'ta-icon', FaEye: 'eye', FaEyeSlash: 'eye-slash', Icon: 'icon', RareIcon: 'rare', GamerscoreIcon: 'score', Focusable: 'focusable', DialogButton: 'button',
    taFlags: [{id: 'missable', label: 'Missable'}, {id: 'single-player', label: 'Single Player'}], Navigation: { NavigateToExternalWeb: url => opened.push(url) } };
  vm.createContext(context);
  vm.runInContext(code + '\nthis.renderRow = AchievementRow;', context);
  const tree = context.renderRow({ a: { id: '1', name: 'First Steps', description: 'Play', secret, unlocked, progress: null },
    ta: { flags: missable ? ['missable', 'single-player'] : ['single-player'], url: 'https://www.trueachievements.com/a123/first-steps-achievement' }, reveal, favorite, onToggle() { toggles++; }, onFlag: flag => filters.push(flag), onFavorite() { favorites++; } });
  const nodes = [];
  function walk(value) {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') { nodes.push(value); walk(value.props?.children); }
  }
  walk(tree);
  return { nodes, opened, filters, toggles: () => toggles, favorites: () => favorites };
}
test('TA missable badge and guide button appear on matching rows', () => {
  const { nodes, opened } = fixture();
  assert.equal(nodes.filter(node => node.props?.className === 'nexus-row-action nexus-ta-action nexus-ta-flag nexus-ta-missable').length, 1);
  assert.equal(nodes.filter(node => node.props?.className === 'nexus-row-action nexus-ta-action nexus-ta-flag nexus-ta-single-player').length, 1);
  const button = nodes.find(node => node.props?.['aria-label'] === 'View on TrueAchievements');
  button.props.onClick();
  assert.deepEqual(opened, ['https://www.trueachievements.com/a123/first-steps-achievement']);
  assert.equal(fixture(false, false, false).nodes.some(node => node.props?.className === 'nexus-row-action nexus-ta-action nexus-ta-flag nexus-ta-missable'), false);
});
test('secret flags and guide links stay hidden until revealed', () => {
  const hidden = fixture(true).nodes;
  assert.equal(hidden.some(node => node.props?.className === 'nexus-row-action nexus-ta-action nexus-ta-flag nexus-ta-missable'), false);
  assert.equal(hidden.some(node => node.props?.['aria-label'] === 'View on TrueAchievements'), false);
  const revealed = fixture(true, true).nodes;
  assert.equal(revealed.some(node => node.props?.className === 'nexus-row-action nexus-ta-action nexus-ta-flag nexus-ta-missable'), true);
  assert.equal(revealed.some(node => node.props?.['aria-label'] === 'View on TrueAchievements'), true);
});

test('TA badges apply their flag filter and the guide uses an icon', () => {
  const { nodes, filters } = fixture();
  nodes.find(node => node.props?.className === 'nexus-row-action nexus-ta-action nexus-ta-flag nexus-ta-missable').props.onClick();
  assert.deepEqual(filters, ['missable']);
  const guide = nodes.find(node => node.props?.className === 'nexus-row-action nexus-ta-action nexus-ta-guide');
  assert.equal(guide.props.children[0].type, 'ta-icon');
});

function event(button, repeat = false) {
  return { detail: { button, is_repeat: repeat }, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
}
test('badge and action-button navigation follow their horizontal rows', () => {
  const { nodes } = fixture(true, true);
  assert.equal(nodes.find(n => n.props?.className === 'nexus-ta-flags').props['flow-children'], 'row');
  assert.equal(nodes.find(n => n.props?.className === 'nexus-achievement-actions').props['flow-children'], 'row');
  for (const button of nodes.filter(n => n.type === 'button')) assert.match(button.props.className, /nexus-row-action/);
});
test('X toggles secrets and RB opens the row guide once per press', () => {
  const state = fixture(true, true);
  const row = state.nodes[0];
  const x = event(3);
  row.props.onSecondaryButton(x);
  assert.equal(state.toggles(), 1);
  assert.equal(x.stopped, true);
  row.props.onSecondaryButton(event(3, true));
  assert.equal(state.toggles(), 1);
  const rb = event(6);
  row.props.onButtonDown(rb);
  assert.equal(state.opened.length, 1);
  assert.equal(rb.prevented, true);
  row.props.onButtonDown(event(6, true));
  assert.equal(state.opened.length, 1);
  const other = event(5);
  row.props.onButtonDown(other);
  assert.equal(other.stopped, false);
  const regular = fixture();
  regular.nodes[0].props.onSecondaryButton(event(3));
  assert.equal(regular.toggles(), 0);
});

test('rows with buttons are navigation containers instead of self-focus targets', () => {
  for (const state of [fixture(), fixture(true), fixture(true, true)]) {
    const row = state.nodes[0];
    assert.equal(row.props.tabIndex, undefined);
    assert.equal(row.props.onActivate, undefined);
    assert.equal(row.props['flow-children'], 'row');
  }
});

test('Y favorites an achievement once per press without affecting tracking', () => {
  const state = fixture();
  const y = event(4);
  state.nodes[0].props.onOptionsButton(y);
  assert.equal(state.favorites(), 1);
  assert.equal(y.stopped, true);
  state.nodes[0].props.onOptionsButton(event(4, true));
  assert.equal(state.favorites(), 1);
  state.nodes.find(node => node.props?.className?.includes('nexus-favorite-button')).props.onClick();
  assert.equal(state.favorites(), 2);
});

test('unlocked rows disable new favorites and expose no tracking action or Y shortcut', () => {
  const state = fixture(false, false, true, true);
  const star = state.nodes.find(node => node.props?.className?.includes('nexus-favorite-button'));
  assert.equal(star, undefined);
  assert.equal(state.nodes.some(node => node.props?.className?.includes('nexus-track-button')), false);
  assert.equal(state.nodes[0].props.onOptionsActionDescription, undefined);
  state.nodes[0].props.onOptionsButton(event(4));
  assert.equal(state.favorites(), 0);
});

test('even previously favorited unlocked rows disable mouse and Y favorite changes', () => {
  const state = fixture(false, false, true, true, true);
  const button = state.nodes.find(node => node.props?.className?.includes('nexus-favorite-button'));
  assert.equal(button, undefined);
  state.nodes[0].props.onOptionsButton(event(4));
  assert.equal(state.favorites(), 0);
});
