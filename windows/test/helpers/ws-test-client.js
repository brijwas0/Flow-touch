'use strict';
/** A tiny test-only WebSocket-over-TLS client that behaves like the phone app. */

const tls = require('node:tls');
const crypto = require('node:crypto');
const { FrameParser, encodeFrame, computeAccept, OP } = require('../../src/ws-lite');
const { computeProof } = require('../../src/pairing');

function connect({ port, host = '127.0.0.1', path = '/ws', rawFrames = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    const parser = new FrameParser({ maxPayload: 1 << 20, requireMask: false });
    const client = {
      socket,
      fingerprint: null,
      messages: [],
      closeCode: null,
      closed: false,
      waiters: [],
      closedPromise: null,
      send(obj) {
        socket.write(encodeFrame(OP.TEXT, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)), true));
      },
      sendFrame(opcode, payload, mask = true) {
        socket.write(encodeFrame(opcode, payload, mask));
      },
      sendRaw(buf) {
        socket.write(buf);
      },
      close(code = 1000) {
        const p = Buffer.alloc(2);
        p.writeUInt16BE(code);
        socket.write(encodeFrame(OP.CLOSE, p, true));
      },
      waitFor(pred, ms = 2000) {
        const found = client.messages.find(pred);
        if (found) return Promise.resolve(found);
        return new Promise((res, rej) => {
          const w = { pred, res };
          w.timer = setTimeout(() => {
            client.waiters = client.waiters.filter((x) => x !== w);
            rej(new Error('timed out waiting for message'));
          }, ms);
          client.waiters.push(w);
        });
      },
      waitClosed(ms = 3000) {
        return Promise.race([
          client.closedPromise,
          new Promise((_, rej) => setTimeout(() => rej(new Error('timed out waiting for close')), ms)),
        ]);
      },
    };
    client.closedPromise = new Promise((res) => {
      socket.on('close', () => {
        client.closed = true;
        res(client.closeCode);
      });
    });

    let head = Buffer.alloc(0);
    let upgraded = false;
    const key = crypto.randomBytes(16).toString('base64');

    const onFrame = (f) => {
      if (f.opcode === OP.TEXT) {
        const msg = JSON.parse(f.payload.toString('utf8'));
        client.messages.push(msg);
        for (const w of [...client.waiters]) {
          if (w.pred(msg)) {
            clearTimeout(w.timer);
            client.waiters = client.waiters.filter((x) => x !== w);
            w.res(msg);
          }
        }
      } else if (f.opcode === OP.CLOSE) {
        client.closeCode = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
        client.sendFrame(OP.CLOSE, f.payload.subarray(0, 2));
      } else if (f.opcode === OP.PING) {
        client.sendFrame(OP.PONG, f.payload);
      }
    };

    socket.on('secureConnect', () => {
      client.fingerprint = crypto.createHash('sha256').update(socket.getPeerCertificate().raw).digest('hex');
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    socket.on('data', (d) => {
      if (!upgraded) {
        head = Buffer.concat([head, d]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        const header = head.subarray(0, end).toString('latin1');
        const rest = head.subarray(end + 4);
        if (!header.startsWith('HTTP/1.1 101')) {
          socket.destroy();
          reject(new Error(`upgrade refused: ${header.split('\r\n')[0]}`));
          return;
        }
        if (!header.includes(computeAccept(key))) {
          socket.destroy();
          reject(new Error('bad Sec-WebSocket-Accept'));
          return;
        }
        upgraded = true;
        resolve(client);
        d = rest;
        if (!d.length) return;
      }
      try {
        for (const f of parser.push(d)) onFrame(f);
      } catch (e) {
        client.parseError = e;
      }
    });
    socket.on('error', (e) => {
      if (!upgraded) reject(e);
    });
    socket.on('close', () => {
      if (!upgraded) reject(new Error('connection closed before upgrade'));
    });
  });
}

/** Run the pairing handshake as the phone would. Resolves with the final message (paired or error). */
async function pair(client, code, { name = 'Test Phone', fingerprint = client.fingerprint } = {}) {
  const ch = await client.waitFor((m) => m.t === 'challenge');
  const cn = crypto.randomBytes(16).toString('hex');
  const proof = computeProof('client', code, ch.sn, cn, fingerprint);
  client.send({ t: 'pair', cn, proof, name });
  const reply = await client.waitFor((m) => m.t === 'paired' || m.t === 'error');
  reply.expectedServerProof = computeProof('server', code, ch.sn, cn, fingerprint);
  return reply;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { connect, pair, sleep };
