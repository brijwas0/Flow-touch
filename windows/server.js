#!/usr/bin/env node
'use strict';

/**
 * PhoneTouch receiver - command line entry point.
 * Run:  node server.js        (see --help)
 */

const readline = require('node:readline');
const { parseArgs, ConfigError, HELP } = require('./src/config');
const { Receiver, VERSION } = require('./src/receiver');
const { MockBackend } = require('./src/input/mock-backend');
const { WindowsBackend } = require('./src/input/windows-backend');
const { CompanionServer } = require('./src/companion-server');

const time = () => new Date().toLocaleTimeString();
const out = (s = '') => process.stdout.write(s + '\n');

function banner(receiver, cfg, companion) {
  const code = receiver.currentCode;
  out('');
  out('==============================================================');
  out(`  PhoneTouch receiver ${VERSION}  (input: ${receiver.backend.name})`);
  out('==============================================================');
  out('  On your phone, enter:');
  for (const host of cfg.hosts) out(`      Address : ${host}`);
  out(`      Port    : ${receiver.port}`);
  if (code) out(`      Code    : ${formatCode(code)}   (valid ${Math.round(cfg.codeTtlMs / 60000)} min, one use)`);
  if (companion && companion.port) out(`      UI      : http://127.0.0.1:${companion.port}`);
  out('');
  out('  Keep this window open while you use the touchpad.');
  out('  Commands: status | new | revoke | quit      (Ctrl+C also stops it)');
  out('==============================================================');
  if (cfg.autoHosts && cfg.candidates && cfg.candidates.some((c) => c.virtual)) {
    out('  Note: virtual adapters were skipped. Use --host <ip> to choose another.');
  }
  out('');
}

function formatCode(c) {
  return c.match(/.{1,4}/g).join('-');
}

async function main() {
  let cfg;
  try {
    cfg = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`Error: ${e.message}\n\n${HELP}`);
      process.exit(2);
    }
    throw e;
  }
  if (cfg.help) {
    out(HELP);
    return;
  }
  if (cfg.version) {
    out(VERSION);
    return;
  }
  if (cfg.hosts.length === 0) {
    process.stderr.write(
      'Error: no private network address found. Connect this PC to your Wi-Fi/LAN first,\nor pass --host <your private IPv4 address>.\n'
    );
    process.exit(1);
  }

  const backend = cfg.backend === 'mock' ? new MockBackend() : new WindowsBackend();
  // Loopback is always added so the local health check works; it is not reachable from other devices.
  const hosts = [...new Set([...cfg.hosts, "127.0.0.1"])];
  const receiver = new Receiver({ hosts, port: cfg.port, backend, codeTtlMs: cfg.codeTtlMs, sessionMs: cfg.sessionMs });

  let bannerShown = false;
  receiver.on('log', ({ level, msg }) => out(`[${time()}] ${level === 'info' ? '' : level.toUpperCase() + ': '}${msg}`));
  receiver.on('code', ({ formatted, expiresAt, reason }) => {
    if (!bannerShown) return;
    const why = { expired: 'previous code expired', 'session-ended': 'phone disconnected', 'too-many-failures': 'too many wrong attempts', manual: 'requested' }[reason] || '';
    out(`[${time()}] New pairing code: ${formatted}  (valid until ${new Date(expiresAt).toLocaleTimeString()}${why ? '; ' + why : ''})`);
  });
  receiver.on('fatal', (err) => {
    out(`FATAL: ${err.message}`);
    shutdown(1);
  });

  let shuttingDown = false;
  async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    out(`\n[${time()}] Stopping...`);
    const force = setTimeout(() => process.exit(code), 3000);
    force.unref();
    try {
      if (companion) await companion.stop().catch(() => {});
      await receiver.stop();
    } catch (e) {
      process.stderr.write(`Error while stopping: ${e.message}\n`);
    }
    process.exit(code);
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGBREAK', () => shutdown(0));

  let companion = null;
  try {
    if (cfg.backend === 'windows') out('Starting the Windows input helper (can take a few seconds)...');
    await receiver.start();
    companion = new CompanionServer(receiver, { port: cfg.companionPort || 47821, hosts: cfg.hosts });
    await companion.start();
    if (cfg.gui && process.platform === 'win32' && process.env.NODE_ENV !== 'test') {
      companion.launchWindow();
    }
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      process.stderr.write(
        `Error: port ${cfg.port} is already in use${e.host ? ` on ${e.host}` : ''}. Is another receiver running?\n` +
          `Close it, or start this one on another port:  node server.js --port ${cfg.port + 1}\n`
      );
    } else if (e.code === 'EADDRNOTAVAIL') {
      process.stderr.write(`Error: this PC has no network address ${e.host}. Check --host.\n`);
    } else {
      process.stderr.write(`Error: ${e.message}\n`);
    }
    if (companion) await companion.stop().catch(() => {});
    await receiver.stop().catch(() => {});
    process.exit(1);
  }

  bannerShown = true;
  banner(receiver, cfg, companion);

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      switch (line.trim().toLowerCase()) {
        case 'status': {
          const s = receiver.status();
          out(`State: ${s.state === 'controlled' ? 'a phone is connected' : 'waiting for a phone'} | uptime ${s.uptimeSeconds}s`);
          if (s.state === 'waiting' && receiver.currentCode) out(`Current code: ${formatCode(receiver.currentCode)}`);
          break;
        }
        case 'new':
          if (!receiver.newCode()) out('A phone is connected. Type "revoke" first to disconnect it.');
          break;
        case 'revoke':
          out(receiver.revoke() ? 'Disconnected the phone.' : 'No phone is connected.');
          break;
        case 'quit':
        case 'exit':
          shutdown(0);
          break;
        case '':
          break;
        default:
          out('Commands: status | new | revoke | quit');
      }
    });
    rl.on('close', () => {});
  }
}

main().catch((e) => {
  process.stderr.write(`Unexpected error: ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
