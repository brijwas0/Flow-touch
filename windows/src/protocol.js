'use strict';
/**
 * Message protocol (JSON text frames over TLS WebSocket) and strict validation.
 *
 * phone -> receiver
 *   {t:"pair", cn:<32 hex>, proof:<64 hex>, name?:string}
 *   {t:"m",   dx:int, dy:int}                 relative pointer move (pixels)
 *   {t:"b",   b:"l"|"r"|"m", a:"d"|"u"|"c"}   button down / up / click
 *   {t:"s",   dx?:int, dy?:int}               scroll in wheel units (120 = one notch)
 *   {t:"k",   k:<key name>}                   press+release a whitelisted key
 *   {t:"txt", s:string}                       type text (<= 256 UTF-16 units)
 *   {t:"ping"} | {t:"bye"}
 *
 * receiver -> phone
 *   {t:"challenge", v:1, sn:<32 hex>}
 *   {t:"paired", v:1, proof:<64 hex>, host:string, ttl:seconds}
 *   {t:"error", code:string, msg:string, retry?:seconds}
 *   {t:"pong"}
 */

const LIMITS = Object.freeze({
  maxMessageBytes: 8192,
  moveMax: 1000,
  scrollMax: 2400,
  textMaxUnits: 256,
  nameMaxLength: 40,
});

/** Whitelisted keys -> Windows virtual-key codes. Nothing else can be pressed. */
const KEYS = Object.freeze({
  enter: 0x0d,
  backspace: 0x08,
  tab: 0x09,
  escape: 0x1b,
  space: 0x20,
  delete: 0x2e,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
});

/** Whitelisted gestures for Windows Precision Touchpad simulation. */
const GESTURES = Object.freeze([
  'start',
  'desktop',
  'notifications',
  'app_next',
  'app_prev',
  'desktop_next',
  'desktop_prev',
  'task_view',
]);

class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

function intInRange(v, max, field) {
  if (!isInt(v) || v < -max || v > max) throw new ProtocolError('range', `${field} out of range`);
  return v;
}

function sanitizeName(name) {
  if (typeof name !== 'string') return 'Phone';
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, LIMITS.nameMaxLength);
  return cleaned || 'Phone';
}

/** Parse the raw text of a frame into a plain object. */
function parseJson(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > LIMITS.maxMessageBytes) {
    throw new ProtocolError('size', 'message too large');
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new ProtocolError('json', 'malformed JSON');
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.t !== 'string') {
    throw new ProtocolError('shape', 'message must be an object with a string "t"');
  }
  return obj;
}

/** Validate a post-authentication control message; returns a normalized copy. */
function validateControl(msg) {
  switch (msg.t) {
    case 'm':
      return { t: 'm', dx: intInRange(msg.dx, LIMITS.moveMax, 'dx'), dy: intInRange(msg.dy, LIMITS.moveMax, 'dy') };
    case 'b': {
      if (!['l', 'r', 'm'].includes(msg.b)) throw new ProtocolError('value', 'bad button');
      if (!['d', 'u', 'c'].includes(msg.a)) throw new ProtocolError('value', 'bad button action');
      return { t: 'b', b: msg.b, a: msg.a };
    }
    case 's': {
      const dx = msg.dx === undefined ? 0 : intInRange(msg.dx, LIMITS.scrollMax, 'dx');
      const dy = msg.dy === undefined ? 0 : intInRange(msg.dy, LIMITS.scrollMax, 'dy');
      return { t: 's', dx, dy };
    }
    case 'k': {
      if (typeof msg.k !== 'string' || !Object.prototype.hasOwnProperty.call(KEYS, msg.k)) {
        throw new ProtocolError('value', 'unsupported key');
      }
      return { t: 'k', k: msg.k };
    }
    case 'g': {
      if (typeof msg.a !== 'string' || !GESTURES.includes(msg.a)) {
        throw new ProtocolError('value', 'unsupported gesture action');
      }
      return { t: 'g', a: msg.a };
    }
    case 'z': {
      const dy = intInRange(msg.dy, LIMITS.scrollMax, 'dy');
      return { t: 'z', dy };
    }
    case 'txt': {
      if (typeof msg.s !== 'string' || msg.s.length === 0 || msg.s.length > LIMITS.textMaxUnits) {
        throw new ProtocolError('range', 'text length out of range');
      }
      if (typeof msg.s.isWellFormed === 'function' && !msg.s.isWellFormed()) {
        throw new ProtocolError('value', 'text is not valid Unicode');
      }
      return { t: 'txt', s: msg.s };
    }
    case 'ping':
      return { t: 'ping' };
    case 'bye':
      return { t: 'bye' };
    default:
      throw new ProtocolError('type', 'unknown message type');
  }
}

/**
 * Split text into typed segments: plain text, plus Enter/Tab for \n and \t.
 * All other control characters are dropped.
 * @returns {({text: string}|{key: string})[]}
 */
function segmentText(s) {
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ text: buf });
    buf = '';
  };
  const normalized = s.replace(/\r\n?/g, '\n');
  for (const ch of normalized) {
    if (ch === '\n') {
      flush();
      out.push({ key: 'enter' });
    } else if (ch === '\t') {
      flush();
      out.push({ key: 'tab' });
    } else {
      const cp = ch.codePointAt(0);
      if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue; // control characters
      buf += ch;
    }
  }
  flush();
  return out;
}

module.exports = { LIMITS, KEYS, GESTURES, ProtocolError, sanitizeName, parseJson, validateControl, segmentText };
