import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotificationAudio, observePopupSound, isNexusToast } from '../src/notification-audio.ts';

const payload = { data: 'YXVkaW8=', mime: 'audio/wav' };
function player() { return { plays: 0, pauses: 0, onended: null, async play() { this.plays++; }, pause() { this.pauses++; } }; }
test('custom files are cached, replaced independently, and notify remounted controls', async () => {
  let loads = 0, updates = 0;
  const players = [];
  const audio = new NotificationAudio(async () => { loads++; return payload; }, source => {
    assert.equal(source, 'data:audio/wav;base64,YXVkaW8=');
    const value = player(); players.push(value); return value;
  });
  const unsubscribe = audio.subscribe(() => updates++);
  audio.configure({ normal: '/sound.wav' });
  await audio.play('normal'); await audio.play('normal');
  assert.equal(loads, 1); assert.equal(players[0].pauses, 1);
  audio.configure({ normal: '/sound.wav' });
  assert.equal(players[1].pauses, 0);
  audio.configure({ normal: '/replacement.wav', rare: '/rare.wav' });
  assert.equal(updates, 2); assert.equal(audio.getFiles().rare, '/rare.wav');
  await audio.play('normal'); assert.equal(loads, 2);
  audio.configure({}); assert.equal(audio.has('normal'), false);
  await audio.play('normal'); assert.equal(loads, 2);
  unsubscribe(); audio.dispose();
});
test('pending playback is cancelled on replacement or unload', async () => {
  let resolve; let created = 0;
  const audio = new NotificationAudio(() => new Promise(r => { resolve = r; }), () => { created++; return player(); });
  audio.configure({ mythic: '/award.wav' });
  const pending = audio.play('mythic'); audio.dispose(); resolve(payload); await pending;
  assert.equal(created, 0);
});
test('load failures retry and rejected playback stops its player', async () => {
  let loads = 0;
  const failing = player(); failing.play = async () => { throw new Error('unsupported codec'); };
  const audio = new NotificationAudio(async () => { if (++loads === 1) throw new Error('missing'); return payload; }, () => failing);
  audio.configure({ rare: '/rare.wav' });
  await assert.rejects(audio.play('rare'), /missing/);
  await assert.rejects(audio.play('rare'), /unsupported codec/);
  assert.equal(loads, 2); assert.equal(failing.pauses, 1);
});

test('audio starts once when a popup intersects, never from notification history', () => {
  let callback, starts = 0, isVisible, disconnected = false;
  const popup = { isConnected: true };
  const observer = fn => { callback = fn; return { observe() {}, disconnect() { disconnected = true; } }; };
  const playback = { kind: 'rare', played: false };
  const start = (kind, check) => { assert.equal(kind, 'rare'); starts++; isVisible = check; };
  observePopupSound({ closest: () => null }, playback, start, observer);
  assert.equal(starts, 0);
  const dispose = observePopupSound({ closest: () => popup }, playback, start, observer);
  callback([{ isIntersecting: false, intersectionRatio: 0 }]); assert.equal(starts, 0);
  callback([{ isIntersecting: true, intersectionRatio: 0.2 }]); assert.equal(starts, 1);
  assert.equal(isVisible(), true);
  callback([{ isIntersecting: true, intersectionRatio: 1 }]); assert.equal(starts, 1);
  callback([{ isIntersecting: false, intersectionRatio: 0 }]); assert.equal(isVisible(), false);
  dispose(); assert.equal(disconnected, true); assert.equal(isVisible(), false);
  observePopupSound({ closest: () => popup }, playback, start, observer);
  assert.equal(starts, 1);
});
test('audio loaded after the popup disappears is not played', async () => {
  let resolve, visible = true, created = 0;
  const audio = new NotificationAudio(() => new Promise(r => { resolve = r; }), () => { created++; return player(); });
  audio.configure({ normal: '/sound.wav' });
  const pending = audio.play('normal', () => visible);
  visible = false; resolve(payload); await pending;
  assert.equal(created, 0);
});

test('sound length is measured once and invalidated when the selected file changes', async () => {
  let measured = 0;
  const audio = new NotificationAudio(async () => payload, () => player(), async () => { measured++; return 11000; });
  assert.equal(await audio.duration('rare'), 0);
  audio.configure({ rare: '/rare.wav' });
  assert.deepEqual(await Promise.all([audio.duration('rare'), audio.duration('rare')]), [11000, 11000]);
  assert.equal(measured, 1);
  audio.configure({ rare: '/longer.wav' });
  assert.equal(await audio.duration('rare'), 11000); assert.equal(measured, 2);
  audio.invalidate('rare'); await audio.duration('rare'); assert.equal(measured, 3);
  audio.configure({}); assert.equal(await audio.duration('rare'), 0);
});

test('native sound suppression is restricted to Nexus toast markers', () => {
  const nexus = { decky: true, data: { className: 'other nexus-achievement-notification' } };
  assert.equal(isNexusToast(nexus), true);
  assert.equal(isNexusToast({ notifications: [nexus] }), true);
  for (const value of [null, {}, { decky: true, data: { className: 'other-plugin' } },
    { data: { className: 'nexus-achievement-notification' } },
    { decky: true, data: { className: 'nexus-achievement-notification-other' } }]) assert.equal(isNexusToast(value), false);
});
test('visibility observer requests a positive threshold for Steam slide-in animations', () => {
  const original = globalThis.IntersectionObserver;
  let options;
  globalThis.IntersectionObserver = class { constructor(callback, opts) { options = opts; } observe() {} disconnect() {} };
  try {
    const stop = observePopupSound({ closest: () => ({ isConnected: true }) }, { kind: 'normal', played: false }, () => {});
    assert.deepEqual(options.threshold, [0, 0.01]); stop();
  } finally { globalThis.IntersectionObserver = original; }
});

test('first popup uses persisted sound length without waiting for cold audio loading', async () => {
  let loads = 0, measurements = 0;
  const audio = new NotificationAudio(async () => { loads++; return payload; }, player, async () => { measurements++; return 9000; });
  audio.configure({ normal: '/sound.wav' }, { normal: 12000 });
  assert.equal(await audio.duration('normal'), 12000);
  assert.equal(loads, 0);
  assert.equal(measurements, 0);
  await audio.play('normal');
  assert.equal(loads, 1);
  audio.configure({ normal: '/replacement.wav' });
  assert.equal(await audio.duration('normal'), 9000);
  assert.equal(measurements, 1);
  audio.dispose();
});
