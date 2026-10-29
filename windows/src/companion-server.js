'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const { generateQrSvg } = require('./qr');

const UI_HTML_PATH = path.join(__dirname, 'companion-ui.html');

/**
 * Lightweight Companion HTTP server for the Windows desktop UI.
 * Binds strictly to 127.0.0.1 (loopback) so it is secure and requires no self-signed cert.
 */
class CompanionServer {
  constructor(receiver, { port = 47821, hosts = ['127.0.0.1'] } = {}) {
    this.receiver = receiver;
    this.requestedPort = port;
    this.lanHosts = hosts.filter((h) => h !== '127.0.0.1');
    this.server = null;
    this.port = null;
    this.sseClients = new Set();
    this._attachReceiver();
  }

  _attachReceiver() {
    this.receiver.on('session-start', (session) => {
      this._broadcast({ type: 'session-start', session });
    });
    this.receiver.on('session-end', (info) => {
      this._broadcast({ type: 'session-end', ...info });
    });
    this.receiver.on('code', (codeInfo) => {
      this._broadcast({ type: 'code', ...codeInfo });
    });
  }

  _broadcast(data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(msg);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._handleRequest(req, res));
      server.listen(this.requestedPort, '127.0.0.1', () => {
        this.port = server.address().port;
        this.server = server;
        resolve(this.port);
      });
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          // Retry on ephemeral port
          server.listen(0, '127.0.0.1', () => {
            this.port = server.address().port;
            this.server = server;
            resolve(this.port);
          });
        } else {
          reject(err);
        }
      });
    });
  }

  stop() {
    for (const res of this.sseClients) {
      try { res.end(); } catch {}
    }
    this.sseClients.clear();
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  _handleRequest(req, res) {
    // Only accept loopback requests
    const remote = req.socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/') {
      fs.readFile(UI_HTML_PATH, 'utf8', (err, html) => {
        if (err) {
          res.writeHead(500);
          res.end('Failed to load UI');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(html);
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const code = this.receiver.currentCode;
      const formatted = code ? code.match(/.{1,4}/g).join('-') : null;
      const session = this.receiver.session
        ? {
            ip: this.receiver.session.remote,
            name: this.receiver.session.name,
            startedAt: this.receiver.session.startedAt,
          }
        : null;

      const body = JSON.stringify({
        ok: true,
        state: this.receiver.state,
        receiverPort: this.receiver.port,
        hosts: this.lanHosts.length > 0 ? this.lanHosts : ['127.0.0.1'],
        hostname: os.hostname(),
        code,
        formatted,
        expiresAt: this.receiver.pairing.codeExpiresAt,
        session,
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/pair') {
      let code = this.receiver.currentCode;
      if (!code) {
        this.receiver.newCode();
        code = this.receiver.currentCode;
      }
      const formatted = code ? code.match(/.{1,4}/g).join('-') : '';
      const host = this.lanHosts[0] || '127.0.0.1';
      const port = this.receiver.port;
      const hostname = os.hostname();
      const uri = `phonetouch://pair?h=${encodeURIComponent(host)}&p=${port}&c=${code}&n=${encodeURIComponent(hostname)}`;
      const qrSvg = generateQrSvg(uri, { sizePx: 220, darkColor: '#000000', lightColor: '#FFFFFF' });

      const body = JSON.stringify({
        ok: true,
        code,
        formatted,
        host,
        port,
        hostname,
        uri,
        qrSvg,
        expiresAt: this.receiver.pairing.codeExpiresAt,
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/revoke') {
      const disconnected = this.receiver.revoke();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, disconnected }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      this.sseClients.add(res);
      req.on('close', () => this.sseClients.delete(res));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }

  launchWindow() {
    if (!this.port) return;
    const url = `http://127.0.0.1:${this.port}`;
    const edgePaths = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];

    let launched = false;
    for (const p of edgePaths) {
      if (fs.existsSync(p)) {
        try {
          const tempProfile = path.join(os.tmpdir(), 'phonetouch-edge-profile');
          childProcess.spawn(
            p,
            [`--app=${url}`, `--window-size=480,720`, `--user-data-dir=${tempProfile}`],
            { detached: true, stdio: 'ignore' }
          ).unref();
          launched = true;
          break;
        } catch {}
      }
    }

    if (!launched) {
      // Fallback: open default browser on Windows
      try {
        childProcess.spawn('cmd.exe', ['/c', 'start', url], { detached: true, stdio: 'ignore' }).unref();
      } catch {}
    }
  }
}

module.exports = { CompanionServer };
