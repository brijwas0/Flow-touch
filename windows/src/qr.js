'use strict';

/**
 * Self-contained QR Code generator in pure JavaScript (no external dependencies).
 * Generates clean, crisp SVG elements for PhoneTouch pairing.
 * Supports Byte mode up to QR Code Version 6 with Error Correction Level L / M.
 */

// Galois Field GF(256) with primitive polynomial 0x11D (x^8 + x^4 + x^3 + x^2 + 1)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_EXP[i + 255] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 256) x ^= 0x11d;
  }
})();

function gfMul(x, y) {
  if (x === 0 || y === 0) return 0;
  return GF_EXP[GF_LOG[x] + GF_LOG[y]];
}

function rsGeneratorPoly(numEc) {
  let poly = [1];
  for (let i = 0; i < numEc; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], root);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}

function rsCompute(data, numEc) {
  const gen = rsGeneratorPoly(numEc);
  const res = new Uint8Array(numEc);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    for (let j = 0; j < numEc - 1; j++) {
      res[j] = res[j + 1] ^ gfMul(gen[numEc - 1 - j], factor);
    }
    res[numEc - 1] = gfMul(gen[0], factor);
  }
  return res;
}

// Table of QR versions (Version 1 to 6, Error Correction Level M)
// [totalCodewords, ecCodewords, ecBlocks]
const VERSION_INFO = [
  null,
  { total: 26, ec: 10, blocks: 1 },  // V1: 21x21, 16 data cw -> ~14 bytes
  { total: 44, ec: 16, blocks: 1 },  // V2: 25x25, 28 data cw -> ~26 bytes
  { total: 70, ec: 26, blocks: 1 },  // V3: 29x29, 44 data cw -> ~42 bytes
  { total: 100, ec: 18, blocks: 2 }, // V4: 33x33, 64 data cw -> ~62 bytes (36 EC cw)
  { total: 134, ec: 24, blocks: 2 }, // V5: 37x37, 86 data cw -> ~84 bytes (48 EC cw)
  { total: 172, ec: 16, blocks: 4 }, // V6: 41x41, 108 data cw -> ~106 bytes (64 EC cw)
];

const ALIGN_PATTERNS = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
];

// Format info for EC Level M (00) with 8 mask patterns (0 to 7)
const FORMAT_INFO = [
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
];

function chooseVersion(dataLen) {
  // Byte mode header: 4 bits mode + 8 bits char count = 12 bits = 1.5 bytes
  const neededDataBytes = dataLen + 2;
  for (let v = 1; v < VERSION_INFO.length; v++) {
    const info = VERSION_INFO[v];
    const totalEc = info.ec * info.blocks;
    const dataCapacity = info.total - totalEc;
    if (dataCapacity >= neededDataBytes) return v;
  }
  return 6;
}

class BitBuffer {
  constructor() {
    this.buffer = [];
    this.length = 0;
  }
  put(val, len) {
    for (let i = 0; i < len; i++) {
      this.buffer.push((val >>> (len - 1 - i)) & 1);
      this.length++;
    }
  }
  getBytes() {
    const bytes = new Uint8Array(Math.ceil(this.length / 8));
    for (let i = 0; i < this.length; i++) {
      if (this.buffer[i]) bytes[i >>> 3] |= 0x80 >>> (i & 7);
    }
    return bytes;
  }
}

function encodeData(text, version) {
  const bytes = Buffer.from(text, 'utf8');
  const bb = new BitBuffer();
  // Mode: Byte (0100)
  bb.put(0x4, 4);
  // Character count: 8 bits for V1-V9
  bb.put(bytes.length, 8);
  for (let i = 0; i < bytes.length; i++) {
    bb.put(bytes[i], 8);
  }

  const vInfo = VERSION_INFO[version];
  const totalEc = vInfo.ec * vInfo.blocks;
  const dataCap = vInfo.total - totalEc;

  // Terminator
  const padBits = Math.min(4, dataCap * 8 - bb.length);
  bb.put(0, padBits);
  // Align to byte
  while (bb.length % 8 !== 0) bb.put(0, 1);

  // Pad bytes
  const padBytes = [0xec, 0x11];
  let p = 0;
  while (bb.length < dataCap * 8) {
    bb.put(padBytes[p % 2], 8);
    p++;
  }

  const dataBytes = bb.getBytes();
  const blockSize = Math.floor(dataCap / vInfo.blocks);
  const ecSize = vInfo.ec;

  const blocks = [];
  const ecBlocks = [];

  for (let b = 0; b < vInfo.blocks; b++) {
    const start = b * blockSize;
    const end = (b === vInfo.blocks - 1) ? dataCap : (b + 1) * blockSize;
    const blk = dataBytes.slice(start, end);
    blocks.push(blk);
    ecBlocks.push(rsCompute(blk, ecSize));
  }

  // Interleave data codewords then EC codewords
  const result = new Uint8Array(vInfo.total);
  let idx = 0;
  const maxBlockLen = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxBlockLen; i++) {
    for (let b = 0; b < vInfo.blocks; b++) {
      if (i < blocks[b].length) result[idx++] = blocks[b][i];
    }
  }
  for (let i = 0; i < ecSize; i++) {
    for (let b = 0; b < vInfo.blocks; b++) {
      result[idx++] = ecBlocks[b][i];
    }
  }

  return result;
}

function createMatrix(version, dataCodewords) {
  const size = 17 + 4 * version;
  const mat = Array.from({ length: size }, () => new Int8Array(size).fill(-1));

  // Finder pattern
  function drawFinder(row, col) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const nr = row + r;
        const nc = col + c;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
        if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
          if (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
            mat[nr][nc] = 1;
          } else {
            mat[nr][nc] = 0;
          }
        } else {
          mat[nr][nc] = 0;
        }
      }
    }
  }

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    if (mat[6][i] === -1) mat[6][i] = (i % 2 === 0) ? 1 : 0;
    if (mat[i][6] === -1) mat[i][6] = (i % 2 === 0) ? 1 : 0;
  }

  // Alignment patterns
  const aligns = ALIGN_PATTERNS[version] || [];
  for (const r of aligns) {
    for (const c of aligns) {
      if (mat[r][c] !== -1) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const isBorder = Math.max(Math.abs(dr), Math.abs(dc)) === 2;
          const isCenter = dr === 0 && dc === 0;
          mat[r + dr][c + dc] = (isBorder || isCenter) ? 1 : 0;
        }
      }
    }
  }

  // Dark module
  mat[4 * version + 9][8] = 1;

  // Reserve format information areas
  for (let i = 0; i <= 8; i++) {
    if (mat[8][i] === -1) mat[8][i] = 0;
    if (mat[i][8] === -1) mat[i][8] = 0;
  }
  for (let i = size - 8; i < size; i++) {
    if (mat[8][i] === -1) mat[8][i] = 0;
    if (mat[i][8] === -1) mat[i][8] = 0;
  }

  // Place data bits with Mask 0 ((row + col) % 2 === 0)
  const mask = (r, c) => ((r + c) % 2 === 0);
  let bitIdx = 0;
  const totalBits = dataCodewords.length * 8;

  let right = size - 1;
  let dir = -1; // upwards

  while (right > 0) {
    if (right === 6) right--; // skip timing vertical column
    const colA = right;
    const colB = right - 1;

    let row = dir === -1 ? size - 1 : 0;
    while (row >= 0 && row < size) {
      for (const col of [colA, colB]) {
        if (mat[row][col] === -1) {
          let bit = 0;
          if (bitIdx < totalBits) {
            const byte = dataCodewords[bitIdx >>> 3];
            bit = (byte >>> (7 - (bitIdx & 7))) & 1;
            bitIdx++;
          }
          if (mask(row, col)) bit ^= 1;
          mat[row][col] = bit;
        }
      }
      row += dir;
    }
    dir = -dir;
    right -= 2;
  }

  // Write format info for Mask 0 (EC Level M)
  const fmt = FORMAT_INFO[0];
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >>> (14 - i)) & 1;
    // Around top-left
    if (i < 6) mat[8][i] = bit;
    else if (i === 6) mat[8][7] = bit;
    else if (i === 7) mat[8][8] = bit;
    else if (i === 8) mat[7][8] = bit;
    else mat[14 - i][8] = bit;

    // Around other finders
    if (i < 8) mat[size - 1 - i][8] = bit;
    else mat[8][size - 15 + i] = bit;
  }

  return mat;
}

/**
 * Generate an SVG string representing the QR code.
 */
function generateQrSvg(text, { sizePx = 280, margin = 4, darkColor = '#FFFFFF', lightColor = 'transparent' } = {}) {
  const version = chooseVersion(Buffer.byteLength(text, 'utf8'));
  const codewords = encodeData(text, version);
  const matrix = createMatrix(version, codewords);
  const n = matrix.length;
  const viewBoxSize = n + margin * 2;

  let pathD = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c] === 1) {
        const x = c + margin;
        const y = r + margin;
        pathD += `M${x},${y}h1v1h-1z `;
      }
    }
  }

  const bgRect = lightColor !== 'transparent'
    ? `<rect width="${viewBoxSize}" height="${viewBoxSize}" fill="${lightColor}"/>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" width="${sizePx}" height="${sizePx}" shape-rendering="crispEdges">${bgRect}<path d="${pathD.trim()}" fill="${darkColor}"/></svg>`;
}

module.exports = { generateQrSvg, chooseVersion, encodeData, createMatrix };
