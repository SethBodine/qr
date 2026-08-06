const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { webcrypto } = require('crypto');

const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'transfer.js'), 'utf8');

// Strip the auto-running init() call (no DOM here) and expose everything the
// test needs on the sandbox global — `const`/`class` top-level declarations
// don't become globalThis properties under Node's vm module the way `var`/
// function declarations do, even though they're perfectly normal globals in
// an actual <script> tag in the browser. This shim is test-only; it doesn't
// touch the real file.
const testable = src.replace(/\ninit\(\);\s*$/, '\n') + `
globalThis.__t = {
  LTEncoder, LTDecoder, packFrame, parseFrame, streamIdentity, fnv1a,
  packContainer, unpackContainer, u8ToB64url, b64urlToU8,
  HEADER_LEN, QR_MAX_CHUNK_BYTES, MAX_SOURCE_BLOCKS,
  fitsInOneStream, sourceBlockCount, minimumFrameBytes, smallestSufficientFrameSize, blockLength,
};
`;

function b64ToBuf(b64) { return Buffer.from(b64, 'base64'); }
function bufToB64(buf) { return Buffer.from(buf).toString('base64'); }

const sandbox = {
  console,
  crypto: webcrypto,
  TextEncoder,
  TextDecoder,
  DataView,
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

async function main() {
  // ── Build a small multi-file container the way startTransmission() does ──
  const files = [
    { name: 'notes.txt', type: 'text/plain', bytes: new TextEncoder().encode('Hello from QRForge v4 — '.repeat(50)) },
    { name: 'data.bin', type: 'application/octet-stream', bytes: webcrypto.getRandomValues(new Uint8Array(3000)) },
    { name: 'empty.txt', type: 'text/plain', bytes: new Uint8Array(0) },
  ];

  const container = await sandbox.__t.packContainer(files, 'auto');
  console.log('container bytes:', container.length);

  const blockLen = 220;
  const frameBytes = blockLen + sandbox.__t.HEADER_LEN;
  console.log('fitsInOneStream:', sandbox.__t.fitsInOneStream(container.length, frameBytes));

  const sessionId = 4242;
  const encoder = new sandbox.__t.LTEncoder(container, blockLen, sessionId);
  const headerBase = { sessionId, k: encoder.k, blockLen, totalLen: container.length, payloadFnv: sandbox.__t.fnv1a(container) };
  console.log('k =', encoder.k);

  // ── Simulate the optical channel: encode -> pack -> base64url "QR text" ->
  // decode text -> parse -> feed into a fresh LTDecoder that only knows what
  // a real receiver would know (nothing, until frame 1 arrives). Drop 20%,
  // shuffle order, and don't stop until decoder says complete. ──
  const decoder = /** lazily created on first frame, like processFrame() does */ { ref: null };
  let identity = null;
  let seq = 0;
  let sent = 0, dropped = 0;
  const maxAttempts = encoder.k * 30;

  while ((!decoder.ref || !decoder.ref.isComplete) && sent < maxAttempts) {
    const block = encoder.encode(seq);
    const bytes = sandbox.__t.packFrame({ ...headerBase, seq }, block);
    const text = sandbox.__t.u8ToB64url(bytes);
    seq++;
    sent++;

    if (Math.random() < 0.2) { dropped++; continue; } // simulate a missed/blurred camera frame

    // receiver side, mirroring processFrame()
    const rxBytes = sandbox.__t.b64urlToU8(text);
    const parsed = sandbox.__t.parseFrame(rxBytes);
    if (!parsed) throw new Error('parseFrame failed on a well-formed frame');
    const id = sandbox.__t.streamIdentity(parsed.header);
    if (id !== identity) {
      identity = id;
      decoder.ref = new sandbox.__t.LTDecoder(parsed.header.k, parsed.header.blockLen, parsed.header.sessionId, parsed.header.totalLen);
    }
    decoder.ref.addFrame(parsed.header.seq, parsed.block);
  }

  if (!decoder.ref.isComplete) throw new Error(`Decoder never completed after ${sent} frames (${dropped} dropped)`);
  console.log(`complete after ${sent} frames sent, ${dropped} dropped, framesNew=${decoder.ref.framesNew}, overhead=${(decoder.ref.framesNew / encoder.k).toFixed(3)}x`);

  const assembled = decoder.ref.assemble();
  if (assembled.length !== container.length) throw new Error('assembled length mismatch');
  if (Buffer.from(assembled).compare(Buffer.from(container)) !== 0) throw new Error('assembled bytes mismatch — container corrupted');
  console.log('container round-trip: BYTE-IDENTICAL ✓');

  const outFiles = await sandbox.__t.unpackContainer(assembled);
  if (outFiles.length !== files.length) throw new Error('file count mismatch');
  for (let i = 0; i < files.length; i++) {
    const orig = files[i], out = outFiles[i];
    if (out.name !== orig.name) throw new Error(`name mismatch: ${out.name} !== ${orig.name}`);
    if (!out.valid) throw new Error(`hash mismatch for ${out.name}`);
    if (Buffer.from(out.bytes).compare(Buffer.from(orig.bytes)) !== 0) throw new Error(`bytes mismatch for ${out.name}`);
    console.log(`  file OK: ${out.name} (${out.size}B, valid=${out.valid})`);
  }

  // ── Capacity-limit guard: a payload that needs more than 65535 blocks at
  // this frame size should be rejected with a helpful suggestion, not fail
  // silently mid-transfer. ──
  const bigPayloadLen = 70000 * blockLength(frameBytes); // deliberately over MAX_SOURCE_BLOCKS
  function blockLength(fb) { return fb - sandbox.__t.HEADER_LEN; }
  const fitsBig = sandbox.__t.fitsInOneStream(bigPayloadLen, frameBytes);
  const suggestion = sandbox.__t.smallestSufficientFrameSize(bigPayloadLen, [80, 220, 460, 820, sandbox.__t.QR_MAX_CHUNK_BYTES].map(v => v + sandbox.__t.HEADER_LEN));
  console.log('oversize payload fitsInOneStream (expect false):', fitsBig, '  suggested frame bytes:', suggestion);
  if (fitsBig) throw new Error('capacity guard did not reject an oversize payload');

  console.log('\nALL INTEGRATION TESTS PASSED');
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
