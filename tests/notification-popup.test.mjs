import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitNotificationPopup } from '../src/notification-popup.ts';

test('multiline popup sizing includes margins and restores the shared Steam placeholder', () => {
  const values = new Map();
  let height = 88, resized, disconnected = false;
  const style = { getPropertyValue: () => '', getPropertyPriority: () => '',
    setProperty: (key, value) => values.set(key, value), removeProperty: key => values.delete(key) };
  const placeholder = { style, ownerDocument: { defaultView: { getComputedStyle: () => ({
    paddingTop: '20px', paddingBottom: '20px', borderTopWidth: '0', borderBottomWidth: '0', boxSizing: 'content-box' }) } } };
  const popup = { getBoundingClientRect: () => ({ height }) };
  const stop = fitNotificationPopup(popup, placeholder, callback => { resized = callback; return { observe() {}, disconnect() { disconnected = true; } }; });
  assert.equal(values.get('height'), '88px'); // 128px total with Steam's padding
  height = 150; resized(); assert.equal(values.get('height'), '150px');
  stop(); assert.equal(disconnected, true); assert.equal(values.has('height'), false);
});
