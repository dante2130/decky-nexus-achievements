import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function fixture() {
  const Focusable = () => null;
  const patched = [];
  const header = { type: function header(props) { const quickAccessHeader = props.quickAccessHeader; return 'BShowHeader' + quickAccessHeader; } };
  const frameHeader = { type: function frameHeader() { return '.Provider region:3'; } };
  const api = { callable: () => async () => ({ ok: true, gamerscore: 12345 }),
    routerHook: { addGlobalComponent() {}, removeGlobalComponent() {} } };
  const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: value => [value, () => {}], useSyncExternalStore: (_, snapshot) => snapshot() };
  const ui = { Focusable, findClassModule: () => ({ HeaderItem: 'header', Clickable: 'clickable' }),
    findModule: () => ({ header, frameHeader }), afterPatch: object => { patched.push(object); return { unpatch() {} }; } };
  const locales = { getPluginLanguage: () => 'en', pluginLocales: { en: 'en-US' }, translate: (_, text) => text };
  const output = {};
  const code = ts.transpileModule(readFileSync(new URL('../src/profile-gamerscore.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'React.createElement' } }).outputText;
  vm.runInNewContext(code + '\nexports.ProfileScoreForTest = ProfileScore;', {
    exports: output, React, console, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    require: name => name === '@decky/api' ? api : name === '@decky/ui' ? ui : name === 'react' ? React : locales,
  });
  return { output, Focusable, patched, header, frameHeader };
}

test('cross-window status fallback never registers a Steam navigation node', async () => {
  const { output, Focusable } = fixture();
  output.setProfileGamerscoreEnabled(true);
  await new Promise(resolve => setImmediate(resolve));
  const fallback = output.ProfileScoreForTest({ icon: 'G', onOpen() {}, nativeNavigation: false });
  assert.equal(fallback.type, 'button');
  assert.equal(fallback.props.tabIndex, -1);
  assert.equal(fallback.props.onGamepadFocus, undefined);
  let prevented = false;
  fallback.props.onMouseDown({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  const native = output.ProfileScoreForTest({ icon: 'G', onOpen() {} });
  assert.equal(native.type, Focusable);
  output.setProfileGamerscoreEnabled(false);
});
test('only the normal Gamepad header is patched, not Frame or VR headers', () => {
  const { output, patched, header, frameHeader } = fixture();
  const cleanup = output.installProfileGamerscore('G', () => {});
  assert.deepEqual(patched, [header]);
  assert.equal(patched.includes(frameHeader), false);
  cleanup();
});
