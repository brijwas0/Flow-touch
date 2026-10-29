'use strict';
/**
 * Static checks without any dependencies:
 *  - every .js file parses (node --check)
 *  - every relative require() points at a file that exists
 *  - package.json is valid and its scripts point at existing files
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const problems = [];

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

const files = walk(root);
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) problems.push(`syntax error in ${path.relative(root, f)}:\n${r.stderr}`);

  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    const target = path.resolve(path.dirname(f), m[1]);
    const candidates = [target, `${target}.js`, path.join(target, 'index.js')];
    if (!candidates.some((c) => fs.existsSync(c) && fs.statSync(c).isFile())) {
      problems.push(`${path.relative(root, f)} requires missing file ${m[1]}`);
    }
  }
}

try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    const m = /^node\s+(\S+\.js)/.exec(cmd);
    if (m && !fs.existsSync(path.join(root, m[1]))) problems.push(`package.json script "${name}" points at missing ${m[1]}`);
  }
  if (Object.keys(pkg.dependencies || {}).length) problems.push('unexpected runtime dependencies (the receiver is dependency-free)');
} catch (e) {
  problems.push(`package.json: ${e.message}`);
}

if (!fs.existsSync(path.join(root, 'src', 'input', 'input-helper.ps1'))) problems.push('missing src/input/input-helper.ps1');

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`OK: ${files.length} JavaScript files parsed, requires resolved, package.json valid.`);
