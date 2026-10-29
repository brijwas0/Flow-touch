'use strict';
/**
 * Local health check:  node scripts/health.js [port]
 *
 * Talks to the receiver over loopback only. The receiver's certificate is
 * self-signed and ephemeral, so certificate verification is disabled for this
 * single loopback request; nothing sensitive is sent or received.
 */

const https = require('node:https');

const port = Number(process.argv[2] || process.env.PHONETOUCH_PORT || 47820);

const req = https.get(
  { host: '127.0.0.1', port, path: '/health', rejectUnauthorized: false, timeout: 4000 },
  (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (d) => (body += d));
    res.on('end', () => {
      if (res.statusCode !== 200) {
        console.error(`Receiver answered HTTP ${res.statusCode}.`);
        process.exit(1);
      }
      console.log(body);
      process.exit(0);
    });
  }
);
req.on('timeout', () => req.destroy(new Error('timed out')));
req.on('error', (e) => {
  console.error(`Receiver is not reachable on 127.0.0.1:${port} (${e.code || e.message}). Is it running?`);
  process.exit(1);
});
