'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, ConfigError } = require('../src/config');
const net = require('../src/net-utils');

const ifaces = {
  'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.23', internal: false }],
  'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
  Ethernet: [{ family: 'IPv4', address: '8.8.4.4', internal: false }],
  Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  v6: [{ family: 'IPv6', address: 'fe80::1', internal: false }],
};
const win = { platform: 'win32', env: {}, interfaces: ifaces };

test('defaults on Windows: windows backend, default port, real private adapters only', () => {
  const c = parseArgs([], win);
  assert.equal(c.backend, 'windows');
  assert.equal(c.port, 47820);
  assert.deepEqual(c.hosts, ['192.168.1.23']);
  assert.equal(c.candidates.length, 2);
});

test('options are parsed and validated', () => {
  const c = parseArgs(['--port', '50000', '--host', '10.0.0.4', '--code-minutes', '2', '--session-hours', '1'], win);
  assert.equal(c.port, 50000);
  assert.deepEqual(c.hosts, ['10.0.0.4']);
  assert.equal(c.codeTtlMs, 120000);
  assert.equal(c.sessionMs, 3600000);
  for (const args of [['--port', '80'], ['--port', 'abc'], ['--host', '8.8.8.8'], ['--host', '0.0.0.0'], ['--host', '127.0.0.1'], ['--bogus'], ['--port']]) {
    assert.throws(() => parseArgs(args, win), ConfigError, args.join(' '));
  }
});

test('non-Windows needs the mock backend; loopback host allowed only with mock', () => {
  assert.throws(() => parseArgs([], { platform: 'linux', env: {}, interfaces: ifaces }), ConfigError);
  assert.throws(() => parseArgs(['--backend', 'windows'], { platform: 'linux', env: {}, interfaces: ifaces }), ConfigError);
  const c = parseArgs(['--backend', 'mock', '--host', '127.0.0.1'], { platform: 'linux', env: {}, interfaces: ifaces });
  assert.deepEqual(c.hosts, ['127.0.0.1']);
});

test('private / allowed remote address classification', () => {
  for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1']) assert.ok(net.isPrivateIPv4(ip), ip);
  for (const ip of ['172.15.0.1', '172.32.0.1', '8.8.8.8', '192.169.0.1', '100.64.0.1', '192.0.2.2', 'abc', '']) assert.ok(!net.isPrivateIPv4(ip), ip);
  for (const a of ['192.168.1.5', '::ffff:10.0.0.9', '127.0.0.1', '169.254.3.3']) assert.ok(net.isAllowedRemote(a), a);
  for (const a of ['8.8.8.8', '::ffff:1.2.3.4', '2001:db8::1', '::1', undefined]) assert.ok(!net.isAllowedRemote(a), String(a));
});
