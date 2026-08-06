// Fountain-code round-trip fuzz test.
//
// Loads LTEncoder/LTDecoder directly out of assets/js/transfer.js (the file
// that actually ships) rather than a separate copy, so this test can't drift
// from what's deployed. Simulates dropped frames and out-of-order delivery
// across a range of payload sizes and block lengths.
//
// Run: npm install pako && node test-fountain-roundtrip.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const { webcrypto } = crypto;

const TRANSFER_JS = path.join(__dirname, '..', 'assets', 'js', 'transfer.js');
const src = fs.readFileSync(TRANSFER_JS, 'utf8');
const testable = src.replace(/\ninit\(\);\s*$/, '\n') + `
globalThis.__t = { LTEncoder, LTDecoder };
`;

const sandbox = {
  console, crypto: webcrypto, TextEncoder, TextDecoder, DataView,
  Uint8Array, Uint16Array, Uint32Array, Float64Array,
  btoa: (bin) => Buffer.from(bin, 'binary').toString('base64'),
  atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
  pako: require('pako'),
  performance: { now: () => Date.now() },
  navigator: { onLine: true },
  window: {},
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(testable, sandbox, { filename: 'transfer.js' });
const { LTEncoder, LTDecoder } = sandbox.__t;

function randBytes(n) {
  const b = new Uint8Array(n);
  crypto.randomFillSync(b);
  return b;
}

function trial(payloadLen, blockLen, dropRate, sessionId) {
  const payload = randBytes(payloadLen);
  const enc = new LTEncoder(payload, blockLen, sessionId);
  const dec = new LTDecoder(enc.k, blockLen, sessionId, payload.length);

  // Simulate: sender streams seq 0..N in order, camera drops some frames,
  // and receiver also sees them out of order (shuffle a sliding window).
  const seqs = [];
  let seq = 0;
  let framesSent = 0;
  const maxFrames = enc.k * 40; // generous ceiling so a bad trial fails loudly, not spins
  while (!dec.isComplete && framesSent < maxFrames) {
    if (Math.random() >= dropRate) seqs.push(seq);
    seq++;
    framesSent++;
    if (seqs.length >= 8) {
      for (let i = seqs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [seqs[i], seqs[j]] = [seqs[j], seqs[i]];
      }
      while (seqs.length) {
        const s = seqs.shift();
        dec.addFrame(s, enc.encode(s));
      }
    }
  }
  while (seqs.length) {
    const s = seqs.shift();
    dec.addFrame(s, enc.encode(s));
  }

  if (!dec.isComplete) {
    console.log(`FAIL(incomplete): len=${payloadLen} block=${blockLen} drop=${dropRate} k=${enc.k} framesSent=${framesSent} solved=${dec.solvedCount}/${dec.k}`);
    return false;
  }
  const out = dec.assemble();
  const ok = Buffer.from(out).equals(Buffer.from(payload));
  const overhead = (dec.framesNew / enc.k).toFixed(3);
  console.log(`${ok ? 'OK  ' : 'FAIL(mismatch)'} len=${payloadLen} block=${blockLen} drop=${dropRate} k=${enc.k} framesNew=${dec.framesNew} overhead=${overhead}x`);
  return ok;
}

let allOk = true;
const cases = [
  [1000, 100, 0, 1],
  [50000, 220, 0.1, 42],
  [500000, 460, 0.2, 999],
  [2_000_000, 800, 0.15, 12345],
  [1, 100, 0, 7],       // tiny payload, k=1
  [800, 800, 0.3, 555], // k=1 with drops
  [65535 * 50, 50, 0.05, 65535], // large k, small blocks — near the u16 ceiling
];
for (const [len, block, drop, sid] of cases) {
  allOk = trial(len, block, drop, sid) && allOk;
}
console.log(allOk ? '\nALL PASS' : '\nSOME FAILED');
process.exit(allOk ? 0 : 1);
