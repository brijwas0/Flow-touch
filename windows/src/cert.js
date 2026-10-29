'use strict';
/**
 * Ephemeral self-signed X.509 certificate generation using only Node's crypto.
 *
 * A fresh ECDSA P-256 key and certificate are generated every time the
 * receiver starts and are kept in memory only (nothing is written to disk).
 * The phone does not trust a certificate authority; it binds the pairing
 * proof to this certificate's SHA-256 fingerprint instead (see pairing.js).
 */

const crypto = require('node:crypto');

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const octets = (b) => tlv(0x04, b);
const utf8String = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const boolTrue = () => tlv(0x01, Buffer.from([0xff]));

function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    let v = Math.floor(p / 128);
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

function positiveInteger(buf) {
  let b = buf;
  while (b.length > 1 && b[0] === 0) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function smallInteger(n) {
  return positiveInteger(Buffer.from([n]));
}

function utcTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  const s =
    p(date.getUTCFullYear() % 100) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds()) +
    'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

function extension(oidStr, critical, value) {
  const parts = [oid(oidStr)];
  if (critical) parts.push(boolTrue());
  parts.push(octets(value));
  return seq(...parts);
}

function ipv4Bytes(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`invalid IPv4 address: ${ip}`);
  }
  return Buffer.from(parts);
}

function toPem(label, der) {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/**
 * @param {{ ips?: string[], commonName?: string, validDays?: number }} options
 * @returns {{ keyPem: string, certPem: string, fingerprint: string }}
 *   fingerprint = lowercase hex SHA-256 of the DER certificate.
 */
function generateSelfSigned({ ips = [], commonName = 'PhoneTouch Receiver', validDays = 7 } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  const now = new Date();
  const notBefore = new Date(now.getTime() - 60 * 60 * 1000);
  const notAfter = new Date(now.getTime() + validDays * 24 * 60 * 60 * 1000);

  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;

  const sigAlg = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const name = seq(set(seq(oid('2.5.4.3'), utf8String(commonName))));

  const altNames = [tlv(0x82, Buffer.from('localhost', 'ascii'))];
  for (const ip of ips) altNames.push(tlv(0x87, ipv4Bytes(ip)));

  const extensions = seq(
    extension('2.5.29.19', true, seq()), // basicConstraints: not a CA
    extension('2.5.29.15', true, Buffer.from([0x03, 0x02, 0x07, 0x80])), // keyUsage: digitalSignature
    extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), // extKeyUsage: serverAuth
    extension('2.5.29.17', false, seq(...altNames)) // subjectAltName
  );

  const tbs = seq(
    tlv(0xa0, smallInteger(2)), // version: v3
    positiveInteger(serial),
    sigAlg,
    name,
    seq(utcTime(notBefore), utcTime(notAfter)),
    name,
    spki,
    tlv(0xa3, extensions)
  );

  const signature = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const certDer = seq(tbs, sigAlg, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));

  return {
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    certPem: toPem('CERTIFICATE', certDer),
    fingerprint: crypto.createHash('sha256').update(certDer).digest('hex'),
  };
}

module.exports = { generateSelfSigned };
