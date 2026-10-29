'use strict';

const os = require('node:os');

function parseIPv4(ip) {
  if (typeof ip !== 'string') return null;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** RFC 1918 private ranges only (10/8, 172.16/12, 192.168/16). */
function isPrivateIPv4(ip) {
  const p = parseIPv4(ip);
  if (!p) return false;
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}

function isLoopbackIPv4(ip) {
  const p = parseIPv4(ip);
  return !!p && p[0] === 127;
}

function isLinkLocalIPv4(ip) {
  const p = parseIPv4(ip);
  return !!p && p[0] === 169 && p[1] === 254;
}

/** Strip the IPv4-mapped IPv6 prefix that Node reports for some sockets. */
function normalizeRemote(addr) {
  if (typeof addr !== 'string') return '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

/** Only devices on a private/link-local/loopback IPv4 address may even talk to the receiver. */
function isAllowedRemote(addr) {
  const ip = normalizeRemote(addr);
  return isPrivateIPv4(ip) || isLoopbackIPv4(ip) || isLinkLocalIPv4(ip);
}

const VIRTUAL_NAME = /(vethernet|virtualbox|vmware|vmnet|hyper-v|wsl|docker|loopback|bluetooth|tailscale|zerotier|npcap)/i;

/**
 * Private IPv4 addresses of this machine, best candidates first.
 * @returns {{name: string, address: string, virtual: boolean}[]}
 */
function getLocalIPv4Candidates(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs || []) {
      const family = typeof a.family === 'string' ? a.family : `IPv${a.family}`;
      if (family !== 'IPv4' || a.internal) continue;
      if (!isPrivateIPv4(a.address)) continue;
      out.push({ name, address: a.address, virtual: VIRTUAL_NAME.test(name) });
    }
  }
  const rank = (c) => (c.virtual ? 10 : 0) + (c.address.startsWith('192.168.') ? 0 : c.address.startsWith('10.') ? 1 : 2);
  return out.sort((x, y) => rank(x) - rank(y));
}

module.exports = {
  parseIPv4,
  isPrivateIPv4,
  isLoopbackIPv4,
  isLinkLocalIPv4,
  normalizeRemote,
  isAllowedRemote,
  getLocalIPv4Candidates,
};
