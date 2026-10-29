'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateQrSvg, chooseVersion } = require('../src/qr');

test('QR generator produces valid SVG for PhoneTouch pairing URI', () => {
  const uri = 'phonetouch://pair?h=192.168.1.10&p=47820&c=K7QMX2TD9FRA&n=DesktopPC';
  const svg = generateQrSvg(uri);
  assert.ok(svg.startsWith('<svg'), 'must start with <svg');
  assert.ok(svg.includes('viewBox="0 0'), 'must have viewBox');
  assert.ok(svg.includes('<path d="M'), 'must have path modules');
  assert.ok(svg.endsWith('</svg>'), 'must close svg tag');
});

test('chooseVersion handles small and large text appropriately', () => {
  assert.equal(chooseVersion(10), 1);
  assert.ok(chooseVersion(70) >= 4);
});
