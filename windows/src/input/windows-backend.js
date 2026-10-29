'use strict';

const path = require('node:path');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { KEYS } = require('../protocol');

const BUTTON_CODE = Object.freeze({ l: 'L', r: 'R', m: 'M' });

/**
 * Windows input via the documented user32 SendInput API.
 *
 * Node has no built-in input injection, so a long-lived PowerShell process
 * compiles a tiny C# class (P/Invoke to SendInput) and then reads simple,
 * fixed-format command lines from stdin. The receiver validates everything
 * and only ever formats the numeric/base64 commands below, so nothing the
 * phone sends can reach a shell or be interpreted as code:
 *
 *   M <dx> <dy>      relative mouse move
 *   D <L|R|M>        button down        U <L|R|M>   button up
 *   W <delta>        vertical wheel     H <delta>   horizontal wheel
 *   P <vk>           press + release a virtual key (whitelisted by the receiver)
 *   T <base64>       type text; base64 of the UTF-16LE string
 *   Q                quit
 */
class WindowsBackend extends EventEmitter {
  constructor({ spawn = childProcess.spawn, startTimeoutMs = 30000, scriptPath } = {}) {
    super();
    this.name = 'windows';
    this.spawn = spawn;
    this.startTimeoutMs = startTimeoutMs;
    this.scriptPath = scriptPath || path.join(__dirname, 'input-helper.ps1');
    this.proc = null;
    this.ready = false;
    this.stopping = false;
  }

  _powershellPath() {
    const root = process.env.SystemRoot || process.env.windir;
    return root ? path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
  }

  start() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stderr = '';
      let stdoutBuf = '';
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath];
      let proc;
      try {
        proc = this.spawn(this._powershellPath(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (e) {
        reject(new Error(`Could not start PowerShell: ${e.message}`));
        return;
      }
      this.proc = proc;
      const timer = setTimeout(() => {
        finish(new Error('Timed out starting the Windows input helper.'));
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }, this.startTimeoutMs);

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (d) => {
        stdoutBuf += d;
        let idx;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (line === 'READY') {
            this.ready = true;
            finish();
          }
        }
      });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (d) => {
        if (stderr.length < 4000) stderr += d;
      });
      proc.stdin.on('error', () => {
        /* helper went away; the 'exit' handler reports it */
      });
      proc.on('error', (e) => finish(new Error(`Could not start PowerShell: ${e.message}`)));
      proc.on('exit', (code) => {
        this.ready = false;
        if (!settled) {
          finish(new Error(`The Windows input helper exited (code ${code}). ${stderr.trim()}`));
        } else if (!this.stopping) {
          this.emit('failed', new Error(`The Windows input helper stopped unexpectedly (code ${code}). ${stderr.trim()}`));
        }
      });
    });
  }

  _send(line) {
    if (!this.ready || !this.proc || !this.proc.stdin.writable) throw new Error('input helper is not running');
    this.proc.stdin.write(line + '\n');
  }

  move(dx, dy) {
    this._send(`M ${dx | 0} ${dy | 0}`);
  }

  button(button, down) {
    const code = BUTTON_CODE[button];
    if (!code) throw new Error('bad button');
    this._send(`${down ? 'D' : 'U'} ${code}`);
  }

  wheel(dx, dy) {
    if (dy) this._send(`W ${dy | 0}`);
    if (dx) this._send(`H ${dx | 0}`);
  }

  key(name) {
    if (!Object.prototype.hasOwnProperty.call(KEYS, name)) throw new Error('unsupported key');
    this._send(`P ${KEYS[name]}`);
  }

  gesture(action) {
    if (!['start', 'desktop', 'notifications', 'app_next', 'app_prev', 'desktop_next', 'desktop_prev', 'task_view'].includes(action)) {
      throw new Error('unsupported gesture');
    }
    this._send(`G ${action}`);
  }

  zoom(dy) {
    if (dy) this._send(`Z ${dy | 0}`);
  }

  text(s) {
    if (!s) return;
    this._send(`T ${Buffer.from(s, 'utf16le').toString('base64')}`);
  }

  async stop() {
    this.stopping = true;
    const proc = this.proc;
    if (!proc) return;
    try {
      if (proc.stdin.writable) proc.stdin.write('Q\n');
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        resolve();
      }, 1000);
      t.unref();
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.proc = null;
  }
}

module.exports = { WindowsBackend };
