'use strict';
/**
 * Pairing: a short-lived, single-use, high-entropy code (12 characters from a
 * 31-symbol alphabet, about 59 bits) shown on the PC and typed on the phone.
 *
 * The code is NEVER sent over the network. Instead the phone sends
 *   proof = HMAC-SHA256(key = code, "PT1|client|<serverNonce>|<clientNonce>|<certFingerprint>")
 * where <certFingerprint> is the SHA-256 of the TLS certificate the phone
 * actually received. The receiver verifies against its own certificate, so a
 * man-in-the-middle presenting a different certificate cannot produce a valid
 * proof, and the receiver answers with a matching "server" proof so the phone
 * can authenticate the receiver too.
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
const CODE_LENGTH = 12;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function generateCode() {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

function formatCode(code) {
  return code.match(/.{1,4}/g).join('-');
}

/** Uppercase and drop everything that is not a letter or digit. */
function normalizeCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isValidCodeShape(code) {
  return code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c));
}

function computeProof(role, code, serverNonce, clientNonce, fingerprintHex) {
  return crypto
    .createHmac('sha256', Buffer.from(normalizeCode(code), 'utf8'))
    .update(`PT1|${role}|${serverNonce}|${clientNonce}|${fingerprintHex}`, 'utf8')
    .digest('hex');
}

function safeEqualHex(a, b) {
  if (!HEX64.test(a) || !HEX64.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

class PairingManager extends EventEmitter {
  constructor({
    codeTtlMs = 5 * 60 * 1000,
    maxFailuresPerCode = 5,
    globalLockMs = 30 * 1000,
    ipFailThreshold = 3,
    ipLockBaseMs = 15 * 1000,
    ipLockMaxMs = 15 * 60 * 1000,
    now = () => Date.now(),
  } = {}) {
    super();
    this.codeTtlMs = codeTtlMs;
    this.maxFailuresPerCode = maxFailuresPerCode;
    this.globalLockMs = globalLockMs;
    this.ipFailThreshold = ipFailThreshold;
    this.ipLockBaseMs = ipLockBaseMs;
    this.ipLockMaxMs = ipLockMaxMs;
    this.now = now;

    this.code = null;
    this.expiresAt = 0;
    this.codeFailures = 0;
    this.globalLockUntil = 0;
    this.ips = new Map(); // ip -> { fails, lockCount, lockedUntil, touched }
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.code && this.now() >= this.expiresAt) this.issue('expired');
    }, 1000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.code = null;
  }

  /** Generate and publish a fresh code. */
  issue(reason = 'new') {
    this.code = generateCode();
    this.expiresAt = this.now() + this.codeTtlMs;
    this.codeFailures = 0;
    this.emit('code', { code: this.code, formatted: formatCode(this.code), expiresAt: this.expiresAt, reason });
    return this.code;
  }

  /** Remove the current code (used while a controller is connected). */
  invalidate() {
    this.code = null;
  }

  hasValidCode() {
    return !!this.code && this.now() < this.expiresAt;
  }

  lockRemainingMs(ip) {
    const t = this.now();
    let remaining = Math.max(0, this.globalLockUntil - t);
    const st = this.ips.get(ip);
    if (st) remaining = Math.max(remaining, st.lockedUntil - t);
    return remaining;
  }

  _prune() {
    if (this.ips.size < 500) return;
    const cutoff = this.now() - 60 * 60 * 1000;
    for (const [ip, st] of this.ips) if (st.touched < cutoff && st.lockedUntil < this.now()) this.ips.delete(ip);
  }

  /**
   * @returns {{ok: true, serverProof: string} | {ok: false, reason: 'locked'|'expired'|'bad_proof', retryAfterMs?: number}}
   */
  attempt({ ip, serverNonce, clientNonce, proof, fingerprint }) {
    const t = this.now();
    const locked = this.lockRemainingMs(ip);
    if (locked > 0) return { ok: false, reason: 'locked', retryAfterMs: locked };
    if (!this.hasValidCode()) return { ok: false, reason: 'expired' };
    if (!HEX32.test(clientNonce) || !HEX64.test(proof)) return { ok: false, reason: 'bad_proof' };

    const expected = computeProof('client', this.code, serverNonce, clientNonce, fingerprint);
    if (safeEqualHex(expected, proof)) {
      const serverProof = computeProof('server', this.code, serverNonce, clientNonce, fingerprint);
      this.ips.delete(ip);
      this.invalidate();
      return { ok: true, serverProof };
    }

    // failure bookkeeping
    this._prune();
    const st = this.ips.get(ip) || { fails: 0, lockCount: 0, lockedUntil: 0, touched: t };
    st.touched = t;
    st.fails += 1;
    let retryAfterMs;
    if (st.fails >= this.ipFailThreshold) {
      retryAfterMs = Math.min(this.ipLockBaseMs * 2 ** st.lockCount, this.ipLockMaxMs);
      st.lockCount += 1;
      st.fails = 0;
      st.lockedUntil = t + retryAfterMs;
    }
    this.ips.set(ip, st);

    this.codeFailures += 1;
    if (this.codeFailures >= this.maxFailuresPerCode) {
      // Too many wrong guesses against this code, from anyone: burn it and pause pairing.
      this.globalLockUntil = t + this.globalLockMs;
      this.issue('too-many-failures');
      this.emit('lockout', { scope: 'global', ms: this.globalLockMs });
      retryAfterMs = Math.max(retryAfterMs || 0, this.globalLockMs);
    }
    return { ok: false, reason: 'bad_proof', retryAfterMs };
  }
}

module.exports = {
  ALPHABET,
  CODE_LENGTH,
  generateCode,
  formatCode,
  normalizeCode,
  isValidCodeShape,
  computeProof,
  PairingManager,
};
