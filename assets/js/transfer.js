// ═══════════════════════════════════════════════════════════════════════════════
// QRForge Transfer Engine v4 — fountain-coded
//
// This replaces the v3 sequential-chunk-with-server-rewind protocol with an LT
// (Luby transform) fountain code, ported from bashalarmistalt/decimen-optical-
// transfer (MIT) — https://github.com/bashalarmistalt/decimen-optical-transfer.
// Credit: Evan Crawley. The math in FOUNTAIN CORE below (dlog/solitonCdf/
// frameIndices/LTEncoder/LTDecoder, splitmix32, fnv1a, and the capacity/
// progress formulas) is a line-for-line port of shared/fountain.ts,
// shared/protocol.ts, shared/frame-capacity.ts and shared/progress.ts from
// that project, translated from TypeScript to plain JS so it can keep living
// in this repo's no-build static site. See docs/protocol.md in that repo for
// the original design writeup.
//
// WHY THIS REWRITE
// ─────────────────
// v3 sent the file as a strict sequence of (fileIndex, chunkIndex) chunks and
// depended on the receiver's ACK to tell the sender where to rewind to after a
// pause. Two things made that fragile in practice:
//
//   1. The rewind logic walked S.txFrames looking for the first frame whose
//      global `s` (a uint16, wraps at 65536) was greater than the acked seq.
//      For any transfer over ~65k chunks that comparison is ambiguous — many
//      frames share the same wrapped `s` — so a rewind on a large transfer
//      could silently resume at the wrong position.
//   2. Starting a transfer at all required a round trip through the
//      Cloudflare `/api/ack` relay before the sender would leave "waiting for
//      receiver". That's fine on a phone with mobile data, but on a genuinely
//      air-gapped laptop pair — the case this rewrite adds explicit support
//      for — there is no network path to that relay at all, so the sender
//      just sat in "Waiting for receiver…" until the 20s grace period, over
//      and over, on every settings change.
//   3. Live transmission's frame pacing used `setTimeout(fn, 1000/fps)` with
//      a hardcoded 30ms "paint delay" in renderQR(), while calibration used
//      double-`requestAnimationFrame` to actually confirm the frame had been
//      composited. The two paths measure different things, so a calibration
//      result didn't necessarily describe what the real transfer would do —
//      most visible on mobile GPUs where canvas compositing is asynchronous.
//
// Fountain coding fixes (1) and (2) structurally: the receiver reconstructs
// the file from ANY ~k·1.15 distinct frames in ANY order, so there is no
// rewind concept at all — pausing and resuming just means "stop and restart
// the same monotonic seq counter". And because every frame is fully self-
// describing (session id, k, block length, total length all live in a 20-byte
// header on every frame), the sender never needs to hear from the receiver
// before it starts, which is what makes a genuine no-network airgap mode
// possible. (3) is fixed by giving calibration and live transmission the
// exact same rAF-driven, double-rAF-confirmed render path.
//
// TWO LINK MODES
// ──────────────
// Airgap    — no network calls at all, on either device. Sender starts
//             streaming immediately; receiver locks onto the stream the
//             moment its camera sees a valid frame, whenever that happens.
//             No join link (there's nowhere to serve it from), no ACK, no
//             Discord logging.
// Networked — same optical stream, PLUS the existing /api/ack relay is used
//             for a join-link QR and a one-way receiver→sender progress/fps
//             readout. Crucially, ACK is now advisory only: losing it just
//             means the sender's on-screen "receiver progress" readout goes
//             stale, not that the transfer stalls. This is the mode phones
//             on normal networks want.
//
// WIRE FORMAT
// ───────────
// Each QR encodes base64url( 20-byte binary header || fountain block ).
// Header (little-endian, ported verbatim from decimen's protocol.ts):
//   0  u8   magic 0xD1
//   1  u8   magic 0x0C
//   2  u16  sessionId    random per Start click
//   4  u32  seq          drives the fountain PRNG — monotonic, never resets
//   8  u16  k            source block count
//  10  u16  blockLen     payload bytes per frame
//  12  u32  totalLen     length of the packed container, in bytes
//  16  u32  payloadFnv   FNV-1a of the whole container
//
// The "container" fountain-coded inside is QRForge's own multi-file format
// (see CONTAINER below) — decimen's is single-file; this keeps the up-to-100-
// files feature. Directory entries + concatenated file bytes are all part of
// the SAME fountain stream, so — same tradeoff decimen makes — filenames
// aren't known until the stream is almost fully decoded. totalLen/k/blockLen
// ARE known from frame one, so the receiver can show "~230 KB incoming" long
// before it knows what's inside.
//
// PRACTICAL SIZE CEILING
// ───────────────────────
// `k` is a u16 in the frame header (max 65535 blocks), so the real ceiling is
// `blockLen × 65535`, not the old flat "1 GB" claim (which the uint16 global
// `s` in v3 could never honestly reach without wrapping many times over
// anyway — see point 1 above). At the largest chunk preset that fits a
// version-40-H QR through this app's base64url text encoding (~934 bytes),
// that's ~61 MB. Start validates this up front — like decimen's
// frame-capacity.ts — and tells you which preset would fit, instead of
// failing partway through a multi-hour transfer.
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_FILES         = 100;
const QR_PX              = 380;
const QR_MAX_CHARS       = 1273;                              // qrcode.js v40-H byte-mode capacity
const QR_MAX_WIRE_BYTES  = Math.floor(QR_MAX_CHARS * 3 / 4);  // raw bytes that fit once base64url'd
const HEADER_LEN         = 20;
const MAX_SOURCE_BLOCKS  = 0xffff;                              // k is a u16 on the wire
const QR_MAX_CHUNK_BYTES = QR_MAX_WIRE_BYTES - HEADER_LEN;     // largest legal blockLen

const CHUNK_PRESETS      = { s: 80, m: 220, l: 460, xl: 820 };
const CHUNK_AUTO_DEFAULT = 220;
const PRESET_LIST        = Object.values(CHUNK_PRESETS);

// Networked-mode ACK (advisory only — see header comment)
const ACK_POLL_MS   = 1500;
const ACK_COMPLETE_SENTINEL = 0xFFFFFF; // largest seq /api/ack accepts; means "receiver is done"

// Calibration — now runs the exact frame-render path live transmission uses.
const CAL_SIZES           = [80, 150, 220, 360, 500, 680, 820];
const CAL_FPS_TARGET      = 8;
const CAL_FRAMES_PER_SIZE = 6;

const NO_COMPRESS_EXT = new Set([
  'zip','gz','bz2','xz','7z','rar','zst','br',
  'jpg','jpeg','png','gif','webp','avif','heic','heif',
  'mp4','mov','avi','mkv','webm','m4v',
  'mp3','aac','ogg','flac','m4a','opus','pdf',
]);

// ═══════════════════════════════════════════════════════════════════════════════
// FOUNTAIN CORE — ported from decimen-optical-transfer/shared/fountain.ts
// and shared/protocol.ts (MIT, Evan Crawley). Wire-format code: do not touch
// the arithmetic in dlog/solitonCdf/frameIndices/splitmix32 without also
// updating BOTH sender and receiver — see the determinism warning below.
// ═══════════════════════════════════════════════════════════════════════════════

const LN2 = 0.6931471805599453;

/**
 * Deterministic natural log (exact-ops range reduction + atanh series).
 *
 * `Math.log` is only implementation-approximated by spec, and V8 (desktop
 * Chrome sender) vs JavaScriptCore (an iPhone receiver) can differ by an ulp
 * on a meaningful fraction of the inputs this feeds into solitonCdf(). That's
 * enough to shift a CDF entry and flip a sampled degree, which desyncs the
 * sender's and receiver's PRNGs — a silent, total decode failure with no
 * error message. This is exactly the kind of bug that would look like
 * "calibration and transfer just don't want to work" for no visible reason,
 * so it's ported byte-for-byte rather than swapped for Math.log.
 */
function dlog(x) {
  let e = 0, m = x;
  while (m >= 1.5) { m /= 2; e++; }
  while (m < 0.75) { m *= 2; e--; }
  const z = (m - 1) / (m + 1);
  const z2 = z * z;
  let term = z, sum = 0;
  for (let n = 1; n <= 21; n += 2) { sum += term / n; term *= z2; }
  return e * LN2 + 2 * sum;
}

const SOLITON_C = 0.1;
const SOLITON_DELTA = 0.5;

/** Robust-soliton degree CDF for k source blocks. */
function solitonCdf(k) {
  const cdf = new Float64Array(k);
  if (k === 1) { cdf[0] = 1; return cdf; }
  const R = Math.max(1, SOLITON_C * dlog(k / SOLITON_DELTA) * Math.sqrt(k));
  const spike = Math.min(k, Math.ceil(k / R));
  let total = 0;
  for (let d = 1; d <= k; d++) {
    const rho = d === 1 ? 1 / k : 1 / (d * (d - 1));
    let tau = 0;
    if (d < spike) tau = R / (d * k);
    else if (d === spike) tau = (R * Math.max(0, dlog(R / SOLITON_DELTA))) / k;
    total += rho + tau;
    cdf[d - 1] = total;
  }
  for (let i = 0; i < k; i++) cdf[i] = cdf[i] / total;
  cdf[k - 1] = 1;
  return cdf;
}

/** splitmix32 — integer-only ops, deterministic across every JS engine. */
function splitmix32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let t = s ^ (s >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

function frameSeed(sessionId, seq) {
  let h = (Math.imul(sessionId + 1, 0x9e3779b1) ^ (seq + 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) | 0;
}

/** Block indices XORed into frame `seq` — identical derivation on both ends. */
function frameIndices(k, cdf, sessionId, seq) {
  const rnd = splitmix32(frameSeed(sessionId, seq));
  const u = rnd() * 2 ** -32;
  let lo = 0, hi = k - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] >= u) hi = mid; else lo = mid + 1;
  }
  const d = Math.min(k, lo + 1);
  if (d > k >> 3) {
    const scratch = new Uint32Array(k);
    for (let i = 0; i < k; i++) scratch[i] = i;
    const out = new Array(d);
    for (let i = 0; i < d; i++) {
      const j = i + (rnd() % (k - i));
      const t = scratch[i]; scratch[i] = scratch[j]; scratch[j] = t;
      out[i] = scratch[i];
    }
    return out;
  }
  const set = new Set();
  while (set.size < d) set.add(rnd() % k);
  return [...set];
}

function xorInto(dst, src) { for (let i = 0; i < dst.length; i++) dst[i] = (dst[i] ^ src[i]) >>> 0; }

class LTEncoder {
  constructor(payload, blockLen, sessionId) {
    this.blockLen = blockLen;
    this.sessionId = sessionId;
    this.k = Math.max(1, Math.ceil(payload.length / blockLen));
    this.words = Math.ceil(blockLen / 4);
    this.blocks = new Uint32Array(this.k * this.words);
    const bytes = new Uint8Array(this.blocks.buffer);
    for (let b = 0; b < this.k; b++) {
      const src = payload.subarray(b * blockLen, Math.min((b + 1) * blockLen, payload.length));
      bytes.set(src, b * this.words * 4);
    }
    this.cdf = solitonCdf(this.k);
  }
  encode(seq) {
    const idx = frameIndices(this.k, this.cdf, this.sessionId, seq);
    const out = new Uint32Array(this.words);
    for (const b of idx) {
      const off = b * this.words;
      for (let w = 0; w < this.words; w++) out[w] = (out[w] ^ this.blocks[off + w]) >>> 0;
    }
    return new Uint8Array(out.buffer, 0, this.blockLen);
  }
}

class LTDecoder {
  constructor(k, blockLen, sessionId, totalLen) {
    this.k = k; this.blockLen = blockLen; this.sessionId = sessionId; this.totalLen = totalLen;
    this.words = Math.ceil(blockLen / 4);
    this.cdf = solitonCdf(k);
    this.solved = new Array(k).fill(null);
    this.byBlock = new Map();
    this.seen = new Set();
    this.solvedCount = 0;
    this.framesNew = 0;
    this.framesDup = 0;
  }
  get isComplete() { return this.solvedCount >= this.k; }
  addFrame(seq, block) {
    if (this.seen.has(seq)) { this.framesDup++; return; }
    this.seen.add(seq);
    this.framesNew++;
    if (this.isComplete) return;
    const idx = new Set(frameIndices(this.k, this.cdf, this.sessionId, seq));
    const words = new Uint32Array(this.words);
    new Uint8Array(words.buffer).set(block.subarray(0, this.blockLen));
    for (const b of [...idx]) {
      const s = this.solved[b];
      if (s) { xorInto(words, s); idx.delete(b); }
    }
    if (idx.size === 0) return; // fully redundant
    if (idx.size === 1) { this.resolve(idx.values().next().value, words); return; }
    const pf = { idx, words };
    for (const b of idx) {
      let set = this.byBlock.get(b);
      if (!set) { set = new Set(); this.byBlock.set(b, set); }
      set.add(pf);
    }
  }
  /** Peeling cascade. Note for progress UX: solved-block count back-loads —
   *  it hockey-sticks near the end while frame arrival is linear. Progress
   *  below is driven off framesNew, not solvedCount, for exactly this reason. */
  resolve(b0, w0) {
    const queue = [[b0, w0]];
    while (queue.length > 0) {
      const [b, w] = queue.pop();
      if (this.solved[b]) continue;
      this.solved[b] = w;
      this.solvedCount++;
      const waiting = this.byBlock.get(b);
      if (!waiting) continue;
      this.byBlock.delete(b);
      for (const pf of waiting) {
        xorInto(pf.words, w);
        pf.idx.delete(b);
        if (pf.idx.size === 1) {
          const r = pf.idx.values().next().value;
          this.byBlock.get(r)?.delete(pf);
          if (!this.solved[r]) queue.push([r, pf.words]);
        }
      }
    }
  }
  assemble() {
    if (!this.isComplete) return null;
    const out = new Uint8Array(this.totalLen);
    for (let b = 0; b < this.k; b++) {
      const start = b * this.blockLen;
      const len = Math.min(this.blockLen, this.totalLen - start);
      if (len > 0) out.set(new Uint8Array(this.solved[b].buffer, 0, len), start);
    }
    return out;
  }
}

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ─── Frame header pack/parse (ported from protocol.ts) ─────────────────────────
function packFrame(h, block) {
  const out = new Uint8Array(HEADER_LEN + block.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, 0xd1);
  dv.setUint8(1, 0x0c);
  dv.setUint16(2, h.sessionId, true);
  dv.setUint32(4, h.seq, true);
  dv.setUint16(8, h.k, true);
  dv.setUint16(10, h.blockLen, true);
  dv.setUint32(12, h.totalLen, true);
  dv.setUint32(16, h.payloadFnv, true);
  out.set(block, HEADER_LEN);
  return out;
}

function parseFrame(bytes) {
  if (bytes.length <= HEADER_LEN) return null;
  if (bytes[0] !== 0xd1 || bytes[1] !== 0x0c) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = {
    sessionId:  dv.getUint16(2, true),
    seq:        dv.getUint32(4, true),
    k:          dv.getUint16(8, true),
    blockLen:   dv.getUint16(10, true),
    totalLen:   dv.getUint32(12, true),
    payloadFnv: dv.getUint32(16, true),
  };
  if (header.k === 0 || header.blockLen === 0 || header.totalLen === 0) return null;
  if (bytes.length !== HEADER_LEN + header.blockLen) return null;
  return { header, block: bytes.subarray(HEADER_LEN) };
}

/** Everything that must hold constant for a decoder to keep accepting frames.
 *  `seq` is deliberately absent. Any disagreement resets the decoder — not
 *  just a session id mismatch, since session ids are only 16 bits and a
 *  collision across an unrelated restart is rare but real. */
function streamIdentity(h) {
  return `${h.sessionId}:${h.k}:${h.blockLen}:${h.totalLen}:${h.payloadFnv}`;
}

// ─── Capacity math (ported from frame-capacity.ts) ──────────────────────────────
function blockLength(frameBytes) { return frameBytes - HEADER_LEN; }
function sourceBlockCount(payloadBytes, frameBytes) { return Math.ceil(payloadBytes / blockLength(frameBytes)); }
function fitsInOneStream(payloadBytes, frameBytes) { return sourceBlockCount(payloadBytes, frameBytes) <= MAX_SOURCE_BLOCKS; }
function minimumFrameBytes(payloadBytes) { return Math.ceil(payloadBytes / MAX_SOURCE_BLOCKS) + HEADER_LEN; }
function smallestSufficientFrameSize(payloadBytes, options) {
  const minimum = minimumFrameBytes(payloadBytes);
  return options.filter(v => v >= minimum).sort((a, b) => a - b)[0];
}

// ─── Progress estimation (ported from progress.ts) ──────────────────────────────
function expectedFountainOverhead(sourceBlocks) {
  const k = Math.max(1, sourceBlocks);
  return Math.min(1.6, Math.max(1.15, 1.1 + 2.45 / Math.sqrt(k)));
}
function estimateProgress(k, framesNew, elapsedSeconds) {
  const minimum = Math.max(1, k);
  const expected = Math.max(minimum + 1, Math.ceil(minimum * expectedFountainOverhead(minimum)));
  const redundancy = expected - minimum;
  let fraction;
  if (framesNew < minimum) fraction = 0.86 * (framesNew / minimum);
  else if (framesNew <= expected) fraction = 0.86 + 0.1 * ((framesNew - minimum) / redundancy);
  else fraction = 0.96 + 0.03 * (1 - Math.exp(-(framesNew - expected) / redundancy));
  fraction = Math.min(0.99, fraction);
  const rate = elapsedSeconds > 0 ? framesNew / elapsedSeconds : 0;
  const etaSeconds = framesNew >= 3 && elapsedSeconds >= 1 && rate > 0 ? Math.max(0, (expected - framesNew) / rate) : undefined;
  return { fraction, expected, etaSeconds };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTAINER — QRForge's own multi-file format, fountain-coded as one payload.
// decimen's packFile() is single-item; this adds a directory so up to
// MAX_FILES files travel as one LT stream. Per-file gzip via pako, matching
// v3's compression heuristic.
//
//   MAGIC 'Q','R','F','2'                4 bytes
//   fileCount                            u16
//   per file, fileCount times:
//     nameLen u16, name (utf8)
//     typeLen u16, type (utf8, currently unused but reserved)
//     compressed u8
//     originalSize u32
//     transmittedSize u32
//     sha256                             32 bytes
//   blob: transmittedBytes for each file, in directory order
// ═══════════════════════════════════════════════════════════════════════════════

const CONTAINER_MAGIC = new Uint8Array([0x51, 0x52, 0x46, 0x32]); // "QRF2"
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function packContainer(fileEntries, compressMode) {
  const dirParts = [];
  const blobParts = [];
  let dirLen = 0;

  for (const f of fileEntries) {
    let data = f.bytes;
    let compressed = false;
    if (compressMode !== 'off') {
      const ext = f.name.split('.').pop().toLowerCase();
      if ((compressMode === 'on' || !NO_COMPRESS_EXT.has(ext)) && typeof pako !== 'undefined' && data.length > 32) {
        try {
          const c = pako.deflate(data, { level: 6 });
          if (c.length < data.length * 0.92) { data = c; compressed = true; }
        } catch (_) { /* fall through uncompressed */ }
      }
    }
    const nameBytes = textEncoder.encode(f.name);
    const typeBytes = textEncoder.encode(f.type || '');
    const hashBuf = await crypto.subtle.digest('SHA-256', f.bytes);
    const sha256 = new Uint8Array(hashBuf);

    const head = new Uint8Array(2 + nameBytes.length + 2 + typeBytes.length + 1 + 4 + 4 + 32);
    const dv = new DataView(head.buffer);
    let o = 0;
    dv.setUint16(o, nameBytes.length, true); o += 2;
    head.set(nameBytes, o); o += nameBytes.length;
    dv.setUint16(o, typeBytes.length, true); o += 2;
    head.set(typeBytes, o); o += typeBytes.length;
    dv.setUint8(o, compressed ? 1 : 0); o += 1;
    dv.setUint32(o, f.bytes.length, true); o += 4;
    dv.setUint32(o, data.length, true); o += 4;
    head.set(sha256, o);

    dirParts.push(head);
    dirLen += head.length;
    blobParts.push(data);
  }

  const dirHeader = new Uint8Array(4 + 2);
  dirHeader.set(CONTAINER_MAGIC, 0);
  new DataView(dirHeader.buffer).setUint16(4, fileEntries.length, true);

  const totalLen = dirHeader.length + dirLen + blobParts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(totalLen);
  let off = 0;
  out.set(dirHeader, off); off += dirHeader.length;
  for (const d of dirParts) { out.set(d, off); off += d.length; }
  for (const b of blobParts) { out.set(b, off); off += b.length; }
  return out;
}

async function unpackContainer(container) {
  if (container.length < 6) throw new Error('Container too short');
  for (let i = 0; i < 4; i++) if (container[i] !== CONTAINER_MAGIC[i]) throw new Error('Bad container magic');
  const dv0 = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const fileCount = dv0.getUint16(4, true);
  if (fileCount < 1 || fileCount > MAX_FILES) throw new Error('Bad file count');

  let o = 6;
  const dirs = [];
  for (let i = 0; i < fileCount; i++) {
    const dv = new DataView(container.buffer, container.byteOffset + o, container.byteLength - o);
    const nameLen = dv.getUint16(0, true);
    let p = 2;
    const name = sanitiseFilename(textDecoder.decode(container.subarray(o + p, o + p + nameLen))); p += nameLen;
    const typeLen = dv.getUint16(p, true); p += 2;
    const type = textDecoder.decode(container.subarray(o + p, o + p + typeLen)); p += typeLen;
    const compressed = dv.getUint8(p) === 1; p += 1;
    const originalSize = dv.getUint32(p, true); p += 4;
    const transmittedSize = dv.getUint32(p, true); p += 4;
    const sha256 = container.slice(o + p, o + p + 32); p += 32;
    dirs.push({ name, type, compressed, originalSize, transmittedSize, sha256 });
    o += p;
  }

  const files = [];
  for (const d of dirs) {
    if (o + d.transmittedSize > container.length) throw new Error('Container truncated');
    let bytes = container.slice(o, o + d.transmittedSize);
    o += d.transmittedSize;
    if (d.compressed) {
      try { bytes = pako.inflate(bytes); } catch (e) { throw new Error(`Decompress failed for ${d.name}: ${e.message}`); }
    }
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
    const hashHex = bufHex(hashBuf);
    const expectedHex = Array.from(d.sha256).map(b => b.toString(16).padStart(2, '0')).join('');
    files.push({ name: d.name, type: d.type, size: d.originalSize, bytes, hash: hashHex, valid: hashHex === expectedHex, expectedHash: expectedHex });
  }
  return files;
}

function sanitiseFilename(name) {
  return String(name).replace(/.*[/\\]/, '').replace(/[^\w.\-() ]/g, '_').slice(0, 200) || 'file';
}

// ─── Mutable state ────────────────────────────────────────────────────────────
let S = makeState();

function makeState() {
  return {
    mode: 'send',
    linkMode: (typeof navigator !== 'undefined' && navigator.onLine === false) ? 'airgap' : 'networked',
    // TX
    files: [], totalBytes: 0,
    sessionIdStr: randomId(8),     // human/URL session id (networked join link, Discord logging)
    txActive: false, txPaused: false,
    txEncoder: null, txHeaderBase: null, txSeq: 0, txStart: null,
    txFps: 4, txChunkBytes: CHUNK_AUTO_DEFAULT,
    txRafId: null, txNextAt: 0,
    calRunning: false,
    // Networked-mode ACK telemetry (advisory only — never gates correctness)
    txAckPollTimer: null, txLastAckSeq: -1, txLastAckFps: null, txLastAckTs: 0, txReceiverComplete: false,
    // RX
    rxExpectedSid: null,
    rxStream: null, rxFacingMode: 'environment',
    rxAnimFrame: null, rxLastScan: 0, rxScanMs: 1000 / 15,
    rxScanCanvas: null, rxScanCtx: null, rxDetector: null,
    rxDecoder: null, rxIdentity: null, rxStart: null,
    rxDecodedCount: 0, rxAcksSent: 0, rxLastMeasuredFps: null, rxScanTimes: [],
    rxDone: false,
  };
}

// ─── Mode / link-mode ────────────────────────────────────────────────────────
function setMode(m) {
  S.mode = m;
  el('sendPanel').style.display    = m === 'send'    ? 'block' : 'none';
  el('receivePanel').style.display = m === 'receive' ? 'block' : 'none';
  el('btnSend').className    = `btn ${m==='send'    ? 'btn-primary' : 'btn-secondary'}`;
  el('btnReceive').className = `btn ${m==='receive' ? 'btn-primary' : 'btn-secondary'}`;
}

function setLinkMode(m) {
  S.linkMode = m;
  const airgap = m === 'airgap';
  const btnAir = el('btnLinkAirgap'), btnNet = el('btnLinkNetworked');
  if (btnAir) btnAir.className = `btn btn-sm ${airgap ? 'btn-primary' : 'btn-ghost'}`;
  if (btnNet) btnNet.className = `btn btn-sm ${!airgap ? 'btn-primary' : 'btn-ghost'}`;
  const hint = el('linkModeHint');
  if (hint) hint.textContent = airgap
    ? 'No network calls on either device. Point the receiver at this screen — it locks on as soon as it sees a frame.'
    : 'Uses the QRForge server as a one-way progress relay (never required for correctness). Share the join link or QR below.';
  if (S.mode === 'send' && !S.txActive) showJoinQR();
}

// ─── File handling ─────────────────────────────────────────────────────────────
async function handleFiles(fileList) {
  const arr = Array.from(fileList);
  if (S.files.length + arr.length > MAX_FILES) {
    toast(`Max ${MAX_FILES} files per session`, 'warn'); return;
  }
  for (const f of arr) {
    S.totalBytes += f.size;
    S.files.push({ file: f, name: sanitiseFilename(f.name), size: f.size, type: f.type,
                   hash: null, compressed: false });
  }
  renderFileList();
  await hashAllFiles();
  updateSummary();
  el('btnStart').disabled = S.files.length === 0;
  if (S.files.length > 0) advanceStep(2);
  else advanceStep(1);
}

function removeFile(i) {
  S.totalBytes -= S.files[i].size;
  S.files.splice(i, 1);
  renderFileList();
  updateSummary();
  el('btnStart').disabled = S.files.length === 0;
  if (S.files.length > 0) advanceStep(2);
  else { advanceStep(1); showJoinQR(); }
}

function renderFileList() {
  const list = el('fileList');
  if (S.files.length === 0) { list.innerHTML = ''; return; }
  list.innerHTML = S.files.map((f, i) => `
    <div class="file-item">
      <span class="file-item-icon">${fileIcon(f.name)}</span>
      <span class="file-item-name" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="file-item-size">${fmtBytes(f.size)}</span>
      ${f.hash
        ? `<span class="badge badge-success" title="SHA-256: ${f.hash}">✓</span>`
        : `<span class="badge badge-muted">⋯</span>`}
      <button class="file-item-remove" onclick="removeFile(${i})" aria-label="Remove">✕</button>
    </div>
  `).join('');
  el('fileSummary').style.display = 'block';
}

async function hashAllFiles() {
  for (let i = 0; i < S.files.length; i++) {
    if (S.files[i].hash) continue;
    const buf = await S.files[i].file.arrayBuffer();
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    S.files[i].hash = bufHex(hashBuf);
    S.files[i]._buf = buf;
    renderFileList();
  }
}

function updateSummary() {
  const chunkBytes = getChunkBytes();
  // Rough directory overhead estimate so the frame count shown before Start
  // is in the right ballpark (exact figure appears once the encoder builds).
  const dirEstimate = 6 + S.files.length * 80;
  const payloadEstimate = S.totalBytes + dirEstimate;
  const k = Math.max(1, Math.ceil(payloadEstimate / chunkBytes));
  const expectedFrames = Math.ceil(k * expectedFountainOverhead(k));
  const fps = parseInt(el('fpsSlider').value) || 4;
  el('statFiles').textContent  = S.files.length;
  el('statSize').textContent   = fmtBytes(S.totalBytes);
  el('statChunks').textContent = expectedFrames.toLocaleString() + ' (est.)';
  el('statETA').textContent    = fmtDur(expectedFrames / fps);
}

function updateETA() { updateSummary(); }
function getChunkBytes() {
  const mode = el('chunkMode').value;
  const raw = mode === 'auto' ? S.txChunkBytes : (CHUNK_PRESETS[mode] || CHUNK_AUTO_DEFAULT);
  return Math.min(raw, QR_MAX_CHUNK_BYTES);
}

// ─── Unified frame renderer — the ONE code path calibration and live TX both
// use, so a calibration result actually describes what transmission will do.
// Waits for a confirmed composite (double-rAF), not a guessed setTimeout. ────
let _qrContainer = null;
function renderQrText(text) {
  const out = el('qrOut');
  if (!_qrContainer) { _qrContainer = document.createElement('div'); out.innerHTML = ''; out.appendChild(_qrContainer); }
  _qrContainer.innerHTML = '';
  try {
    new QRCode(_qrContainer, { text, width: QR_PX, height: QR_PX, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.H });
  } catch (e) {
    _qrContainer.innerHTML = `<div style="width:${QR_PX}px;height:${QR_PX}px;display:flex;align-items:center;justify-content:center;
      background:#1a0000;border:2px solid #ff4444;border-radius:8px;color:#ff4444;font-size:13px;text-align:center;padding:16px;box-sizing:border-box;">
      ⚠ Frame too large<br><small>Reduce chunk size</small></div>`;
    return Promise.resolve(false);
  }
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));
}

// ─── Calibration (local-only: measures THIS device's own render throughput;
// never waits on or depends on the receiver or the network) ────────────────────
async function runCalibration() {
  if (S.calRunning) return;
  S.calRunning = true;
  setTxBadge('Calibrating…', 'warn');

  const timings = [];
  for (const sz of CAL_SIZES) {
    const safeSz = Math.min(sz, QR_MAX_CHUNK_BYTES);
    const probe = packFrame({ sessionId: 1, seq: timings.length, k: 1, blockLen: safeSz, totalLen: safeSz, payloadFnv: 0 }, randomBytes(safeSz));
    const text = u8ToB64url(probe);
    for (let j = 0; j < CAL_FRAMES_PER_SIZE; j++) {
      const t0 = performance.now();
      await renderQrText(text);
      const t1 = performance.now();
      timings.push({ sz: safeSz, ms: t1 - t0 });
      const rem = 1000 / CAL_FPS_TARGET - (t1 - t0);
      if (rem > 0) await sleep(rem);
    }
  }

  const bySize = {};
  for (const { sz, ms } of timings) (bySize[sz] = bySize[sz] || []).push(ms);
  const safeSizes = CAL_SIZES.filter(sz => sz <= QR_MAX_CHUNK_BYTES);
  let bestSz = safeSizes[0] || 80;
  for (const sz of safeSizes) if (median(bySize[sz] || [999]) <= 160) bestSz = sz;

  const medMs = median(bySize[bestSz] || [250]);
  S.txChunkBytes = bestSz;
  S.txFps = Math.max(1, Math.min(Math.floor(1000 / medMs * 0.8), 15));

  el('fpsSlider').value      = S.txFps;
  el('fpsLabel').textContent = S.txFps;
  el('calFps').textContent   = S.txFps;
  el('calBps').textContent   = fmtBytes(bestSz * S.txFps) + '/s';
  el('calChunk').textContent = bestSz + 'B';
  el('calibResult').style.display = 'block';
  S.calRunning = false;
  updateSummary();
}

// ─── Transmission ──────────────────────────────────────────────────────────────
async function startTransmission() {
  if (S.txActive || S.files.length === 0) return;
  el('btnStart').disabled = true;
  advanceStep(2);

  await runCalibration();
  S.txFps = parseInt(el('fpsSlider').value) || 4;
  S.txChunkBytes = getChunkBytes();

  toast('Packing files…', 'info');
  const container = await packContainer(
    S.files.map(f => ({ name: f.name, type: f.type, bytes: new Uint8Array(f._buf) })),
    el('compressMode').value,
  );

  const frameBytes = S.txChunkBytes + HEADER_LEN;
  if (!fitsInOneStream(container.length, frameBytes)) {
    const offered = PRESET_LIST.filter(v => v <= QR_MAX_CHUNK_BYTES).map(v => v + HEADER_LEN);
    const suggestion = smallestSufficientFrameSize(container.length, offered);
    const need = sourceBlockCount(container.length, frameBytes).toLocaleString();
    el('btnStart').disabled = false;
    toast(
      suggestion
        ? `${fmtBytes(container.length)} needs ${need} blocks at this chunk size — raise Chunk Size to fit ${suggestion - HEADER_LEN}B blocks or larger.`
        : `${fmtBytes(container.length)} is too large for a single optical stream (ceiling ≈ ${fmtBytes(QR_MAX_CHUNK_BYTES * MAX_SOURCE_BLOCKS)}). Remove some files.`,
      'danger',
    );
    advanceStep(S.files.length > 0 ? 2 : 1);
    return;
  }

  const blockLen = blockLength(frameBytes);
  const sessionId = randomU16();
  const encoder = new LTEncoder(container, blockLen, sessionId);
  S.txEncoder = encoder;
  S.txHeaderBase = { sessionId, k: encoder.k, blockLen, totalLen: container.length, payloadFnv: fnv1a(container) };
  S.txSeq = 0;
  S.txActive = true;
  S.txPaused = false;
  S.txStart = Date.now();
  S.txLastAckSeq = -1;
  S.txLastAckFps = null;
  S.txReceiverComplete = false;

  advanceStep(3);
  el('txProgressWrap').style.display = 'block';
  el('txCtrlCard').style.display     = 'block';
  renderChecksums();

  if (S.linkMode === 'networked') {
    logToDiscord('send');
    showJoinQR();
    startAckPolling();
    // Courtesy window: show the join QR/link for a few seconds so a receiver
    // with the page open can scan it, THEN start the endless data stream —
    // but never block on it. A receiver that joins mid-stream still works.
    setTxBadge('Starting…', 'info');
    await sleep(1800);
  } else {
    setTxBadge('Streaming (airgap)', 'info');
  }

  el('joinQrCaption').style.display = 'none';
  scheduleTxLoop();
}

function scheduleTxLoop() {
  S.txNextAt = performance.now();
  const tick = (now) => {
    if (!S.txActive) return;
    S.txRafId = requestAnimationFrame(tick);
    if (S.txPaused) return;
    if (now < S.txNextAt) return;
    txEmitNextFrame();
    const interval = 1000 / S.txFps;
    S.txNextAt += interval;
    if (now - S.txNextAt > 3 * interval) S.txNextAt = now + interval; // fell behind — don't burst
  };
  S.txRafId = requestAnimationFrame(tick);
}

async function txEmitNextFrame() {
  const seq = S.txSeq++;
  const block = S.txEncoder.encode(seq);
  const bytes = packFrame({ ...S.txHeaderBase, seq }, block);
  const text = u8ToB64url(bytes);
  await renderQrText(text);
  updateTxProgress(seq);
}

function updateTxProgress(seq) {
  const k = S.txHeaderBase.k;
  const elapsed = (Date.now() - S.txStart) / 1000;
  const est = estimateProgress(k, seq + 1, elapsed);
  const pct = Math.round(est.fraction * 100);
  el('txFrameLabel').textContent = `Frame ${seq + 1} · k=${k}`;
  el('txPct').textContent = `${pct}%`;
  el('txBar').style.width = `${pct}%`;
  el('txElapsed').textContent = `${fmtDur(elapsed)} elapsed`;
  el('txETA').textContent = S.txReceiverComplete ? 'Receiver complete ✓'
    : est.etaSeconds !== undefined ? `ETA (this device): ${fmtDur(est.etaSeconds)}` : 'Streaming…';

  if (S.linkMode === 'networked') {
    const ackPct = S.txLastAckSeq >= 0 && !S.txReceiverComplete
      ? Math.min(100, Math.round(estimateProgress(k, S.txLastAckSeq + 1, elapsed).fraction * 100))
      : (S.txReceiverComplete ? 100 : 0);
    el('txAckBar').style.width = `${ackPct}%`;
    setTxBadge(S.txReceiverComplete ? 'Receiver complete ✓' : (S.txLastAckSeq >= 0 ? `Receiver ~${ackPct}%` : 'Streaming — no receiver yet'), S.txReceiverComplete ? 'success' : 'info');
  } else {
    el('txAckBar').style.width = '0%';
    setTxBadge('Streaming (airgap)', 'info');
  }
}

function togglePause() {
  if (!S.txActive) return;
  S.txPaused = !S.txPaused;
  el('btnPause').textContent = S.txPaused ? '▶ Resume' : '⏸ Pause';
  setTxBadge(S.txPaused ? 'Paused' : 'Streaming', S.txPaused ? 'warn' : 'info');
  // Resuming needs nothing else: the seq counter just keeps counting from
  // where it left off. There is no rewind, because there is nothing to
  // rewind to — every frame is independently useful to the decoder.
  if (!S.txPaused) S.txNextAt = performance.now();
}

function stopTx() {
  S.txActive = false;
  if (S.txRafId) cancelAnimationFrame(S.txRafId);
  stopAckPolling();

  const prevFiles = S.files, prevTotal = S.totalBytes;
  S = makeState();
  S.files = prevFiles; S.totalBytes = prevTotal;

  el('txCtrlCard').style.display     = 'none';
  el('txProgressWrap').style.display = 'none';
  el('checksumPanel').style.display  = 'none';
  el('calibResult').style.display    = 'none';
  el('btnPause').textContent         = '⏸ Pause';
  el('btnStart').disabled            = S.files.length === 0;
  advanceStep(S.files.length > 0 ? 2 : 1);
  setLinkMode(S.linkMode);
  showJoinQR();
}

function renderChecksums() {
  el('checksumPanel').style.display = 'block';
  el('checksumList').innerHTML = S.files.map(f =>
    `<div>
      <div style="font-size:0.72rem;color:var(--text-muted);font-family:var(--font-mono);margin-bottom:2px">${esc(f.name)}</div>
      <div class="hash-display valid">${f.hash}</div>
     </div>`
  ).join('');
}

// ─── ACK polling (sender side, networked mode only, advisory) ──────────────────
function startAckPolling() {
  stopAckPolling();
  S.txAckPollTimer = setInterval(pollAck, ACK_POLL_MS);
}
function stopAckPolling() {
  if (S.txAckPollTimer) { clearInterval(S.txAckPollTimer); S.txAckPollTimer = null; }
}
async function pollAck() {
  if (!S.txActive || S.linkMode !== 'networked') { stopAckPolling(); return; }
  try {
    const r = await fetch(`/api/ack?sid=${encodeURIComponent(S.sessionIdStr)}`);
    if (!r.ok) return;
    const data = await r.json();
    if (typeof data.seq !== 'number') return;
    if (data.seq === ACK_COMPLETE_SENTINEL) { S.txReceiverComplete = true; return; }
    S.txLastAckSeq = data.seq;
    S.txLastAckTs = Date.now();
    if (typeof data.fps === 'number' && data.fps > 0) S.txLastAckFps = data.fps;
  } catch (_) { /* advisory only — a dropped poll changes nothing about the stream */ }
}

// ─── QR Renderer for the static join-link code (networked mode only) ──────────
function showJoinQR() {
  if (S.linkMode !== 'networked') {
    const jc = el('joinQrCaption'); if (jc) jc.style.display = 'none';
    el('qrOut').innerHTML = `<div style="padding:40px 16px;text-align:center;color:var(--text-muted);font-size:0.85rem">
      Airgap mode — no join link. Switch the receiving device to <b>Receive</b> and point it at this screen once you hit Send.</div>`;
    setTxBadge('Airgap — ready', 'info');
    return;
  }
  const joinUrl = `${location.origin}${location.pathname}?sid=${S.sessionIdStr}`;
  el('sessionIdBadge').textContent = `Session: ${S.sessionIdStr}`;
  el('sessionBadge').style.display = 'flex';
  const out = el('qrOut');
  out.innerHTML = '';
  const wrap = document.createElement('div');
  out.appendChild(wrap);
  try {
    new QRCode(wrap, { text: joinUrl, width: QR_PX, height: QR_PX, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
  } catch (e) { out.textContent = joinUrl; }
  setTxBadge('Waiting for receiver', 'info');
  el('joinUrlDisplay').textContent = joinUrl;
  el('joinUrlDisplay').href = joinUrl;
  el('joinQrCaption').style.display = 'block';
  _qrContainer = null; // renderQrText() will re-adopt #qrOut once streaming starts
}

function setTxBadge(text, type) {
  el('txBadge').textContent = text;
  el('txBadge').className   = `badge badge-${type}`;
}

// ─── Camera / Receive ──────────────────────────────────────────────────────────
function checkBarcodeSupport() {
  if ('BarcodeDetector' in window) return true;
  const ua = navigator.userAgent;
  let msg;
  if (/Firefox/i.test(ua)) msg = '⚠ Firefox does not support QR scanning (BarcodeDetector API). Please use Chrome or Edge on this device.';
  else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) msg = '⚠ Safari does not support QR scanning (BarcodeDetector API). Please use Chrome on iOS or switch to a Mac/PC with Chrome.';
  else msg = '⚠ This browser does not support QR scanning. Please use Chrome 83+, Edge 83+, or Samsung Internet 13+.';
  el('browserWarning').textContent  = msg;
  el('browserWarning').style.display = 'block';
  el('cameraPrompt').style.display   = 'none';
  return false;
}

async function startCamera() {
  if (!checkBarcodeSupport()) return;
  try {
    const constraints = { video: { facingMode: { ideal: S.rxFacingMode }, width: { ideal: 1280 }, height: { ideal: 720 } } };
    S.rxStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) { toast(`Camera error: ${e.message}`, 'danger'); return; }

  const vid = el('camVideo');
  vid.srcObject = S.rxStream;
  await vid.play().catch(() => {});

  el('cameraPrompt').style.display  = 'none';
  const ap = el('autoStartPrompt'); if (ap) ap.style.display = 'none';
  el('cameraActive').style.display  = 'block';
  el('rxStatusWrap').style.display  = 'block';
  el('rxSettingsCard').style.display = 'block';
  el('rxBadge').textContent = 'Scanning';
  el('rxBadge').className   = 'badge badge-info';

  if (S.rxExpectedSid) {
    const dw = el('rxDiagWrap');
    if (dw) { dw.style.display = 'block'; el('rxDiagSid').textContent = S.rxExpectedSid; }
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  if (devices.filter(d => d.kind === 'videoinput').length > 1) el('btnSwitchCam').style.display = 'inline-flex';

  S.rxScanCanvas = document.createElement('canvas');
  S.rxScanCtx = S.rxScanCanvas.getContext('2d', { willReadFrequently: true });
  S.rxDetector = new BarcodeDetector({ formats: ['qr_code'] });
  S.rxLastScan = 0;
  setRxStatus('📡 Waiting for sender to start…', 'info');
  scanLoop();
}

function stopCamera() {
  if (S.rxStream) { S.rxStream.getTracks().forEach(t => t.stop()); S.rxStream = null; }
  if (S.rxAnimFrame) { cancelAnimationFrame(S.rxAnimFrame); S.rxAnimFrame = null; }
  if (!S.rxExpectedSid) { const cp = el('cameraPrompt'); if (cp) cp.style.display = 'block'; }
  el('cameraActive').style.display  = 'none';
  el('rxStatusWrap').style.display  = 'none';
  el('rxSettingsCard').style.display = 'none';
  el('rxBadge').textContent = 'Idle';
  el('rxBadge').className   = 'badge badge-muted';
}

async function switchCamera() {
  S.rxFacingMode = S.rxFacingMode === 'environment' ? 'user' : 'environment';
  stopCamera(); await startCamera();
}

function updateScanInterval() { S.rxScanMs = 1000 / (parseInt(el('scanRate').value) || 15); }
function setRxStatus(msg, type) { const a = el('rxStatusAlert'); a.textContent = msg; a.className = `alert alert-${type}`; }

function scanLoop() {
  S.rxAnimFrame = requestAnimationFrame(async (ts) => {
    if (!S.rxStream) return;
    if (ts - S.rxLastScan >= S.rxScanMs) { S.rxLastScan = ts; await doScan(); }
    scanLoop();
  });
}

async function doScan() {
  const vid = el('camVideo');
  if (!vid || vid.readyState < 2 || !S.rxDetector) return;
  const canvas = S.rxScanCanvas;
  canvas.width = vid.videoWidth; canvas.height = vid.videoHeight;
  S.rxScanCtx.drawImage(vid, 0, 0);
  try {
    const results = await S.rxDetector.detect(canvas);
    if (results.length > 0) processFrame(results[0].rawValue);
  } catch (_) {}
}

// ─── Frame processing (receiver) ────────────────────────────────────────────────
function processFrame(raw) {
  if (!raw || raw.length > 2200) return;
  let bytes;
  try { bytes = b64urlToU8(raw); } catch (_) { return; }
  const parsed = parseFrame(bytes);
  if (!parsed) return;
  const { header, block } = parsed;

  const now = Date.now();
  S.rxScanTimes.push(now);
  if (S.rxScanTimes.length > 12) S.rxScanTimes.shift();
  if (S.rxScanTimes.length >= 4) {
    const gaps = []; const t = S.rxScanTimes;
    for (let i = 1; i < t.length; i++) gaps.push(t[i] - t[i - 1]);
    const medGap = median(gaps);
    if (medGap > 0) S.rxLastMeasuredFps = Math.round(1000 / medGap * 10) / 10;
  }

  const identity = streamIdentity(header);
  if (identity !== S.rxIdentity) {
    // New stream (or first frame ever) — (re)initialise the decoder. This is
    // the whole "handshake": there isn't one. Any valid frame is enough to
    // lock on, mid-stream, from either mode.
    S.rxIdentity = identity;
    S.rxDecoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
    S.rxStart = Date.now();
    S.rxDone = false;
    el('rxProgressWrap').style.display = 'block';
    setRxStatus(`📡 Locked onto stream — ${fmtBytes(header.totalLen)} incoming, k=${header.k} blocks`, 'success');
    el('rxSession').textContent = `k=${header.k} · block=${header.blockLen}B`;
  }

  S.rxDecoder.addFrame(header.seq, block);
  S.rxDecodedCount++;
  updateRxProgress(header.k);
  updateRxDiag();

  if (S.linkMode === 'networked' && S.rxDecodedCount % 10 === 0 && !S.rxDone) {
    postAck(S.rxExpectedSid || S.sessionIdStr, S.rxDecoder.framesNew, S.rxLastMeasuredFps);
  }

  if (S.rxDecoder.isComplete && !S.rxDone) {
    S.rxDone = true;
    finishReceive();
  }
}

function updateRxProgress(k) {
  const elapsed = (Date.now() - S.rxStart) / 1000;
  const est = estimateProgress(k, S.rxDecoder.framesNew, elapsed);
  const pct = Math.round(est.fraction * 100);
  el('rxFrameLabel').textContent = `${S.rxDecoder.framesNew} frames · k=${k}`;
  el('rxPct').textContent = `${pct}%`;
  el('rxBar').style.width = `${pct}%`;
  el('rxETA').textContent = pct < 100 ? (est.etaSeconds !== undefined ? `ETA: ${fmtDur(est.etaSeconds)}` : 'Collecting…') : 'Assembling…';
}

async function finishReceive() {
  el('rxBadge').textContent = 'Assembling…';
  el('rxBadge').className   = 'badge badge-info';
  const container = S.rxDecoder.assemble();
  let files;
  try {
    files = await unpackContainer(container);
  } catch (e) {
    setRxStatus(`✗ Could not unpack received data: ${e.message}`, 'danger');
    el('rxBadge').textContent = 'Error'; el('rxBadge').className = 'badge badge-danger';
    return;
  }
  el('rxBadge').textContent = 'Complete ✓';
  el('rxBadge').className   = 'badge badge-success';
  setRxStatus(`📡 Received ${files.length} file(s)`, 'success');

  const list = el('rxFileList');
  list.innerHTML = '';
  const csCard = el('rxChecksumCard'); csCard.style.display = 'block';
  const csList = el('rxChecksumList'); csList.innerHTML = '';

  for (const f of files) {
    const blob = new Blob([f.bytes]);
    const url = URL.createObjectURL(blob);
    const item = document.createElement('div');
    item.className = 'file-item';
    item.style.borderColor = f.valid ? 'rgba(0,245,200,0.2)' : 'rgba(255,69,96,0.3)';
    item.innerHTML = `
      <span class="file-item-icon">${fileIcon(f.name)}</span>
      <span class="file-item-name"></span>
      <span class="file-item-size">${fmtBytes(f.size)}</span>
      <span class="badge ${f.valid ? 'badge-success' : 'badge-danger'}">${f.valid ? '✓ OK' : '✗ ERR'}</span>
      <a href="${url}" class="btn btn-primary btn-sm">↓ Save</a>`;
    item.querySelector('.file-item-name').textContent = f.name;
    item.querySelector('a').setAttribute('download', f.name);
    list.appendChild(item);

    const csItem = document.createElement('div');
    csItem.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
        <span class="mono" style="font-size:0.72rem"></span>
        <span class="badge ${f.valid ? 'badge-success' : 'badge-danger'}">${f.valid ? '✓ Verified' : '✗ Mismatch'}</span>
      </div>
      <div class="hash-display ${f.valid ? 'valid' : 'invalid'}"></div>
      ${!f.valid ? `<div class="hash-display" style="margin-top:3px;opacity:0.6"></div>` : ''}`;
    csItem.querySelector('.mono').textContent = f.name;
    const hashEls = csItem.querySelectorAll('.hash-display');
    hashEls[0].textContent = f.hash;
    if (!f.valid && hashEls[1]) hashEls[1].textContent = `Expected: ${f.expectedHash}`;
    csList.appendChild(csItem);
  }

  if (S.linkMode === 'networked') {
    postAck(S.rxExpectedSid || S.sessionIdStr, ACK_COMPLETE_SENTINEL, S.rxLastMeasuredFps);
    logToDiscord('receive', files);
  }
}

function postAck(sid, seq, fps) {
  if (!sid || S.linkMode !== 'networked') return;
  const body = { sid, seq };
  if (fps != null) body.fps = fps;
  S.rxAcksSent++;
  updateRxDiag();
  fetch('/api/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(() => {});
}

function updateRxDiag() {
  const dw = el('rxDiagWrap');
  if (!dw) return;
  dw.style.display = 'block';
  const fps = S.rxLastMeasuredFps;
  el('rxDiagFps').textContent    = fps != null ? fps.toFixed(1) + ' fps' : '—';
  el('rxDiagFrames').textContent = S.rxDecoder ? S.rxDecoder.framesNew : 0;
  el('rxDiagAcks').textContent   = S.rxAcksSent;
  el('rxDiagSid').textContent    = S.rxExpectedSid || S.sessionIdStr || '—';
}

// ─── Discord logging (networked mode only) ──────────────────────────────────────
async function logToDiscord(type, receivedFiles) {
  if (S.linkMode !== 'networked') return;
  try {
    const files = type === 'send'
      ? S.files.map(f => ({ name: f.name, size: f.size, hash: f.hash }))
      : (receivedFiles || []).map(f => ({ name: f.name, size: f.size, hash: f.hash }));
    await fetch('/api/log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, sessionId: S.sessionIdStr, files, timestamp: new Date().toISOString() }),
      keepalive: true,
    });
  } catch (_) {}
}

// ─── Steps ─────────────────────────────────────────────────────────────────────
function advanceStep(active) {
  for (let i = 1; i <= 3; i++) {
    const s = el(`step${i}`);
    if (!s) continue;
    s.className = i < active ? 'step done' : i === active ? 'step active' : 'step';
  }
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function fmtBytes(b) {
  if (!b || b === 0) return '0 B';
  const k = 1024, sz = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / k**i).toFixed(i ? 1 : 0) + ' ' + sz[i];
}
function fmtDur(s) {
  if (!isFinite(s) || s < 0) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s/60)}m ${Math.round(s%60)}s`;
}
function fileIcon(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  const m = { pdf:'📄', png:'🖼️', jpg:'🖼️', jpeg:'🖼️', gif:'🖼️', svg:'🖼️', webp:'🖼️',
               mp4:'🎬', mov:'🎬', avi:'🎬', mkv:'🎬', mp3:'🎵', wav:'🎵', flac:'🎵',
               zip:'📦', gz:'📦', tar:'📦', rar:'📦', '7z':'📦',
               doc:'📝', docx:'📝', txt:'📝', md:'📝',
               xls:'📊', xlsx:'📊', csv:'📊', js:'💻', ts:'💻', py:'💻', json:'💻' };
  return m[ext] || '📄';
}
function bufHex(buf) { return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join(''); }
function u8ToB64url(u8) {
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < u8.length; i += CHUNK) bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function b64urlToU8(s) {
  const b64 = s.replace(/-/g,'+').replace(/_/g,'/');
  const pad = (4 - b64.length % 4) % 4;
  const bin = atob(b64 + '==='.slice(0, pad));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
function randomId(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const cutoff = Math.floor(256 / chars.length) * chars.length;
  let s = '';
  while (s.length < len) {
    const arr = new Uint8Array(len * 2);
    crypto.getRandomValues(arr);
    for (let i = 0; i < arr.length && s.length < len; i++) if (arr[i] < cutoff) s += chars[arr[i] % chars.length];
  }
  return s;
}
function randomU16() {
  const arr = new Uint16Array(1);
  crypto.getRandomValues(arr);
  return Math.max(1, arr[0]); // avoid 0 — no special meaning, just keeps it visibly non-degenerate
}
function randomBytes(n) { const u8 = new Uint8Array(n); crypto.getRandomValues(u8); return u8; }
function median(arr) {
  if (!arr.length) return 999;
  const sorted = [...arr].sort((a,b) => a-b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m-1] + sorted[m]) / 2;
}
function sleep(ms) { return new Promise(r => setTimeout(r, Math.max(0, ms))); }
function toast(msg, type = 'info') {
  document.querySelectorAll('.toast').forEach(e => e.remove());
  const t = document.createElement('div');
  t.className = `toast alert alert-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.5s'; }, 2500);
  setTimeout(() => t.remove(), 3200);
}

// ─── Init ──────────────────────────────────────────────────────────────────────
function init() {
  const params = new URLSearchParams(window.location.search);
  const sid = params.get('sid');
  if (sid && /^[A-Za-z0-9]{4,32}$/.test(sid)) {
    S.rxExpectedSid = sid;
    S.linkMode = 'networked'; // arriving via a join link implies the server is reachable
    setMode('receive');
    setLinkMode('networked');
    const cp = el('cameraPrompt'), ap = el('autoStartPrompt');
    if (cp) cp.style.display = 'none';
    if (ap) ap.style.display = 'block';
    requestAnimationFrame(() => startCamera());
    return;
  }
  setMode('send');
  setLinkMode(S.linkMode);
}

init();
