'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJson, validateControl, segmentText, sanitizeName, KEYS, LIMITS, ProtocolError } = require('../src/protocol');

const ok = (m) => validateControl(m);
const bad = (m) => assert.throws(() => validateControl(m), ProtocolError);

test('parseJson accepts objects with a string type and rejects everything else', () => {
  assert.deepEqual(parseJson('{"t":"ping"}'), { t: 'ping' });
  for (const s of ['', 'nope', '[]', '1', 'null', '{"t":5}', '{}', '"str"']) assert.throws(() => parseJson(s), ProtocolError);
  assert.throws(() => parseJson('{"t":"txt","s":"' + 'a'.repeat(LIMITS.maxMessageBytes) + '"}'), ProtocolError);
});

test('mouse move: integers within +-1000 only', () => {
  assert.deepEqual(ok({ t: 'm', dx: 5, dy: -7 }), { t: 'm', dx: 5, dy: -7 });
  assert.deepEqual(ok({ t: 'm', dx: 1000, dy: -1000 }), { t: 'm', dx: 1000, dy: -1000 });
  bad({ t: 'm', dx: 1001, dy: 0 });
  bad({ t: 'm', dx: 0, dy: -1001 });
  bad({ t: 'm', dx: 1.5, dy: 0 });
  bad({ t: 'm', dx: '5', dy: 0 });
  bad({ t: 'm', dx: NaN, dy: 0 });
  bad({ t: 'm', dx: 1 });
  bad({ t: 'm', dx: null, dy: 0 });
});

test('buttons: only l/r/m with d/u/c', () => {
  assert.deepEqual(ok({ t: 'b', b: 'l', a: 'c' }), { t: 'b', b: 'l', a: 'c' });
  ok({ t: 'b', b: 'r', a: 'd' });
  ok({ t: 'b', b: 'm', a: 'u' });
  bad({ t: 'b', b: 'x', a: 'c' });
  bad({ t: 'b', b: 'l', a: 'z' });
  bad({ t: 'b', b: 'l' });
});

test('scroll: optional axes, +-2400', () => {
  assert.deepEqual(ok({ t: 's', dy: 120 }), { t: 's', dx: 0, dy: 120 });
  assert.deepEqual(ok({ t: 's', dx: -240, dy: 0 }), { t: 's', dx: -240, dy: 0 });
  bad({ t: 's', dy: 2401 });
  bad({ t: 's', dx: 1.2 });
});

test('keys: only the whitelist', () => {
  for (const k of Object.keys(KEYS)) ok({ t: 'k', k });
  for (const k of ['f4', 'win', 'ctrl', 'alt', 'constructor', '__proto__', 'toString', '', 13, null]) bad({ t: 'k', k });
});

test('gestures: only whitelisted precision touchpad gestures', () => {
  for (const a of ['start', 'desktop', 'notifications', 'app_next', 'app_prev', 'desktop_next', 'desktop_prev', 'task_view']) {
    assert.deepEqual(ok({ t: 'g', a }), { t: 'g', a });
  }
  bad({ t: 'g', a: 'unknown' });
  bad({ t: 'g', a: '' });
  bad({ t: 'g', a: null });
  bad({ t: 'g' });
});

test('zoom: bounds +-2400', () => {
  assert.deepEqual(ok({ t: 'z', dy: 120 }), { t: 'z', dy: 120 });
  assert.deepEqual(ok({ t: 'z', dy: -120 }), { t: 'z', dy: -120 });
  bad({ t: 'z', dy: 2401 });
  bad({ t: 'z', dy: -2401 });
  bad({ t: 'z', dy: 1.5 });
  bad({ t: 'z' });
});

test('text: bounded, must be valid Unicode', () => {
  ok({ t: 'txt', s: 'héllo 世界 😀' });
  bad({ t: 'txt', s: '' });
  bad({ t: 'txt', s: 'a'.repeat(LIMITS.textMaxUnits + 1) });
  bad({ t: 'txt', s: 5 });
  bad({ t: 'txt', s: 'lone \ud800 surrogate' });
});

test('unknown types are rejected', () => {
  bad({ t: 'exec', cmd: 'calc' });
  bad({ t: 'pair' });
});

test('segmentText turns newline/tab into keys, keeps Unicode, drops other control characters', () => {
  assert.deepEqual(segmentText('ab\ncd\tef'), [{ text: 'ab' }, { key: 'enter' }, { text: 'cd' }, { key: 'tab' }, { text: 'ef' }]);
  assert.deepEqual(segmentText('a\r\nb'), [{ text: 'a' }, { key: 'enter' }, { text: 'b' }]);
  assert.deepEqual(segmentText('x\u0007y\u001bz\u007f'), [{ text: 'xyz' }]);
  assert.deepEqual(segmentText('😀é世'), [{ text: '😀é世' }]);
  assert.deepEqual(segmentText('\u0000\u0001'), []);
});

test('sanitizeName strips control characters and limits length', () => {
  assert.equal(sanitizeName('Pixel\n7'), 'Pixel7');
  assert.equal(sanitizeName('x'.repeat(100)).length, LIMITS.nameMaxLength);
  assert.equal(sanitizeName(42), 'Phone');
  assert.equal(sanitizeName('   '), 'Phone');
});
