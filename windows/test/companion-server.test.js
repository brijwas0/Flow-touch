'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Receiver } = require('../src/receiver');
const { MockBackend } = require('../src/input/mock-backend');
const { CompanionServer } = require('../src/companion-server');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }).on('error', reject);
  });
}

function post(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST' }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('CompanionServer serves UI and responds to API calls on loopback', async () => {
  const backend = new MockBackend();
  const receiver = new Receiver({ hosts: ['127.0.0.1'], port: 0, backend });
  await receiver.start();

  const companion = new CompanionServer(receiver, { port: 0 });
  const compPort = await companion.start();
  assert.ok(compPort > 0, 'companion server must listen on a port');

  try {
    // 1. GET / serves HTML
    const htmlRes = await get(`http://127.0.0.1:${compPort}/`);
    assert.equal(htmlRes.status, 200);
    assert.ok(htmlRes.body.includes('PhoneTouch Companion'));
    assert.ok(htmlRes.body.includes('btnStartPair'));

    // 2. GET /api/status returns status JSON
    const statusRes = await get(`http://127.0.0.1:${compPort}/api/status`);
    assert.equal(statusRes.status, 200);
    const s = JSON.parse(statusRes.body);
    assert.equal(s.ok, true);
    assert.equal(s.state, 'waiting');

    // 3. POST /api/pair generates QR code and URI
    const pairRes = await post(`http://127.0.0.1:${compPort}/api/pair`);
    assert.equal(pairRes.status, 200);
    const p = JSON.parse(pairRes.body);
    assert.equal(p.ok, true);
    assert.ok(p.uri.startsWith('phonetouch://pair'));
    assert.ok(p.qrSvg.startsWith('<svg'));

    // 4. POST /api/revoke revokes cleanly
    const revokeRes = await post(`http://127.0.0.1:${compPort}/api/revoke`);
    assert.equal(revokeRes.status, 200);
    const r = JSON.parse(revokeRes.body);
    assert.equal(r.ok, true);
  } finally {
    await companion.stop();
    await receiver.stop();
  }
});
