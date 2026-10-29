'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const P = require('../src/pairing');

const FP = crypto.createHash('sha256').update('test-cert').digest('hex');
const SN = '00112233445566778899aabbccddeeff';
const CN = 'ffeeddccbbaa99887766554433221100';

test('cross-language test vectors (the Android app asserts the same values)', () => {
  assert.equal(FP, 'ac978e63f273ba9ee1132bfecc103c767c52512fd5b065cc0ee224f9ec49d6a2');
  assert.equal(
    P.computeProof('client', 'K7QM-X2TD-9FRA', SN, CN, FP),
    'f0a847480defde8fdd0d4bf693c9ffa0e92c5d19e5c80ba47e7856997bcdd9c7'
  );
  assert.equal(
    P.computeProof('server', 'k7qm x2td 9fra', SN, CN, FP),
    '9e4d7765473728217eb4ea1d49176b47a1839be7e40bd00c5fbd98781213033e'
  );
});

test('generated codes are 12 characters from the safe alphabet and formatted in groups of 4', () => {
  for (let i = 0; i < 200; i++) {
    const c = P.generateCode();
    assert.equal(c.length, 12);
    assert.ok(P.isValidCodeShape(c));
    assert.match(P.formatCode(c), /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  }
  assert.ok(!/[ILO01]/.test(P.ALPHABET));
  assert.equal(P.normalizeCode(' k7qm-x2td 9fra '), 'K7QMX2TD9FRA');
});

function makeManager(extra = {}) {
  const clock = { t: 1_000_000 };
  const m = new P.PairingManager({ now: () => clock.t, ...extra });
  m.issue();
  return { m, clock };
}

const attempt = (m, code, ip = '192.168.1.9', extra = {}) =>
  m.attempt({
    ip,
    serverNonce: SN,
    clientNonce: CN,
    proof: P.computeProof('client', code, SN, CN, FP),
    fingerprint: FP,
    ...extra,
  });

test('valid proof pairs, returns a verifiable server proof, and the code is single-use', () => {
  const { m } = makeManager();
  const code = m.code;
  const r = attempt(m, code);
  assert.equal(r.ok, true);
  assert.equal(r.serverProof, P.computeProof('server', code, SN, CN, FP));
  assert.equal(m.hasValidCode(), false);
  assert.equal(attempt(m, code).reason, 'expired');
});

test('a proof computed for a different certificate fingerprint is rejected (interception)', () => {
  const { m } = makeManager();
  const other = crypto.createHash('sha256').update('attacker-cert').digest('hex');
  const r = m.attempt({
    ip: '192.168.1.50',
    serverNonce: SN,
    clientNonce: CN,
    proof: P.computeProof('client', m.code, SN, CN, other),
    fingerprint: FP,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_proof');
});

test('wrong code is rejected; malformed proof is rejected without throwing', () => {
  const { m } = makeManager();
  assert.equal(attempt(m, 'AAAAAAAAAAAA').reason, 'bad_proof');
  assert.equal(attempt(m, m.code, '192.168.1.9', { proof: 'zz' }).reason, 'bad_proof');
});

test('codes expire', () => {
  const { m, clock } = makeManager({ codeTtlMs: 1000 });
  const code = m.code;
  clock.t += 1001;
  assert.equal(attempt(m, code).reason, 'expired');
});

test('per-IP lockout after repeated failures, with escalating duration; success is impossible while locked', () => {
  const { m, clock } = makeManager({ ipFailThreshold: 3, ipLockBaseMs: 1000, maxFailuresPerCode: 100 });
  const code = m.code;
  for (let i = 0; i < 3; i++) assert.equal(attempt(m, 'AAAAAAAAAAAA', '192.168.1.7').reason, 'bad_proof');
  const locked = attempt(m, code, '192.168.1.7'); // even the right code is refused during the lock
  assert.equal(locked.reason, 'locked');
  assert.ok(locked.retryAfterMs > 0 && locked.retryAfterMs <= 1000);
  assert.equal(attempt(m, code, '192.168.1.8').ok, true, 'other devices are not locked by this IP');
  assert.ok(clock.t > 0);
});

test('lock duration doubles on repeated lockouts', () => {
  const { m, clock } = makeManager({ ipFailThreshold: 1, ipLockBaseMs: 1000, maxFailuresPerCode: 100 });
  const ip = '192.168.1.7';
  assert.equal(attempt(m, 'AAAAAAAAAAAA', ip).retryAfterMs, 1000);
  clock.t += 1001;
  assert.equal(attempt(m, 'AAAAAAAAAAAA', ip).retryAfterMs, 2000);
  clock.t += 2001;
  assert.equal(attempt(m, 'AAAAAAAAAAAA', ip).retryAfterMs, 4000);
});

test('after too many wrong guesses from anyone the code is burned, replaced and pairing is paused', () => {
  const { m, clock } = makeManager({ maxFailuresPerCode: 5, ipFailThreshold: 100, globalLockMs: 5000 });
  const original = m.code;
  const issued = [];
  m.on('code', (c) => issued.push(c));
  for (let i = 0; i < 5; i++) attempt(m, 'AAAAAAAAAAAA', `192.168.1.${10 + i}`);
  assert.equal(issued.length, 1, 'a new code was issued');
  assert.notEqual(m.code, original);
  assert.equal(attempt(m, original, '192.168.1.99').reason, 'locked');
  assert.equal(attempt(m, m.code, '192.168.1.99').reason, 'locked', 'even the new code waits out the global pause');
  clock.t += 5001;
  assert.equal(attempt(m, original, '192.168.1.99').reason, 'bad_proof', 'the burned code no longer works');
  assert.equal(attempt(m, m.code, '192.168.1.99').ok, true);
});
