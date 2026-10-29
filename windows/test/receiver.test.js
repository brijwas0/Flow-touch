'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { Receiver } = require('../src/receiver');
const { MockBackend } = require('../src/input/mock-backend');
const { OP } = require('../src/ws-lite');
const { connect, pair, sleep } = require('./helpers/ws-test-client');

async function setup(extra = {}) {
  const backend = new MockBackend();
  const receiver = new Receiver({
    hosts: ['127.0.0.1'],
    port: 0,
    backend,
    pairing: { globalLockMs: 300, ipLockBaseMs: 200 },
    ...extra,
  });
  const codes = [];
  receiver.on('code', (c) => codes.push(c));
  const logs = [];
  receiver.on('log', (l) => logs.push(l));
  await receiver.start();
  return { receiver, backend, codes, logs, port: receiver.port };
}

async function pairedClient(ctx, name) {
  const c = await connect({ port: ctx.port });
  const reply = await pair(c, ctx.receiver.currentCode, { name });
  assert.equal(reply.t, 'paired', JSON.stringify(reply));
  return { c, reply };
}

const types = (b) => b.events.map((e) => e.type);

test('health endpoint works, exposes no secrets, and unknown paths/methods are refused', async () => {
  const ctx = await setup();
  try {
    const get = (path, method = 'GET') =>
      new Promise((resolve, reject) => {
        const req = https.request({ host: '127.0.0.1', port: ctx.port, path, method, rejectUnauthorized: false }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
      });
    const h = await get('/health');
    assert.equal(h.status, 200);
    const j = JSON.parse(h.body);
    assert.equal(j.ok, true);
    assert.equal(j.state, 'waiting');
    assert.equal(j.backend, 'mock');
    assert.ok(!h.body.includes(ctx.receiver.currentCode), 'pairing code is never exposed');
    assert.equal((await get('/')).status, 404);
    assert.equal((await get('/ws')).status, 404, 'plain GET of /ws is not an upgrade');
    assert.equal((await get('/health', 'POST')).status, 405);
    assert.equal((await get('/control', 'POST')).status, 404);
  } finally {
    await ctx.receiver.stop();
  }
});

test('pairing succeeds with the right code, returns a valid server proof, and input reaches the backend', async () => {
  const ctx = await setup();
  try {
    const { c, reply } = await pairedClient(ctx, 'Pixel 7');
    assert.equal(reply.proof, reply.expectedServerProof, 'phone can authenticate the receiver');
    assert.equal(ctx.receiver.state, 'controlled');
    assert.equal(ctx.receiver.currentCode, null, 'code is consumed');

    c.send({ t: 'm', dx: 12, dy: -5 });
    c.send({ t: 'b', b: 'l', a: 'c' });
    c.send({ t: 'b', b: 'r', a: 'c' });
    c.send({ t: 's', dy: 120 });
    c.send({ t: 's', dx: -240, dy: 0 });
    c.send({ t: 'k', k: 'escape' });
    c.send({ t: 'txt', s: 'hi 世界\nok' });
    c.send({ t: 'ping' });
    await c.waitFor((m) => m.t === 'pong');
    assert.deepEqual(ctx.backend.events, [
      { type: 'move', dx: 12, dy: -5 },
      { type: 'button', button: 'l', down: true },
      { type: 'button', button: 'l', down: false },
      { type: 'button', button: 'r', down: true },
      { type: 'button', button: 'r', down: false },
      { type: 'wheel', dx: 0, dy: 120 },
      { type: 'wheel', dx: -240, dy: 0 },
      { type: 'key', name: 'escape' },
      { type: 'text', text: 'hi 世界' },
      { type: 'key', name: 'enter' },
      { type: 'text', text: 'ok' },
    ]);
    c.close();
    await c.waitClosed();
  } finally {
    await ctx.receiver.stop();
  }
});

test('wrong code is rejected, nothing is controllable, and the connection is closed', async () => {
  const ctx = await setup();
  try {
    const c = await connect({ port: ctx.port });
    const reply = await pair(c, 'AAAA-AAAA-AAAA');
    assert.equal(reply.t, 'error');
    assert.equal(reply.code, 'bad_proof');
    assert.equal(await c.waitClosed(), 4001);
    assert.equal(ctx.receiver.state, 'waiting');
    assert.equal(ctx.backend.events.length, 0);
  } finally {
    await ctx.receiver.stop();
  }
});

test('a man-in-the-middle certificate is detected: proof bound to a different fingerprint fails', async () => {
  const ctx = await setup();
  try {
    const c = await connect({ port: ctx.port });
    const wrongFp = crypto.createHash('sha256').update('mitm').digest('hex');
    const reply = await pair(c, ctx.receiver.currentCode, { fingerprint: wrongFp });
    assert.equal(reply.t, 'error');
    await c.waitClosed();
    assert.equal(ctx.receiver.state, 'waiting');
  } finally {
    await ctx.receiver.stop();
  }
});

test('control messages before pairing are refused and have no effect', async () => {
  const ctx = await setup();
  try {
    const c = await connect({ port: ctx.port });
    await c.waitFor((m) => m.t === 'challenge');
    c.send({ t: 'm', dx: 50, dy: 50 });
    assert.equal(await c.waitClosed(), 4003);
    const c2 = await connect({ port: ctx.port });
    await c2.waitFor((m) => m.t === 'challenge');
    c2.send('not json at all');
    assert.equal(await c2.waitClosed(), 1008);
    assert.equal(ctx.backend.events.length, 0);
  } finally {
    await ctx.receiver.stop();
  }
});

test('only one controller at a time: a second phone gets "busy" even with a fresh valid-looking attempt', async () => {
  const ctx = await setup();
  try {
    const first = await pairedClient(ctx, 'A');
    const second = await connect({ port: ctx.port });
    const reply = await pair(second, 'AAAA-AAAA-AAAA');
    assert.equal(reply.t, 'error');
    assert.equal(reply.code, 'busy');
    await second.waitClosed();
    first.c.send({ t: 'm', dx: 1, dy: 1 });
    await sleep(50);
    assert.equal(ctx.backend.events.length, 1, 'first phone still works');
  } finally {
    await ctx.receiver.stop();
  }
});

test('disconnect revokes the session, releases held buttons, and issues a fresh code', async () => {
  const ctx = await setup();
  try {
    const { c } = await pairedClient(ctx, 'A');
    const used = ctx.codes.at(-1).code;
    c.send({ t: 'b', b: 'l', a: 'd' });
    await sleep(30);
    c.close();
    await c.waitClosed();
    await sleep(30);
    assert.equal(ctx.receiver.state, 'waiting');
    assert.deepEqual(ctx.backend.events.at(-1), { type: 'button', button: 'l', down: false }, 'stuck button released');
    assert.notEqual(ctx.receiver.currentCode, used, 'new code after the session');
    // the old (used) code can no longer pair
    const c2 = await connect({ port: ctx.port });
    const reply = await pair(c2, used);
    assert.equal(reply.t, 'error');
  } finally {
    await ctx.receiver.stop();
  }
});

test('revoke() disconnects immediately and later messages from that socket are ignored', async () => {
  const ctx = await setup();
  try {
    const { c } = await pairedClient(ctx, 'A');
    assert.equal(ctx.receiver.revoke(), true);
    assert.equal(ctx.receiver.state, 'waiting');
    c.send({ t: 'm', dx: 9, dy: 9 });
    c.send({ t: 'txt', s: 'after revoke' });
    assert.equal(await c.waitClosed(), 4004);
    assert.equal(ctx.backend.events.length, 0);
    assert.equal(ctx.receiver.revoke(), false);
    assert.ok(ctx.receiver.currentCode, 'a fresh code is available to pair again');
  } finally {
    await ctx.receiver.stop();
  }
});

test('invalid input is rejected without reaching the backend; repeated violations close the connection', async () => {
  const ctx = await setup({ maxInvalid: 5 });
  try {
    const { c } = await pairedClient(ctx, 'A');
    c.send({ t: 'm', dx: 99999, dy: 0 });
    c.send({ t: 'k', k: 'win' });
    c.send({ t: 'b', b: 'x', a: 'c' });
    c.send({ t: 'txt', s: 'a'.repeat(300) });
    c.send({ t: 'exec', cmd: 'calc.exe' });
    await c.waitClosed();
    assert.equal(ctx.backend.events.length, 0);
    assert.equal(c.messages.filter((m) => m.t === 'error').length, 5);
  } finally {
    await ctx.receiver.stop();
  }
});

test('oversized frames, binary frames and unmasked frames close the connection with the right codes', async () => {
  const ctx = await setup();
  try {
    const big = await connect({ port: ctx.port });
    big.sendFrame(OP.TEXT, Buffer.alloc(9000, 0x61));
    assert.equal(await big.waitClosed(), 1009);
    const bin = await connect({ port: ctx.port });
    bin.sendFrame(OP.BINARY, Buffer.from([1, 2, 3]));
    assert.equal(await bin.waitClosed(), 1003);
    const unm = await connect({ port: ctx.port });
    unm.sendFrame(OP.TEXT, Buffer.from('{"t":"ping"}'), false);
    assert.equal(await unm.waitClosed(), 1002);
    const badUtf = await connect({ port: ctx.port });
    badUtf.sendFrame(OP.TEXT, Buffer.from([0xff, 0xfe, 0xfd]));
    assert.equal(await badUtf.waitClosed(), 1007);
  } finally {
    await ctx.receiver.stop();
  }
});

test('rate limiting drops excess input and disconnects a flooding client', async () => {
  const ctx = await setup({ moveRatePerSec: 10, moveBurst: 20, maxRateDrops: 30 });
  try {
    const { c } = await pairedClient(ctx, 'A');
    for (let i = 0; i < 200; i++) c.send({ t: 'm', dx: 1, dy: 0 });
    assert.equal(await c.waitClosed(), 4009);
    assert.ok(ctx.backend.events.length >= 20 && ctx.backend.events.length < 60, `applied ${ctx.backend.events.length}`);
  } finally {
    await ctx.receiver.stop();
  }
});

test('too many wrong codes lock the phone out, even for the right code, then recover', async () => {
  const ctx = await setup({ pairing: { ipFailThreshold: 3, ipLockBaseMs: 400, globalLockMs: 100, maxFailuresPerCode: 50 } });
  try {
    for (let i = 0; i < 3; i++) {
      const c = await connect({ port: ctx.port });
      assert.equal((await pair(c, 'AAAA-AAAA-AAAA')).code, 'bad_proof');
      await c.waitClosed();
    }
    const locked = await connect({ port: ctx.port });
    const reply = await pair(locked, ctx.receiver.currentCode);
    assert.equal(reply.code, 'locked');
    assert.ok(reply.retry >= 1);
    await locked.waitClosed();
    await sleep(450);
    const { reply: ok } = await pairedClient(ctx, 'A');
    assert.equal(ok.t, 'paired');
  } finally {
    await ctx.receiver.stop();
  }
});

test('pairing code expiry rotates the code and the old one stops working', async () => {
  const ctx = await setup({ codeTtlMs: 1200 });
  try {
    const first = ctx.receiver.currentCode;
    await sleep(2300);
    assert.ok(ctx.codes.some((c) => c.reason === 'expired'));
    assert.notEqual(ctx.receiver.currentCode, first);
    const c = await connect({ port: ctx.port });
    assert.equal((await pair(c, first)).t, 'error');
  } finally {
    await ctx.receiver.stop();
  }
});

test('an unauthenticated connection that never pairs is dropped after the timeout', async () => {
  const ctx = await setup({ pairTimeoutMs: 200 });
  try {
    const c = await connect({ port: ctx.port });
    assert.equal(await c.waitClosed(), 4000);
  } finally {
    await ctx.receiver.stop();
  }
});

test('sessions expire after the configured lifetime and input stops', async () => {
  const ctx = await setup({ sessionMs: 300 });
  try {
    const { c } = await pairedClient(ctx, 'A');
    await sleep(500);
    assert.equal(ctx.receiver.state, 'waiting');
    c.send({ t: 'm', dx: 1, dy: 1 });
    assert.equal(await c.waitClosed(), 4008);
    assert.equal(ctx.backend.events.length, 0);
    assert.ok(c.messages.some((m) => m.code === 'session_expired'));
  } finally {
    await ctx.receiver.stop();
  }
});

test('too many simultaneous unauthenticated connections are refused', async () => {
  const ctx = await setup({ maxPending: 2 });
  try {
    const a = await connect({ port: ctx.port });
    const b = await connect({ port: ctx.port });
    await assert.rejects(connect({ port: ctx.port }));
    a.socket.destroy();
    b.socket.destroy();
  } finally {
    await ctx.receiver.stop();
  }
});

test('connections from non-private addresses are dropped before the TLS handshake', async (t) => {
  // 192.0.2.2 (TEST-NET-1) is this sandbox's own non-private address; skip where it does not exist.
  const os = require('node:os');
  const has = Object.values(os.networkInterfaces()).flat().some((a) => a.address === '192.0.2.2');
  if (!has) return t.skip('no non-private local address available');
  const ctx = await setup({ hosts: ['127.0.0.1', '192.0.2.2'] });
  try {
    const outcome = await new Promise((resolve) => {
      const s = tls.connect({ host: '192.0.2.2', port: ctx.port, rejectUnauthorized: false });
      s.on('secureConnect', () => resolve('handshake-completed'));
      s.on('error', () => resolve('refused'));
      s.on('close', () => resolve('refused'));
    });
    assert.equal(outcome, 'refused');
  } finally {
    await ctx.receiver.stop();
  }
});

test('input text is never written to the logs', async () => {
  const ctx = await setup();
  try {
    const { c } = await pairedClient(ctx, 'A');
    c.send({ t: 'txt', s: 'SECRET-PASSWORD-123' });
    await sleep(50);
    c.close();
    await c.waitClosed();
    const all = JSON.stringify(ctx.logs);
    assert.ok(!all.includes('SECRET-PASSWORD'));
    assert.ok(!all.includes(ctx.codes[0].code), 'pairing codes are not logged either');
  } finally {
    await ctx.receiver.stop();
  }
});

test('stop() closes everything cleanly and releases held buttons', async () => {
  const ctx = await setup();
  const { c } = await pairedClient(ctx, 'A');
  c.send({ t: 'b', b: 'l', a: 'd' });
  await sleep(30);
  await ctx.receiver.stop();
  await c.waitClosed();
  assert.deepEqual(ctx.backend.events.at(-1), { type: 'button', button: 'l', down: false });
  await assert.rejects(connect({ port: ctx.port }));
});

test('backend failure closes the session with an error instead of crashing', async () => {
  const ctx = await setup();
  try {
    ctx.backend.move = () => {
      throw new Error('boom');
    };
    const { c } = await pairedClient(ctx, 'A');
    c.send({ t: 'm', dx: 1, dy: 1 });
    assert.equal(await c.waitClosed(), 4010);
    assert.ok(c.messages.some((m) => m.code === 'backend'));
  } finally {
    await ctx.receiver.stop();
  }
});
