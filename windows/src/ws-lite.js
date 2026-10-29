'use strict';
/**
 * Minimal, dependency-free RFC 6455 WebSocket implementation (server side,
 * plus the pieces the tests need to act as a client).
 *
 * Deliberately small: text frames only, no extensions (no compression),
 * no sub-protocols, strict validation, hard payload limits.
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = Object.freeze({ CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa });
const VALID_OPCODES = new Set([OP.CONT, OP.TEXT, OP.BINARY, OP.CLOSE, OP.PING, OP.PONG]);

class WsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WsError';
    this.closeCode = code;
  }
}

function computeAccept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** Encode one unfragmented frame. `mask` must be true for client->server frames. */
function encodeFrame(opcode, payload, mask) {
  const len = payload.length;
  const extLen = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const header = 2 + extLen + (mask ? 4 : 0);
  const buf = Buffer.allocUnsafe(header + len);
  buf[0] = 0x80 | opcode;
  let off = 2;
  if (len < 126) {
    buf[1] = len;
  } else if (len < 65536) {
    buf[1] = 126;
    buf.writeUInt16BE(len, 2);
    off = 4;
  } else {
    buf[1] = 127;
    buf.writeBigUInt64BE(BigInt(len), 2);
    off = 10;
  }
  if (mask) {
    buf[1] |= 0x80;
    const key = crypto.randomBytes(4);
    key.copy(buf, off);
    off += 4;
    for (let i = 0; i < len; i++) buf[off + i] = payload[i] ^ key[i & 3];
  } else {
    payload.copy(buf, off);
  }
  return buf;
}

/** Incremental frame parser. `requireMask` = true when parsing client frames. */
class FrameParser {
  constructor({ maxPayload, requireMask }) {
    this.maxPayload = maxPayload;
    this.requireMask = requireMask;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    for (;;) {
      const buf = this.buf;
      if (buf.length < 2) break;
      const b0 = buf[0];
      const b1 = buf[1];
      if (b0 & 0x70) throw new WsError(1002, 'reserved bits set');
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if (!VALID_OPCODES.has(opcode)) throw new WsError(1002, 'bad opcode');
      const masked = (b1 & 0x80) !== 0;
      if (this.requireMask && !masked) throw new WsError(1002, 'unmasked client frame');
      if (!this.requireMask && masked) throw new WsError(1002, 'masked server frame');
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) break;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) break;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) throw new WsError(1009, 'frame too large');
        len = Number(big);
        off = 10;
      }
      const isControl = (opcode & 0x8) !== 0;
      if (isControl && (!fin || len > 125)) throw new WsError(1002, 'bad control frame');
      if (len > this.maxPayload) throw new WsError(1009, 'frame too large');
      let key = null;
      if (masked) {
        if (buf.length < off + 4) break;
        key = buf.subarray(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) break;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (key) for (let i = 0; i < len; i++) payload[i] ^= key[i & 3];
      this.buf = buf.subarray(off + len);
      frames.push({ fin, opcode, payload });
    }
    return frames;
  }
}

function encodeClose(code, reason) {
  const r = Buffer.from(String(reason || ''), 'utf8').subarray(0, 120);
  const p = Buffer.allocUnsafe(2 + r.length);
  p.writeUInt16BE(code, 0);
  r.copy(p, 2);
  return p;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** A server-side WebSocket connection wrapping an already-upgraded socket. */
class WebSocketConnection extends EventEmitter {
  constructor(socket, { maxPayload = 8192, closeTimeoutMs = 2000 } = {}) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.closeTimeoutMs = closeTimeoutMs;
    this.parser = new FrameParser({ maxPayload, requireMask: true });
    this.fragOpcode = null;
    this.fragChunks = [];
    this.fragSize = 0;
    this.closeSent = false;
    this.closeReceived = false;
    this.finished = false;
    this.failed = false;
    this.peerCloseCode = null;
    this.ourCloseCode = null;
    this.closeTimer = null;

    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._finish());
    socket.on('error', (e) => {
      if (this.listenerCount('error') > 0) this.emit('error', e);
    });
  }

  get open() {
    return !this.closeSent && !this.finished;
  }

  _onData(chunk) {
    if (this.failed) {
      // We already sent our Close frame; whatever the peer says next, we are done.
      if (!this.socket.destroyed) this.socket.end();
      return;
    }
    if (this.closeReceived || this.finished) return;
    try {
      for (const f of this.parser.push(chunk)) {
        this._onFrame(f);
        if (this.closeReceived || this.finished) return;
      }
    } catch (e) {
      // Protocol violation: stop parsing for good, say why, and let the close timer reap the socket.
      this.failed = true;
      if (e instanceof WsError) this.close(e.closeCode, e.message);
      else this.terminate();
    }
  }

  _onFrame(f) {
    switch (f.opcode) {
      case OP.PING:
        this._write(encodeFrame(OP.PONG, f.payload, false));
        break;
      case OP.PONG:
        this.emit('pong');
        break;
      case OP.CLOSE: {
        if (f.payload.length === 1) throw new WsError(1002, 'bad close frame');
        this.closeReceived = true;
        this.peerCloseCode = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
        if (!this.closeSent) {
          this.closeSent = true;
          this.ourCloseCode = this.peerCloseCode === 1005 ? 1000 : this.peerCloseCode;
          this._write(encodeFrame(OP.CLOSE, encodeClose(this.ourCloseCode, ''), false));
        }
        this.socket.end();
        this._armCloseTimer();
        break;
      }
      case OP.BINARY:
        throw new WsError(1003, 'binary frames not supported');
      case OP.TEXT:
        if (this.fragOpcode !== null) throw new WsError(1002, 'unexpected data frame');
        if (f.fin) this._deliver(f.payload);
        else this._startFragment(f);
        break;
      case OP.CONT:
        if (this.fragOpcode === null) throw new WsError(1002, 'unexpected continuation');
        this.fragSize += f.payload.length;
        if (this.fragSize > this.maxPayload) throw new WsError(1009, 'message too large');
        this.fragChunks.push(f.payload);
        if (f.fin) {
          const whole = Buffer.concat(this.fragChunks);
          this.fragOpcode = null;
          this.fragChunks = [];
          this.fragSize = 0;
          this._deliver(whole);
        }
        break;
      default:
        throw new WsError(1002, 'bad opcode');
    }
  }

  _startFragment(f) {
    this.fragOpcode = f.opcode;
    this.fragChunks = [f.payload];
    this.fragSize = f.payload.length;
  }

  _deliver(payload) {
    let text;
    try {
      text = utf8.decode(payload);
    } catch {
      throw new WsError(1007, 'invalid UTF-8');
    }
    this.emit('message', text);
  }

  _write(buf) {
    if (this.finished || this.socket.destroyed) return false;
    if (this.socket.writableLength > 1024 * 1024) {
      this.terminate();
      return false;
    }
    this.socket.write(buf);
    return true;
  }

  sendText(str) {
    if (!this.open) return false;
    return this._write(encodeFrame(OP.TEXT, Buffer.from(str, 'utf8'), false));
  }

  ping() {
    if (!this.open) return false;
    return this._write(encodeFrame(OP.PING, Buffer.alloc(0), false));
  }

  close(code = 1000, reason = '') {
    if (this.finished || this.closeSent) return;
    this.closeSent = true;
    this.ourCloseCode = code;
    this._write(encodeFrame(OP.CLOSE, encodeClose(code, reason), false));
    this._armCloseTimer();
  }

  _armCloseTimer() {
    if (this.closeTimer) return;
    this.closeTimer = setTimeout(() => this.terminate(), this.closeTimeoutMs);
    this.closeTimer.unref();
  }

  terminate() {
    if (!this.socket.destroyed) this.socket.destroy();
    this._finish();
  }

  _finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    const code = this.peerCloseCode || this.ourCloseCode || 1006;
    this.emit('close', code);
  }
}

/**
 * Validate an HTTP upgrade request and, if valid, complete the handshake.
 * Returns a WebSocketConnection or null (after replying 400 and ending the socket).
 */
function acceptUpgrade(req, socket, head, options = {}) {
  const h = req.headers;
  const fail = (status = '400 Bad Request') => {
    if (!socket.destroyed) {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
    return null;
  };
  if (req.method !== 'GET') return fail('405 Method Not Allowed');
  if (String(h.upgrade || '').toLowerCase() !== 'websocket') return fail();
  const conn = String(h.connection || '').toLowerCase().split(',').map((s) => s.trim());
  if (!conn.includes('upgrade')) return fail();
  if (h['sec-websocket-version'] !== '13') return fail('426 Upgrade Required');
  const key = h['sec-websocket-key'];
  if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) return fail();

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${computeAccept(key)}\r\n\r\n`
  );
  socket.setNoDelay(true);
  socket.setTimeout(0);
  const ws = new WebSocketConnection(socket, options);
  if (head && head.length) ws._onData(head);
  return ws;
}

module.exports = {
  GUID,
  OP,
  WsError,
  computeAccept,
  encodeFrame,
  encodeClose,
  FrameParser,
  WebSocketConnection,
  acceptUpgrade,
};
