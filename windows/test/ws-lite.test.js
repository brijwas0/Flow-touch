'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeAccept, encodeFrame, FrameParser, OP, WsError } = require('../src/ws-lite');

test('handshake accept key matches the RFC 6455 example', () => {
  assert.equal(computeAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('parses the RFC 6455 masked "Hello" example', () => {
  const p = new FrameParser({ maxPayload: 1024, requireMask: true });
  const frames = p.push(Buffer.from('818537fa213d7f9f4d5158', 'hex'));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, OP.TEXT);
  assert.equal(frames[0].fin, true);
  assert.equal(frames[0].payload.toString(), 'Hello');
});

test('encodes the RFC 6455 unmasked "Hello" example', () => {
  assert.equal(encodeFrame(OP.TEXT, Buffer.from('Hello'), false).toString('hex'), '810548656c6c6f');
});

test('round-trips payloads of 7-bit, 16-bit and 64-bit length classes', () => {
  for (const n of [0, 5, 125, 126, 300, 65535, 65536, 70000]) {
    const payload = Buffer.alloc(n, 0x61);
    const server = new FrameParser({ maxPayload: 1 << 20, requireMask: true });
    const [f] = server.push(encodeFrame(OP.TEXT, payload, true));
    assert.equal(f.payload.length, n);
    const client = new FrameParser({ maxPayload: 1 << 20, requireMask: false });
    const [g] = client.push(encodeFrame(OP.TEXT, payload, false));
    assert.equal(g.payload.length, n);
  }
});

test('handles frames split across arbitrary chunk boundaries and several frames per chunk', () => {
  const a = encodeFrame(OP.TEXT, Buffer.from('first'), true);
  const b = encodeFrame(OP.TEXT, Buffer.from('second message'), true);
  const all = Buffer.concat([a, b]);
  const p = new FrameParser({ maxPayload: 1024, requireMask: true });
  const got = [];
  for (let i = 0; i < all.length; i++) got.push(...p.push(all.subarray(i, i + 1)));
  assert.deepEqual(got.map((f) => f.payload.toString()), ['first', 'second message']);
  const p2 = new FrameParser({ maxPayload: 1024, requireMask: true });
  assert.equal(p2.push(all).length, 2);
});

test('rejects unmasked client frames, reserved bits, bad opcodes and bad control frames', () => {
  const mk = () => new FrameParser({ maxPayload: 1024, requireMask: true });
  assert.throws(() => mk().push(encodeFrame(OP.TEXT, Buffer.from('x'), false)), (e) => e instanceof WsError && e.closeCode === 1002);
  const rsv = encodeFrame(OP.TEXT, Buffer.from('x'), true);
  rsv[0] |= 0x40;
  assert.throws(() => mk().push(rsv), (e) => e.closeCode === 1002);
  const badOp = encodeFrame(OP.TEXT, Buffer.from('x'), true);
  badOp[0] = 0x80 | 0x3;
  assert.throws(() => mk().push(badOp), (e) => e.closeCode === 1002);
  const fragmentedPing = encodeFrame(OP.PING, Buffer.from('x'), true);
  fragmentedPing[0] &= 0x7f;
  assert.throws(() => mk().push(fragmentedPing), (e) => e.closeCode === 1002);
  assert.throws(() => mk().push(encodeFrame(OP.PING, Buffer.alloc(126), true)), (e) => e.closeCode === 1002);
});

test('rejects oversized frames before buffering them', () => {
  const p = new FrameParser({ maxPayload: 100, requireMask: true });
  assert.throws(() => p.push(encodeFrame(OP.TEXT, Buffer.alloc(101), true)), (e) => e.closeCode === 1009);
  const huge = Buffer.alloc(10);
  huge[0] = 0x81;
  huge[1] = 0x80 | 127;
  huge.writeBigUInt64BE(1n << 40n, 2);
  assert.throws(() => new FrameParser({ maxPayload: 100, requireMask: true }).push(huge), (e) => e.closeCode === 1009);
});
