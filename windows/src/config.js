'use strict';

const { parseIPv4, isPrivateIPv4, isLoopbackIPv4, getLocalIPv4Candidates } = require('./net-utils');

const DEFAULT_PORT = 47820;

const HELP = `PhoneTouch receiver

Usage: node server.js [options]

  --port <n>            TCP port to listen on (default ${DEFAULT_PORT}, 1024-65535)
  --host <ipv4>         Private LAN address to listen on (repeatable). Default: every
                        private IPv4 address of this PC except virtual adapters.
  --backend <name>      windows (default on Windows) or mock (records events only; for testing)
  --code-minutes <n>    Pairing code lifetime in minutes (default 5)
  --session-hours <n>   Maximum length of one session in hours (default 4)
  --help, -h            Show this help
  --version, -v         Show the version

While running, type a command and press Enter:
  status   show state          new    issue a new pairing code
  revoke   disconnect phone    quit   stop the receiver
`;

class ConfigError extends Error {}

function num(name, value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new ConfigError(`${name} must be a number between ${min} and ${max}.`);
  return n;
}

/**
 * @param {string[]} argv arguments after "node server.js"
 * @param {{platform?: string, env?: object, interfaces?: object}} ctx
 */
function parseArgs(argv, ctx = {}) {
  const platform = ctx.platform || process.platform;
  const env = ctx.env || process.env;
  const cfg = {
    help: false,
    version: false,
    port: env.PHONETOUCH_PORT ? num('PHONETOUCH_PORT', env.PHONETOUCH_PORT, 1024, 65535) : DEFAULT_PORT,
    hosts: [],
    backend: platform === 'win32' ? 'windows' : null,
    codeTtlMs: 5 * 60 * 1000,
    sessionMs: 4 * 60 * 60 * 1000,
    gui: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new ConfigError(`${a} needs a value.`);
      return argv[++i];
    };
    switch (a) {
      case '--help':
      case '-h':
        cfg.help = true;
        break;
      case '--version':
      case '-v':
        cfg.version = true;
        break;
      case '--port':
        cfg.port = num('--port', next(), 1024, 65535);
        break;
      case '--host': {
        cfg.hosts.push(next());
        break;
      }
      case '--backend': {
        const b = next();
        if (b !== 'windows' && b !== 'mock') throw new ConfigError('--backend must be "windows" or "mock".');
        cfg.backend = b;
        break;
      }
      case '--code-minutes':
        cfg.codeTtlMs = num('--code-minutes', next(), 1, 60) * 60 * 1000;
        break;
      case '--session-hours':
        cfg.sessionMs = num('--session-hours', next(), 0.1, 24) * 60 * 60 * 1000;
        break;
      case '--no-gui':
        cfg.gui = false;
        break;
      case '--companion-port':
        cfg.companionPort = num('--companion-port', next(), 1024, 65535);
        break;
      default:
        throw new ConfigError(`Unknown option "${a}". Use --help to see the options.`);
    }
  }

  if (!cfg.backend) {
    throw new ConfigError('This receiver controls a Windows PC. On other systems you can only try it with --backend mock.');
  }
  if (cfg.backend === 'windows' && platform !== 'win32') {
    throw new ConfigError('The "windows" backend only works on Windows. Use --backend mock to try the protocol elsewhere.');
  }

  for (const h of cfg.hosts) {
    const ok = isPrivateIPv4(h) || (cfg.backend === 'mock' && isLoopbackIPv4(h));
    if (!parseIPv4(h) || !ok) {
      throw new ConfigError(`--host must be a private IPv4 address (10.x.x.x, 172.16-31.x.x or 192.168.x.x), got "${h}".`);
    }
  }

  cfg.autoHosts = cfg.hosts.length === 0;
  if (cfg.autoHosts) {
    const all = getLocalIPv4Candidates(ctx.interfaces);
    const real = all.filter((c) => !c.virtual);
    cfg.candidates = all;
    cfg.hosts = (real.length ? real : all).map((c) => c.address);
  }
  return cfg;
}

module.exports = { parseArgs, ConfigError, HELP, DEFAULT_PORT };
