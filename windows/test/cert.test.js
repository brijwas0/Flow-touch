'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { generateSelfSigned } = require('../src/cert');

test('generated certificate parses, is self-consistent and has the expected fields', () => {
  const { certPem, keyPem, fingerprint } = generateSelfSigned({ ips: ['192.168.1.20', '10.0.0.5'] });
  const x509 = new crypto.X509Certificate(certPem);
  assert.equal(x509.subject, 'CN=PhoneTouch Receiver');
  assert.equal(x509.verify(x509.publicKey), true, 'self-signature verifies');
  assert.equal(x509.checkPrivateKey(crypto.createPrivateKey(keyPem)), true, 'key matches certificate');
  assert.match(x509.subjectAltName, /IP Address:192\.168\.1\.20/);
  assert.match(x509.subjectAltName, /IP Address:10\.0\.0\.5/);
  assert.match(x509.subjectAltName, /DNS:localhost/);
  assert.equal(x509.ca, false);
  assert.equal(x509.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.equal(fingerprint, x509.fingerprint256.replace(/:/g, '').toLowerCase());
  assert.ok(new Date(x509.validTo) > new Date(), 'not expired');
  assert.ok(new Date(x509.validFrom) < new Date(), 'already valid');
});

test('two generations produce different keys and fingerprints', () => {
  assert.notEqual(generateSelfSigned().fingerprint, generateSelfSigned().fingerprint);
});

test('OpenSSL accepts the certificate (independent parser)', (t) => {
  const probe = spawnSync('openssl', ['version']);
  if (probe.error || probe.status !== 0) return t.skip('openssl not installed');
  const { certPem } = generateSelfSigned({ ips: ['192.168.1.20'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-cert-'));
  const file = path.join(dir, 'c.pem');
  fs.writeFileSync(file, certPem);
  const text = spawnSync('openssl', ['x509', '-in', file, '-noout', '-text'], { encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /ecdsa-with-SHA256/);
  assert.match(text.stdout, /IP Address:192\.168\.1\.20/);
  const verify = spawnSync('openssl', ['verify', '-CAfile', file, file], { encoding: 'utf8' });
  // A self-signed leaf that is not a CA fails strict chain building; accept either OK or the known "not a CA" style errors,
  // but the signature itself must not be reported as bad.
  assert.doesNotMatch(verify.stdout + verify.stderr, /signature failure|certificate signature/i);
  fs.rmSync(dir, { recursive: true, force: true });
});
