'use strict';
/**
 * Interoperability check: talk to the receiver with Node's built-in WebSocket client
 * (undici), an independent implementation of RFC 6455, to prove our hand-written
 * server framing/handshake is standard-compliant. TLS verification is disabled for the
 * child process only (the receiver's certificate is ephemeral and self-signed).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { Receiver } = require('../src/receiver');
const { MockBackend } = require('../src/input/mock-backend');

const CLIENT = `
const crypto = require('node:crypto');
const { computeProof } = require(process.env.PAIRING_MODULE);
const ws = new WebSocket('wss://127.0.0.1:' + process.env.PT_PORT + '/ws');
const out = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  out.push(m.t);
  if (m.t === 'challenge') {
    const cn = crypto.randomBytes(16).toString('hex');
    ws.send(JSON.stringify({ t: 'pair', cn, proof: computeProof('client', process.env.PT_CODE, m.sn, cn, process.env.PT_FP), name: 'undici' }));
  } else if (m.t === 'paired') {
    ws.send(JSON.stringify({ t: 'm', dx: 3, dy: 4 }));
    ws.send(JSON.stringify({ t: 'txt', s: 'unicode ✓ 😀 ' + 'x'.repeat(200) }));
    ws.send(JSON.stringify({ t: 'ping' }));
  } else if (m.t === 'pong') {
    ws.close(1000, 'done');
  } else if (m.t === 'error') {
    console.log(JSON.stringify({ out, error: m }));
    process.exit(0);
  }
};
ws.onclose = (ev) => { console.log(JSON.stringify({ out, code: ev.code })); process.exit(0); };
ws.onerror = () => { console.log(JSON.stringify({ out, wserror: true })); process.exit(0); };
setTimeout(() => { console.log(JSON.stringify({ out, timeout: true })); process.exit(0); }, 8000);
`;

test('Node built-in WebSocket client (undici) can pair and send input', async (t) => {
  if (typeof WebSocket !== 'function') return t.skip('no global WebSocket in this Node version');
  const backend = new MockBackend();
  const receiver = new Receiver({ hosts: ['127.0.0.1'], port: 0, backend });
  await receiver.start();
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', CLIENT], {
        env: {
          ...process.env,
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
          NODE_NO_WARNINGS: '1',
          PT_PORT: String(receiver.port),
          PT_CODE: receiver.currentCode,
          PT_FP: receiver.fingerprint,
          PAIRING_MODULE: require.resolve('../src/pairing'),
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('exit', () => {
        try {
          resolve(JSON.parse(stdout.trim().split('\n').pop()));
        } catch {
          reject(new Error(`client output: ${stdout} ${stderr}`));
        }
      });
    });
    assert.deepEqual(result.out.slice(0, 3), ['challenge', 'paired', 'pong'], JSON.stringify(result));
    assert.equal(result.code, 1000);
    assert.deepEqual(backend.events[0], { type: 'move', dx: 3, dy: 4 });
    assert.equal(backend.events[1].type, 'text');
    assert.ok(backend.events[1].text.startsWith('unicode ✓ 😀 x'));
  } finally {
    await receiver.stop();
  }
});
