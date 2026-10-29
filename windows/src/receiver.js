'use strict';

const https = require('node:https');
const crypto = require('node:crypto');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const { acceptUpgrade } = require('./ws-lite');
const { generateSelfSigned } = require('./cert');
const { PairingManager } = require('./pairing');
const { TokenBucket } = require('./ratelimit');
const { isAllowedRemote, normalizeRemote } = require('./net-utils');
const { LIMITS, ProtocolError, sanitizeName, parseJson, validateControl, segmentText } = require('./protocol');

const VERSION = '1.0.0';
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The receiver: HTTPS (health check) + WebSocket control channel, pairing,
 * session management and dispatch of validated input events to a backend.
 *
 * Events: 'log' ({level, msg}), 'code' ({code, formatted, expiresAt, reason}),
 *         'session-start' ({ip, name}), 'session-end' ({ip, name, reason, durationMs}),
 *         'fatal' (Error)
 */
class Receiver extends EventEmitter {
  constructor(options) {
    super();
    this.opts = {
      hosts: ['127.0.0.1'],
      port: 47820,
      codeTtlMs: 5 * 60 * 1000,
      sessionMs: 4 * 60 * 60 * 1000,
      pairTimeoutMs: 10 * 1000,
      heartbeatMs: 10 * 1000,
      maxPending: 4,
      moveRatePerSec: 400,
      moveBurst: 800,
      textCharsPerSec: 1000,
      textBurst: 2000,
      maxInvalid: 10,
      maxRateDrops: 300,
      hostname: os.hostname(),
      pairing: {},
      ...options,
    };
    if (!this.opts.backend) throw new Error('A backend is required');
    this.backend = this.opts.backend;
    this.servers = [];
    this.pending = new Set();
    this.session = null;
    this.startedAt = 0;
    this.fingerprint = null;
    this.port = null;
    this.heartbeat = null;
    this.stopped = false;
    this.pairing = new PairingManager({ codeTtlMs: this.opts.codeTtlMs, ...this.opts.pairing });
    this.pairing.on('code', (info) => this.emit('code', info));
    this.pairing.on('lockout', (info) => this._log('warn', `Too many wrong pairing attempts; pairing paused for ${Math.round(info.ms / 1000)} s and a new code was issued.`));
  }

  _log(level, msg) {
    this.emit('log', { level, msg });
  }

  get state() {
    return this.session ? 'controlled' : 'waiting';
  }

  get currentCode() {
    return this.pairing.hasValidCode() ? this.pairing.code : null;
  }

  status() {
    return {
      ok: true,
      app: 'PhoneTouch',
      version: VERSION,
      state: this.state,
      backend: this.backend.name,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  async start() {
    await this.backend.start();
    if (typeof this.backend.on === 'function') {
      this.backend.on('failed', (err) => {
        this._log('error', err.message);
        this.emit('fatal', err);
      });
    }
    const cert = generateSelfSigned({ ips: this.opts.hosts.filter((h) => /^\d+\.\d+\.\d+\.\d+$/.test(h)) });
    this.fingerprint = cert.fingerprint;
    this.startedAt = Date.now();

    let port = this.opts.port;
    for (const host of this.opts.hosts) {
      const server = https.createServer(
        { key: cert.keyPem, cert: cert.certPem, minVersion: 'TLSv1.2', handshakeTimeout: 10000 },
        (req, res) => this._onRequest(req, res)
      );
      server.headersTimeout = 10000;
      server.requestTimeout = 10000;
      server.keepAliveTimeout = 2000;
      server.maxConnections = 32;
      // Drop devices outside the private LAN before any TLS handshake happens.
      server.prependListener('connection', (sock) => {
        if (!isAllowedRemote(normalizeRemote(sock.remoteAddress))) sock.destroy();
      });
      server.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));
      server.on('tlsClientError', () => {});
      server.on('clientError', (err, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        else socket.destroy();
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      }).catch((err) => {
        err.host = host;
        throw err;
      });
      port = server.address().port; // lets port 0 (tests) share one port across hosts
      server.on('error', (err) => this._log('error', `Server error: ${err.message}`));
      this.servers.push(server);
    }
    this.port = port;

    this.pairing.start();
    this.pairing.issue('start');
    this.heartbeat = setInterval(() => this._heartbeat(), this.opts.heartbeatMs);
    this.heartbeat.unref();
  }

  // ---------------------------------------------------------------- HTTP

  _onRequest(req, res) {
    const remote = normalizeRemote(req.socket.remoteAddress);
    if (!isAllowedRemote(remote)) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url, 'https://receiver.invalid');
    if (url.pathname === '/health' && req.method === 'GET') {
      const body = JSON.stringify(this.status());
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        Connection: 'close',
      });
      res.end(body);
      return;
    }
    res.writeHead(url.pathname === '/health' ? 405 : 404, { 'Content-Length': 0, Connection: 'close' });
    res.end();
  }

  // ----------------------------------------------------------- WebSocket

  _onUpgrade(req, socket, head) {
    const remote = normalizeRemote(socket.remoteAddress);
    const path = (() => {
      try {
        return new URL(req.url, 'https://receiver.invalid').pathname;
      } catch {
        return '';
      }
    })();
    if (this.stopped || !isAllowedRemote(remote) || path !== '/ws' || this.pending.size >= this.opts.maxPending) {
      socket.destroy();
      return;
    }
    const ws = acceptUpgrade(req, socket, head, { maxPayload: LIMITS.maxMessageBytes });
    if (!ws) return;
    this._onConnection(ws, remote);
  }

  _onConnection(ws, ip) {
    const st = {
      ws,
      ip,
      authed: false,
      alive: true,
      sn: crypto.randomBytes(16).toString('hex'),
      name: 'Phone',
      invalid: 0,
      drops: 0,
      dropWindowStart: Date.now(),
      held: new Set(),
      moveBucket: new TokenBucket({ ratePerSec: this.opts.moveRatePerSec, burst: this.opts.moveBurst }),
      textBucket: new TokenBucket({ ratePerSec: this.opts.textCharsPerSec, burst: this.opts.textBurst }),
      pairTimer: null,
      sessionTimer: null,
      startedAt: 0,
      ended: false,
    };
    this.pending.add(st);
    st.pairTimer = setTimeout(() => ws.close(4000, 'pair_timeout'), this.opts.pairTimeoutMs);
    st.pairTimer.unref();

    ws.on('message', (text) => this._onMessage(st, text));
    ws.on('pong', () => {
      st.alive = true;
    });
    ws.on('error', () => {});
    ws.on('close', () => this._onClose(st));

    ws.sendText(JSON.stringify({ t: 'challenge', v: 1, sn: st.sn }));
  }

  _sendError(st, code, msg, retryMs) {
    const m = { t: 'error', code, msg };
    if (retryMs) m.retry = Math.ceil(retryMs / 1000);
    st.ws.sendText(JSON.stringify(m));
  }

  _onMessage(st, text) {
    if (st.ended) return;
    let msg;
    try {
      msg = parseJson(text);
    } catch (e) {
      if (!st.authed) {
        st.ws.close(1008, 'protocol');
        return;
      }
      this._invalid(st, e);
      return;
    }
    if (!st.authed) {
      if (msg.t === 'pair') this._handlePair(st, msg);
      else st.ws.close(4003, 'unauthenticated');
      return;
    }
    if (this.session?.st !== st) return; // revoked or replaced: ignore everything
    this._handleControl(st, msg);
  }

  _invalid(st, err) {
    st.invalid += 1;
    this._sendError(st, err.code || 'invalid', err.message);
    if (st.invalid >= this.opts.maxInvalid) st.ws.close(1008, 'too_many_invalid');
  }

  _handlePair(st, msg) {
    if (typeof msg.cn !== 'string' || !HEX32.test(msg.cn) || typeof msg.proof !== 'string' || !HEX64.test(msg.proof)) {
      st.ws.close(1008, 'protocol');
      return;
    }
    if (this.session) {
      this._sendError(st, 'busy', 'Another phone is already connected.');
      st.ws.close(4002, 'busy');
      return;
    }
    const res = this.pairing.attempt({
      ip: st.ip,
      serverNonce: st.sn,
      clientNonce: msg.cn,
      proof: msg.proof,
      fingerprint: this.fingerprint,
    });
    if (!res.ok) {
      const text = {
        locked: 'Too many attempts. Wait a moment and try again.',
        expired: 'The pairing code has expired. Use the new code shown on the PC.',
        bad_proof: 'Pairing failed: wrong code, or the connection was intercepted.',
      }[res.reason];
      this._log('warn', `Pairing rejected from ${st.ip} (${res.reason}).`);
      this._sendError(st, res.reason, text, res.retryAfterMs);
      st.ws.close(4001, res.reason);
      return;
    }

    st.authed = true;
    st.name = sanitizeName(msg.name);
    st.startedAt = Date.now();
    clearTimeout(st.pairTimer);
    this.pending.delete(st);
    this.session = { st };
    st.sessionTimer = setTimeout(() => this._expireSession(st), this.opts.sessionMs);
    st.sessionTimer.unref();
    st.ws.sendText(
      JSON.stringify({
        t: 'paired',
        v: 1,
        proof: res.serverProof,
        host: sanitizeName(this.opts.hostname),
        ttl: Math.floor(this.opts.sessionMs / 1000),
      })
    );
    this._log('info', `Phone "${st.name}" connected from ${st.ip}.`);
    this.emit('session-start', { ip: st.ip, name: st.name });
  }

  _handleControl(st, raw) {
    let m;
    try {
      m = validateControl(raw);
    } catch (e) {
      if (e instanceof ProtocolError) this._invalid(st, e);
      else st.ws.close(1011, 'internal');
      return;
    }
    if (m.t === 'ping') {
      st.ws.sendText('{"t":"pong"}');
      return;
    }
    if (m.t === 'bye') {
      st.ws.close(1000, 'bye');
      return;
    }

    const cost = m.t === 'txt' ? m.s.length : 1;
    const bucket = m.t === 'txt' ? st.textBucket : st.moveBucket;
    if (!bucket.take(cost)) {
      this._countDrop(st);
      return;
    }

    try {
      switch (m.t) {
        case 'm':
          if (m.dx || m.dy) this.backend.move(m.dx, m.dy);
          break;
        case 'b':
          this._button(st, m.b, m.a);
          break;
        case 's':
          if (m.dx || m.dy) this.backend.wheel(m.dx, m.dy);
          break;
        case 'z':
          if (m.dy) this.backend.zoom(m.dy);
          break;
        case 'g':
          this.backend.gesture(m.a);
          break;
        case 'k':
          this.backend.key(m.k);
          break;
        case 'txt':
          for (const seg of segmentText(m.s)) {
            if (seg.text) this.backend.text(seg.text);
            else this.backend.key(seg.key);
          }
          break;
        default:
          break;
      }
    } catch (e) {
      this._log('error', `Input backend error: ${e.message}`);
      this._sendError(st, 'backend', 'The PC could not apply that input.');
      st.ws.close(4010, 'backend');
    }
  }

  _button(st, b, action) {
    if (action === 'd') {
      st.held.add(b);
      this.backend.button(b, true);
    } else if (action === 'u') {
      st.held.delete(b);
      this.backend.button(b, false);
    } else {
      this.backend.button(b, true);
      this.backend.button(b, false);
    }
  }

  _countDrop(st) {
    const now = Date.now();
    if (now - st.dropWindowStart > 10000) {
      st.dropWindowStart = now;
      st.drops = 0;
    }
    st.drops += 1;
    if (st.drops > this.opts.maxRateDrops) st.ws.close(4009, 'rate_limit');
  }

  _expireSession(st) {
    if (this.session?.st !== st) return;
    this._sendError(st, 'session_expired', 'The session expired. Pair again to continue.');
    st.ws.close(4008, 'session_expired');
    this._endSession(st, 'expired');
  }

  _onClose(st) {
    clearTimeout(st.pairTimer);
    this.pending.delete(st);
    if (this.session?.st === st) this._endSession(st, 'disconnected');
    else this._releaseHeld(st);
    st.ended = true;
  }

  _releaseHeld(st) {
    for (const b of st.held) {
      try {
        this.backend.button(b, false);
      } catch {
        /* backend gone */
      }
    }
    st.held.clear();
  }

  _endSession(st, reason) {
    if (this.session?.st !== st) return;
    clearTimeout(st.sessionTimer);
    this._releaseHeld(st);
    this.session = null;
    st.ended = true;
    this._log('info', `Phone "${st.name}" ${reason === 'revoked' ? 'was disconnected' : reason === 'expired' ? 'session expired' : 'disconnected'}.`);
    this.emit('session-end', { ip: st.ip, name: st.name, reason, durationMs: Date.now() - st.startedAt });
    if (!this.stopped) this.pairing.issue('session-ended');
  }

  /** Disconnect the active controller immediately; its pairing is void. */
  revoke() {
    const st = this.session?.st;
    if (!st) return false;
    this._endSession(st, 'revoked');
    st.ws.close(4004, 'revoked');
    return true;
  }

  /** Issue a new pairing code (only possible while no controller is connected). */
  newCode() {
    if (this.session) return null;
    return this.pairing.issue('manual');
  }

  _heartbeat() {
    const all = [...this.pending, ...(this.session ? [this.session.st] : [])];
    for (const st of all) {
      if (!st.alive) {
        st.ws.terminate();
        continue;
      }
      st.alive = false;
      st.ws.ping();
    }
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.heartbeat);
    this.pairing.stop();
    const all = [...this.pending, ...(this.session ? [this.session.st] : [])];
    for (const st of all) {
      clearTimeout(st.pairTimer);
      clearTimeout(st.sessionTimer);
      this._releaseHeld(st);
      st.ws.close(1001, 'shutdown');
    }
    this.session = null;
    await new Promise((r) => setTimeout(r, 50));
    for (const st of all) st.ws.terminate();
    await Promise.all(
      this.servers.map(
        (s) =>
          new Promise((resolve) => {
            s.close(() => resolve());
            if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
          })
      )
    );
    await this.backend.stop();
  }
}

module.exports = { Receiver, VERSION };
