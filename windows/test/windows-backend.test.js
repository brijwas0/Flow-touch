'use strict';
/**
 * Tests the command lines the Windows backend sends to the PowerShell helper, using a fake child process.
 * (The real SendInput call itself can only be exercised on Windows - see docs/TESTING.md.)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { WindowsBackend } = require('../src/input/windows-backend');

function fakeSpawn({ readyAfterMs = 5, exitBeforeReady = false } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.killed = false;
    proc.kill = () => {
      proc.killed = true;
      proc.emit('exit', null);
    };
    proc.lines = [];
    let buf = '';
    proc.stdin.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        proc.lines.push(line);
        if (line === 'Q') setImmediate(() => proc.emit('exit', 0));
      }
    });
    calls.push({ cmd, args, opts, proc });
    setTimeout(() => {
      if (exitBeforeReady) {
        proc.stderr.write('Add-Type : compile error');
        proc.emit('exit', 1);
      } else proc.stdout.write('READY\r\n');
    }, readyAfterMs);
    return proc;
  };
  return { spawn, calls };
}

test('starts PowerShell with a fixed argument list and waits for READY', async () => {
  const { spawn, calls } = fakeSpawn();
  const b = new WindowsBackend({ spawn, scriptPath: 'C:\\x\\input-helper.ps1' });
  await b.start();
  assert.match(calls[0].cmd, /powershell\.exe$/i);
  assert.deepEqual(calls[0].args, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\x\\input-helper.ps1']);
  assert.equal(calls[0].opts.windowsHide, true);
  await b.stop();
});

test('formats move, button, wheel, key and text commands', async () => {
  const { spawn, calls } = fakeSpawn();
  const b = new WindowsBackend({ spawn });
  await b.start();
  b.move(10, -3);
  b.button('l', true);
  b.button('l', false);
  b.button('r', true);
  b.wheel(0, -120);
  b.wheel(240, 0);
  b.wheel(0, 0);
  b.key('enter');
  b.key('escape');
  b.gesture('start');
  b.gesture('desktop');
  b.zoom(120);
  b.text('héllo 😀');
  await new Promise((r) => setImmediate(r));
  const lines = calls[0].proc.lines;
  assert.deepEqual(lines.slice(0, 11), ['M 10 -3', 'D L', 'U L', 'D R', 'W -120', 'H 240', 'P 13', 'P 27', 'G start', 'G desktop', 'Z 120']);
  assert.match(lines[11], /^T [A-Za-z0-9+/=]+$/);
  assert.equal(Buffer.from(lines[11].slice(2), 'base64').toString('utf16le'), 'héllo 😀');
  await b.stop();
});

test('refuses unsupported keys and buttons, and never writes free-form text to the shell', async () => {
  const { spawn, calls } = fakeSpawn();
  const b = new WindowsBackend({ spawn });
  await b.start();
  assert.throws(() => b.key('f4'));
  assert.throws(() => b.key('constructor'));
  assert.throws(() => b.button('x', true));
  b.text('"; Start-Process calc; "\n');
  await new Promise((r) => setImmediate(r));
  const lines = calls[0].proc.lines;
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^T [A-Za-z0-9+/=]+$/, 'text is only ever sent base64-encoded');
  await b.stop();
});

test('start fails with the helper stderr when PowerShell exits early', async () => {
  const { spawn } = fakeSpawn({ exitBeforeReady: true });
  const b = new WindowsBackend({ spawn });
  await assert.rejects(b.start(), /compile error/);
});

test('start times out if READY never arrives', async () => {
  const spawn = () => {
    const p = new EventEmitter();
    p.stdin = new PassThrough();
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    p.kill = () => p.emit('exit', null);
    return p;
  };
  const b = new WindowsBackend({ spawn, startTimeoutMs: 50 });
  await assert.rejects(b.start(), /Timed out/);
});

test('reports an unexpected helper exit after start', async () => {
  const { spawn, calls } = fakeSpawn();
  const b = new WindowsBackend({ spawn });
  await b.start();
  const failed = new Promise((r) => b.once('failed', r));
  calls[0].proc.emit('exit', 7);
  const err = await failed;
  assert.match(err.message, /code 7/);
  assert.throws(() => b.move(1, 1));
});

test('the PowerShell helper script exists, whitelists the same keys, and has the expected protocol commands', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'input', 'input-helper.ps1'), 'utf8');
  const { KEYS } = require('../src/protocol');
  const allowed = [...src.matchAll(/AllowedKeys[\s\S]*?\{([\s\S]*?)\}\);/g)][0][1];
  const helperKeys = [...allowed.matchAll(/0x([0-9A-Fa-f]{2})/g)].map((m) => parseInt(m[1], 16)).sort((a, b) => a - b);
  assert.deepEqual(helperKeys, Object.values(KEYS).sort((a, b) => a - b));
  for (const cmd of ['case "M"', 'case "D"', 'case "U"', 'case "W"', 'case "H"', 'case "P"', 'case "T"']) assert.ok(src.includes(cmd), cmd);
  assert.ok(src.includes('SendInput'));
  assert.ok(!/Invoke-Expression|\biex\b|Start-Process|cmd\.exe/i.test(src.replace(/^#.*$/gm, '')), 'no command execution in the helper');
  assert.ok(src.includes("'@") && src.includes("@'"), 'here-string delimiters present');
});
