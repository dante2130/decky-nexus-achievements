import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'TAAccount');
const code = ts.transpileModule(component.getText(ast), { compilerOptions: { jsx: ts.JsxEmit.React } }).outputText;
function fixture(result = { status: 'connected' }, gameTitleId) {
  const states = [];
  let cursor = 0;
  const calls = [];
  const context = { React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
    Field: 'field', ButtonItem: 'button', DialogButton: 'icon-button', FaSignInAlt: 'sign-in', FaLink: 'link', FaUnlink: 'unlink', FaSpinner: 'spinner', FaExternalLinkAlt: 'external', useRef: () => ({ current: 0 }), useEffect() {}, useTASessionRevision: () => 0,
    usePluginTranslation: () => ({ t: text => text }),
    useState(value) { const index = cursor++; if (!(index in states)) states[index] = value; return [states[index], value => { states[index] = value; }]; },
    connectTASession: async (...args) => { calls.push(['connect', args]); return result; },
    disconnectTASession: async () => { calls.push(['disconnect']); return { status: 'disconnected' }; },
    notifyTASessionChanged() { calls.push(['refresh']); },
    Navigation: { NavigateToExternalWeb: url => calls.push(['open', url]) } };
  vm.createContext(context);
  vm.runInContext(code + '\nthis.renderAccount = TAAccount;', context);
  function render() {
    cursor = 0;
    const nodes = [];
    function walk(value) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') { nodes.push(value); walk(value.props?.children); }
    }
    walk(context.renderAccount({ gameTitleId }));
    return nodes;
  }
  const button = label => render().find(node => (node.type === 'button' && node.props.children.includes(label)) || (node.type === 'icon-button' && node.props['aria-label'] === label));
  return { calls, render, button };
}
test('TA login opens official site and connects without frontend credentials', async () => {
  const state = fixture();
  state.button('Sign in to TrueAchievements').props.onClick();
  assert.deepEqual(state.calls[0], ['open', 'https://www.trueachievements.com']);
  await state.button('Connect browser session').props.onClick();
  assert.deepEqual(state.calls[1], ['connect', []]);
  assert.deepEqual(state.calls[2], ['refresh']);
  assert.ok(state.button('Disconnect TA session'));
  await state.button('Disconnect TA session').props.onClick();
  assert.equal(state.button('Disconnect TA session'), undefined);
});
test('failed browser connection shows recovery instructions without claiming success', async () => {
  const state = fixture({ status: 'disconnected', error: 'browser_unavailable' });
  await state.button('Connect browser session').props.onClick();
  assert.equal(state.calls.some(call => call[0] === 'refresh'), false);
  assert.ok(state.render().some(node => node.props?.role === 'alert' && node.props.children.includes('Keep TrueAchievements open in the Steam browser, then try connecting again.')));
  assert.equal(state.button('Disconnect TA session'), undefined);
});

test('game view puts accessible icon actions inside the TA row', async () => {
  const state = fixture({ status: 'connected' }, '42');
  assert.ok(state.render().some(node => node.props?.className === 'nexus-ta-row'));
  assert.equal(state.render().filter(node => node.type === 'button').length, 0);
  assert.equal(state.render().filter(node => node.type === 'icon-button').length, 3);
  state.button('View on TrueAchievements').props.onClick();
  assert.deepEqual(state.calls[0], ['open', 'https://www.trueachievements.com/deeplink/42']);
  await state.button('Connect browser session').props.onClick();
  assert.ok(state.button('Disconnect TA session'));
  assert.ok(state.render().some(node => node.type === 'field' && node.props.description === 'TA session saved on this device.'));
});
