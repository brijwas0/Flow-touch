'use strict';
/** Portable test runner (no shell globbing needed on Windows). */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = path.join(__dirname, '..', 'test');
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(dir, f));

const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
