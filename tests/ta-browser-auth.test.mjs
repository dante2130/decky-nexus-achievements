import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../ta_session.py', import.meta.url), 'utf8');
const expression = source.match(/expression = """([\s\S]*?)"""/)[1].replaceAll('\\\\', '\\');
function authenticated(controls) {
  const result = vm.runInNewContext(expression, { location: { origin: 'https://www.trueachievements.com' },
    navigator: { userAgent: 'Steam' }, document: { querySelectorAll: () => controls.map(control => ({
      textContent: control.text || '', getAttribute: key => control[key] || null,
    })) } });
  return JSON.parse(result).authenticated;
}
test('TA icon-only postback logout control confirms the signed-in browser', () => {
  assert.equal(authenticated([{ text: '', title: 'Log out', href: "javascript:Postback('btnLogOut_click')" }]), true);
  assert.equal(authenticated([{ text: '', 'aria-label': 'Sign out' }]), true);
  assert.equal(authenticated([{ text: ' Log   out ' }]), true);
});
test('anonymous pages and public gamer links do not count as authenticated', () => {
  assert.equal(authenticated([{ text: 'Sign in', href: '/login' }, { text: 'Gamer', href: '/gamer/someone' }]), false);
  assert.equal(authenticated([]), false);
});
