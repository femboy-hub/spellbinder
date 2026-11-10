/* Spellbinder — on-device card fingerprint (Phase 7c).
   Browser port of scanner/hasher.mjs, generated mechanically: the pixel
   math is byte-identical to the validated Node module (Phase 7a parity
   136/136 vs imagehash); only the ES-module exports were unwrapped into
   window.Fingerprint. Do not hand-edit the math — regenerate from
   hasher.mjs instead. */
(function (global) {
'use strict';
/**
 * hasher.mjs — Spellbinder local card fingerprint (production candidate).
 *
 * Pure pixel math: no I/O, no dependencies, no Node-specific APIs, so this
 * file ports to the browser unchanged. Image *decoding* (JPEG/PNG/WebP ->
 * RGBA) is the caller's job; this module starts from raw pixels.
 *
 * It reproduces, bit for bit as closely as floating point allows, the
 * Python prototype's fingerprint:
 *
 *   Python (imagehash.phash, hash_size=8, highfreq_factor=4):
 *     img.convert('L').resize((32, 32), LANCZOS)
 *     dct = scipy.fftpack.dct(scipy.fftpack.dct(pixels, axis=0), axis=1)
 *     low = dct[:8, :8]; med = numpy.median(low)   # median over ALL 64
 *     bits = low > med
 *     hex  = bits flattened row-major, first bit = MSB of first nibble
 *
 *   Applied to the standard-frame ART WINDOW of the full card image
 *   (fractions x 0.075-0.925, y 0.105-0.56) — never Scryfall's art_crop,
 *   which covers a different region on full-art printings.
 *
 * Bit order of the returned hash: bit index i = row*8 + col of the 8x8
 * low-frequency block (row = vertical DCT frequency, col = horizontal),
 * flattened row-major. In the hex string and in the BigInt value, bit 0 is
 * the MOST significant bit (value = sum(bit[i] << (63 - i))), matching
 * imagehash's hex output exactly: hashToHex(hashCardImage(...)) ===
 * str(imagehash.phash(window)) for the same pixels.
 */

// Standard MTG frame art window, fractions of the full card image:
// [left, top, right, bottom]. Same constants as the prototype (match_lib.py).
const ART_BOX = [0.075, 0.105, 0.925, 0.56];

const HASH_SIZE = 8;          // 8x8 low-frequency block -> 64 bits
const IMG_SIZE = 32;          // hash_size * highfreq_factor

/* ------------------------------------------------------------------ *
 * Grayscale — Pillow convert('L') uses the ITU-R 601-2 luma with
 * 16-bit fixed-point coefficients:
 *   L = (19595*R + 38470*G + 7471*B + 32768) >> 16
 * Alpha is ignored (card images are opaque).
 * ------------------------------------------------------------------ */
function grayFromRgba(rgba, x0, y0, w, h, imgWidth) {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    let src = ((y0 + y) * imgWidth + x0) * 4;
    let dst = y * w;
    for (let x = 0; x < w; x++, src += 4, dst++) {
      out[dst] = (19595 * rgba[src] + 38470 * rgba[src + 1] +
                  7471 * rgba[src + 2] + 32768) >> 16;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Resampling — Pillow-style separable Lanczos-3 with the filter support
 * scaled by the downscale factor (antialiased), weights normalized,
 * intermediate pass rounded/clamped to 0..255 exactly like Pillow's
 * mode-'L' pipeline (horizontal pass -> uint8 image -> vertical pass).
 * ------------------------------------------------------------------ */
function lanczos3(t) {
  if (t === 0) return 1;
  if (t <= -3 || t >= 3) return 0;
  const pi = Math.PI;
  return (Math.sin(pi * t) / (pi * t)) * (Math.sin(pi * t / 3) / (pi * t / 3));
}

function resampleCoeffs(inSize, outSize) {
  const scale = inSize / outSize;
  const filterScale = Math.max(scale, 1);      // support grows on downscale
  const support = 3 * filterScale;
  const coeffs = [];
  for (let o = 0; o < outSize; o++) {
    const center = (o + 0.5) * scale;
    let xmin = Math.floor(center - support + 0.5);
    let xmax = Math.floor(center + support + 0.5);
    if (xmin < 0) xmin = 0;
    if (xmax > inSize) xmax = inSize;
    const idx = [];
    const wts = [];
    let sum = 0;
    for (let i = xmin; i < xmax; i++) {
      const w = lanczos3((i + 0.5 - center) / filterScale);
      if (w === 0) continue;
      idx.push(i); wts.push(w); sum += w;
    }
    if (sum === 0) { // degenerate: fall back to nearest source pixel
      const i = Math.min(inSize - 1, Math.max(0, Math.floor(center)));
      idx.push(i); wts.push(1); sum = 1;
    }
    for (let k = 0; k < wts.length; k++) wts[k] /= sum;
    coeffs.push({ idx, wts });
  }
  return coeffs;
}

/** Resize a w x h Float64 grayscale plane to outW x outH. */
function resizeGray(src, w, h, outW, outH) {
  // Horizontal pass (with uint8 rounding, like Pillow).
  const cx = resampleCoeffs(w, outW);
  const tmp = new Float64Array(outW * h);
  for (let y = 0; y < h; y++) {
    const rowOff = y * w, tmpOff = y * outW;
    for (let o = 0; o < outW; o++) {
      const { idx, wts } = cx[o];
      let acc = 0;
      for (let k = 0; k < idx.length; k++) acc += src[rowOff + idx[k]] * wts[k];
      tmp[tmpOff + o] = acc < 0 ? 0 : acc > 255 ? 255 : Math.round(acc);
    }
  }
  // Vertical pass.
  const cy = resampleCoeffs(h, outH);
  const out = new Float64Array(outW * outH);
  for (let o = 0; o < outH; o++) {
    const { idx, wts } = cy[o];
    const outOff = o * outW;
    for (let x = 0; x < outW; x++) {
      let acc = 0;
      for (let k = 0; k < idx.length; k++) acc += tmp[idx[k] * outW + x] * wts[k];
      out[outOff + x] = acc < 0 ? 0 : acc > 255 ? 255 : Math.round(acc);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * DCT-II — scipy.fftpack.dct(x, type=2, norm=None):
 *   y[k] = 2 * sum_n x[n] * cos(pi * k * (2n + 1) / (2N))
 * (uniform factor 2, including k = 0 — verified numerically against
 * scipy). Applied along columns then rows, as in imagehash.
 * ------------------------------------------------------------------ */
const COS = (() => {
  const N = IMG_SIZE;
  const m = new Float64Array(N * N);
  for (let k = 0; k < N; k++)
    for (let n = 0; n < N; n++)
      m[k * N + n] = 2 * Math.cos(Math.PI * k * (2 * n + 1) / (2 * N));
  return m;
})();

function dct2d(pix) {
  const N = IMG_SIZE;
  // axis=0: transform each column (vertical frequencies in rows).
  const tmp = new Float64Array(N * N);
  for (let x = 0; x < N; x++)
    for (let k = 0; k < N; k++) {
      let acc = 0;
      const koff = k * N;
      for (let n = 0; n < N; n++) acc += COS[koff + n] * pix[n * N + x];
      tmp[k * N + x] = acc;
    }
  // axis=1: transform each row.
  const out = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    const off = y * N;
    for (let k = 0; k < N; k++) {
      let acc = 0;
      const koff = k * N;
      for (let n = 0; n < N; n++) acc += COS[koff + n] * tmp[off + n];
      out[off + k] = acc;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Fingerprint a grayscale art window (any size) -> { hex, hi, lo, value }.
 * hi/lo are uint32 numbers; value is a BigInt; hex is the 16-char
 * imagehash-compatible string. Bit 0 (row 0, col 0 — the DC term) is the
 * most significant bit.
 */
function hashGrayWindow(gray, w, h) {
  const small = resizeGray(gray, w, h, IMG_SIZE, IMG_SIZE);
  const dct = dct2d(small);
  const low = [];
  for (let r = 0; r < HASH_SIZE; r++)
    for (let c = 0; c < HASH_SIZE; c++) low.push(dct[r * IMG_SIZE + c]);
  const sorted = [...low].sort((a, b) => a - b);
  const med = (sorted[31] + sorted[32]) / 2;   // numpy.median of 64 values
  let hex = '';
  let hi = 0, lo = 0;
  for (let i = 0; i < 64; i++) {
    const bit = low[i] > med ? 1 : 0;
    if (bit) {
      if (i < 32) hi |= (1 << (31 - i));
      else lo |= (1 << (63 - i));
    }
    if (i % 4 === 3) {
      let nib = 0;
      for (let j = i - 3; j <= i; j++) nib = (nib << 1) | (low[j] > med ? 1 : 0);
      hex += nib.toString(16);
    }
  }
  return { hex, hi: hi >>> 0, lo: lo >>> 0 };
}

/**
 * Fingerprint a full card image given as raw RGBA pixels.
 * rgba: Uint8Array/Buffer of length width*height*4.
 */
function hashCardImage(rgba, width, height) {
  const x0 = Math.trunc(ART_BOX[0] * width);
  const y0 = Math.trunc(ART_BOX[1] * height);
  const x1 = Math.trunc(ART_BOX[2] * width);
  const y1 = Math.trunc(ART_BOX[3] * height);
  const gray = grayFromRgba(rgba, x0, y0, x1 - x0, y1 - y0, width);
  return hashGrayWindow(gray, x1 - x0, y1 - y0);
}

/** Hamming distance between two hashes ({hi, lo} or hex strings). */
function hamming(a, b) {
  const pa = typeof a === 'string' ? hexToPair(a) : a;
  const pb = typeof b === 'string' ? hexToPair(b) : b;
  let x = (pa.hi ^ pb.hi) >>> 0, y = (pa.lo ^ pb.lo) >>> 0, n = 0;
  while (x) { x &= x - 1; n++; }
  while (y) { y &= y - 1; n++; }
  return n;
}

function hexToPair(hex) {
  const v = BigInt('0x' + hex);
  return { hi: Number((v >> 32n) & 0xffffffffn), lo: Number(v & 0xffffffffn) };
}

function pairToHex(hi, lo) {
  return ((BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0)).toString(16).padStart(16, '0');
}

global.Fingerprint = { ART_BOX, grayFromRgba, resizeGray, hashGrayWindow, hashCardImage, hamming, hexToPair, pairToHex };
})(window);
