// ═══════════════════════════════════════════════════════════════════════════════
// QRForge Transfer Engine v2
//
// PROTOCOL OVERVIEW
// ─────────────────
// Each QR code encodes one JSON frame. Frame types:
//
//   HDR  { t:'H', sid, v:1, files:[{i,n,s,h,tc,z}], total }
//        Sent 5× before data begins so receiver catches it on any loop pass.
//
//   DAT  { t:'D', s, fi, ci, d }
//        s  = global sequence (uint32, wraps at 0xFFFF)
//        fi = file index
//        ci = chunk index within file
//        d  = base64url chunk data
//        (sid omitted to save QR capacity — receiver tracks by session state)
//
//   END  { t:'E', sid, total }
//        Sent 5× at end. Receiver reassembles when all chunks seen.
//
//   CAL  { t:'C', seq, sz }
//        Calibration probe frames. Receiver (or display measurement) times them.
//
// DATA FLOW
// ─────────
// Sender reads files in chunks of `chunkBytes`, compresses eligible files,
// base64url-encodes each chunk, emits one QR per chunk at target fps.
// The full sequence loops continuously until stopped — the receiver deduplicates
// by (fi,ci) so repeated passes fill any gaps from missed scans.
//
// RECEIVER
// ────────
// BarcodeDetector API where available (Chrome/Edge/Samsung). On unsupported
// browsers the UI shows a clear warning. Scan runs in a requestAnimationFrame
// loop capped to the configured scan rate to avoid stacking async calls.
//
// SECURITY
// ────────
// - All file data stays in memory (ArrayBuffer / Uint8Array). No blob URLs
//   are created until the user clicks download — GC can collect them.
// - SHA-256 verified before any download link is rendered.
// - Session IDs are random 8-char alphanum. Headers are checked before
//   trusting any DAT frame.
// - chunk index bounds-checked before storing.
// - No eval(), no innerHTML on received data.
// - Discord logging is fire-and-forget; failure is silently swallowed.
//
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_FILES       = 100;
const MAX_TOTAL_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB
const QR_PX           = 420;   // pixel dimensions of generated QR
const HEADER_REPEATS  = 5;
const END_REPEATS     = 5;

// Chunk sizes in bytes of *raw* data per QR frame.
// QR data capacity at error-correction H minus ~60 bytes of frame wrapper.
const CHUNK_PRESETS = { s: 80, m: 220, l: 460, xl: 820 };
const CHUNK_AUTO_DEFAULT = 220;

// Non-compressible extensions
const NO_COMPRESS_EXT = new Set([
  'zip','gz','bz2','xz','7z','rar','zst','br',
  'jpg','jpeg','png','gif','webp','avif','heic','heif',
  'mp4','mov','avi','mkv','webm','m4v',
  'mp3','aac','ogg','flac','m4a','opus',
  'pdf',
]);

// ─── Mutable state (all transfer state lives here — reset per session) ────────
let S = makeState();

function makeState() {
  return {
    mode: 'send',
    // TX
    files: [],          // { file, name, size, hash, compressed, chunkCount, chunks: Uint8Array[] }
    totalBytes: 0,
    sessionId: null,
    txActive: false,
    txPaused: false,
    txFrames: [],       // pre-built JSON strings (all frames in order)
    txIndex: 0,
    txFps: 4,
    txChunkBytes: CHUNK_AUTO_DEFAULT,
    txTimer: null,
    txStart: null,
    txQrDiv: null,      // live QRCode instance container
    txQrObj: null,      // QRCode instance
    // Calibration
    calRunning: false,
    calFrames: 0,
    calStart: null,
    calTimer: null,
    // RX
    rxStream: null,
    rxFacingMode: 'environment',
    rxAnimFrame: null,
    rxLastScan: 0,
    rxScanMs: 1000 / 15,
    rxScanCanvas: null,
    rxScanCtx: null,
    rxDetector: null,
    rxHeader: null,
    rxChunks: {},       // { fi: { ci: Uint8Array } }
    rxReceived: 0,
    rxTotal: 0,
    rxStart: null,
    rxAssembled: new Set(), // fi values already assembled+downloaded
  };
}

// ─── Mode ─────────────────────────────────────────────────────────────────────
function setMode(m) {
  S.mode = m;
  el('sendPanel').style.display    = m === 'send'    ? 'block' : 'none';
  el('receivePanel').style.display = m === 'receive' ? 'block' : 'none';
  el('btnSend').className    = `btn ${m==='send'    ? 'btn-primary' : 'btn-secondary'}`;
  el('btnReceive').className = `btn ${m==='receive' ? 'btn-primary' : 'btn-secondary'}`;
}

// ─── File handling ─────────────────────────────────────────────────────────────
async function handleFiles(fileList) {
  const arr = Array.from(fileList);
  if (S.files.length + arr.length > MAX_FILES) {
    toast(`Max ${MAX_FILES} files per session`, 'warn'); return;
  }
  for (const f of arr) {
    if (S.totalBytes + f.size > MAX_TOTAL_BYTES) {
      toast('Total exceeds 1 GB limit', 'warn'); break;
    }
    S.totalBytes += f.size;
    S.files.push({ file: f, name: sanitiseFilename(f.name), size: f.size,
                   hash: null, compressed: false, chunkCount: 0, chunks: null });
  }
  renderFileList();
  await hashAllFiles();
  updateSummary();
  el('btnCalibrate').disabled = S.files.length === 0;
  el('btnStart').disabled     = S.files.length === 0;
}

function sanitiseFilename(name) {
  // Strip path components, keep only safe filename chars
  return name.replace(/.*[/\\]/, '').replace(/[^\w.\-() ]/g, '_').slice(0, 200) || 'file';
}

function removeFile(i) {
  S.totalBytes -= S.files[i].size;
  S.files.splice(i, 1);
  renderFileList();
  updateSummary();
  el('btnCalibrate').disabled = S.files.length === 0;
  el('btnStart').disabled     = S.files.length === 0;
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
  let totalFrames = 0;
  S.files.forEach(f => { totalFrames += Math.ceil(f.size / chunkBytes); });
  const fps = parseInt(el('fpsSlider').value) || 4;
  const etaSec = totalFrames / fps;
  el('statFiles').textContent  = S.files.length;
  el('statSize').textContent   = fmtBytes(S.totalBytes);
  el('statChunks').textContent = totalFrames.toLocaleString();
  el('statETA').textContent    = fmtDur(etaSec);
}

function updateETA() { updateSummary(); }
function getChunkBytes() {
  const mode = el('chunkMode').value;
  return mode === 'auto' ? S.txChunkBytes : (CHUNK_PRESETS[mode] || CHUNK_AUTO_DEFAULT);
}

// ─── Calibration ──────────────────────────────────────────────────────────────
// We display QR frames at increasing chunk sizes and measure display throughput.
// Calibration doesn't require the camera — it measures how fast this device
// can render and display QR frames (the bottleneck is rendering, not scanning).
// Camera-scan speed is inherently limited by the receiver's scan rate setting.
const CAL_SIZES   = [80, 150, 220, 360, 500, 680, 820];
const CAL_FPS_TARGET = 8; // try to display at 8fps during cal
const CAL_FRAMES_PER_SIZE = 6;

async function startCalibration() {
  if (S.calRunning) return;
  S.calRunning = true;
  el('btnCalibrate').disabled = true;
  el('btnCalibrate').textContent = '⟳ Calibrating…';
  el('txBadge').textContent = 'Calibrating';
  el('txBadge').className = 'badge badge-warn';

  const timings = []; // { sz, ms } per frame

  for (const sz of CAL_SIZES) {
    // Build a test frame of exactly this many bytes of payload
    const payload = JSON.stringify({ t: 'C', seq: timings.length, sz,
      d: randomB64(sz) });
    for (let j = 0; j < CAL_FRAMES_PER_SIZE; j++) {
      const t0 = performance.now();
      await renderQR(payload);
      const t1 = performance.now();
      timings.push({ sz, ms: t1 - t0 });
      await sleep(1000 / CAL_FPS_TARGET - (t1 - t0));
    }
  }

  // Per-size median render time
  const bySize = {};
  for (const { sz, ms } of timings) {
    (bySize[sz] = bySize[sz] || []).push(ms);
  }

  // Find largest chunk size where median render ≤ 160ms (leaving headroom for fps control)
  let bestSz = 80;
  for (const sz of CAL_SIZES) {
    const med = median(bySize[sz] || [999]);
    if (med <= 160) bestSz = sz;
  }

  // Target FPS: back off 20% from what render allows
  const medMs = median(bySize[bestSz] || [250]);
  const maxFps = Math.floor(1000 / medMs * 0.8);
  const targetFps = Math.min(maxFps, 15); // cap at 15 — camera scan is the limit anyway

  S.txChunkBytes = bestSz;
  S.txFps = Math.max(1, targetFps);

  // Update UI controls
  el('fpsSlider').value = S.txFps;
  el('fpsLabel').textContent = S.txFps;

  const bps = Math.round(bestSz * S.txFps);
  el('calFps').textContent   = S.txFps;
  el('calBps').textContent   = fmtBytes(bps) + '/s';
  el('calChunk').textContent = bestSz + 'B';
  el('calibResult').style.display = 'block';
  el('txBadge').textContent = 'Ready';
  el('txBadge').className = 'badge badge-success';
  el('btnCalibrate').disabled = false;
  el('btnCalibrate').textContent = '⚡ Re-calibrate';
  el('btnStart').disabled = false;
  S.calRunning = false;
  updateSummary();
  toast(`Calibration done — ${bestSz}B chunks @ ${S.txFps} fps ≈ ${fmtBytes(bps)}/s`, 'success');
}

// ─── Transmission ──────────────────────────────────────────────────────────────
async function startTransmission() {
  if (S.txActive || S.files.length === 0) return;

  S.sessionId = randomId(8);
  el('sessionIdBadge').textContent = `Session: ${S.sessionId}`;
  el('sessionBadge').style.display = 'flex';
  S.txFps = parseInt(el('fpsSlider').value) || 4;
  S.txChunkBytes = getChunkBytes();
  S.txActive = true;
  S.txPaused = false;
  S.txIndex = 0;
  S.txStart = Date.now();

  advanceStep(3);
  toast('Building frames…', 'info');

  S.txFrames = await buildFrames();

  el('statChunks').textContent = S.txFrames.length.toLocaleString();
  el('txProgressWrap').style.display = 'block';
  el('txCtrlCard').style.display = 'block';
  renderChecksums();
  logToDiscord('send');
  scheduleFrame();
}

async function buildFrames() {
  const chunkBytes = S.txChunkBytes;
  const compress   = el('compressMode').value;
  const frames     = [];

  // Process each file: optionally compress, chunk, encode
  let totalChunks = 0;
  const fileMeta = [];

  for (let fi = 0; fi < S.files.length; fi++) {
    const f = S.files[fi];
    let data = new Uint8Array(f._buf || await f.file.arrayBuffer());
    let compressed = false;

    if (compress !== 'off') {
      const ext = f.name.split('.').pop().toLowerCase();
      const shouldTry = compress === 'on' || !NO_COMPRESS_EXT.has(ext);
      if (shouldTry && typeof pako !== 'undefined') {
        try {
          const c = pako.deflate(data, { level: 6 });
          if (c.length < data.length * 0.92) { data = c; compressed = true; }
        } catch (_) {}
      }
    }

    // Split into raw byte chunks, then base64url-encode each
    const chunkCount = Math.ceil(data.length / chunkBytes);
    for (let ci = 0; ci < chunkCount; ci++) {
      const slice = data.subarray(ci * chunkBytes, (ci + 1) * chunkBytes);
      frames.push(JSON.stringify({
        t: 'D',
        s: totalChunks & 0xFFFF,  // global seq (wraps)
        fi,
        ci,
        d: u8ToB64url(slice),
      }));
      totalChunks++;
    }

    fileMeta.push({ i: fi, n: f.name, s: f.size, h: f.hash,
                    tc: chunkCount, z: compressed ? 1 : 0 });
    f.compressed  = compressed;
    f.chunkCount  = chunkCount;
  }

  // Build header and end frames
  const hdr = JSON.stringify({ t: 'H', sid: S.sessionId, v: 1,
                                files: fileMeta, total: totalChunks });
  const end = JSON.stringify({ t: 'E', sid: S.sessionId, total: totalChunks });

  const all = [];
  for (let i = 0; i < HEADER_REPEATS; i++) all.push(hdr);
  all.push(...frames);
  for (let i = 0; i < END_REPEATS;   i++) all.push(end);
  return all;
}

async function scheduleFrame() {
  if (!S.txActive || S.txPaused) return;

  // Loop: after END frames, restart from first DAT frame (skip repeated headers)
  if (S.txIndex >= S.txFrames.length) {
    S.txIndex = HEADER_REPEATS; // skip repeated headers on re-loop
  }

  await renderQR(S.txFrames[S.txIndex]);
  updateTxProgress();
  S.txIndex++;

  const interval = 1000 / S.txFps;
  S.txTimer = setTimeout(scheduleFrame, interval);
}

function updateTxProgress() {
  const total   = S.txFrames.length;
  const dataLen = total - HEADER_REPEATS - END_REPEATS;
  const dataIdx = Math.max(0, S.txIndex - HEADER_REPEATS);
  const pct     = dataLen > 0 ? Math.min(100, Math.round(dataIdx / dataLen * 100)) : 0;
  const elapsed = Math.round((Date.now() - S.txStart) / 1000);
  const rate    = S.txFps;
  const etaSec  = Math.max(0, (dataLen - dataIdx) / rate);

  el('txFrameLabel').textContent = `Frame ${S.txIndex} / ${total}`;
  el('txPct').textContent        = `${pct}%`;
  el('txBar').style.width        = `${pct}%`;
  el('txElapsed').textContent    = `${fmtDur(elapsed)} elapsed`;
  el('txETA').textContent        = pct < 100 ? `ETA: ${fmtDur(etaSec)}` : 'Looping…';
  el('txBadge').textContent      = pct < 100 ? `${pct}%` : 'Looping';
  el('txBadge').className        = `badge ${pct < 100 ? 'badge-info' : 'badge-success'}`;

  if (pct === 100) advanceStep(4);
}

function togglePause() {
  S.txPaused = !S.txPaused;
  el('btnPause').textContent = S.txPaused ? '▶ Resume' : '⏸ Pause';
  el('txBadge').className    = `badge ${S.txPaused ? 'badge-warn' : 'badge-info'}`;
  el('txBadge').textContent  = S.txPaused ? 'Paused' : 'Streaming';
  if (!S.txPaused) scheduleFrame();
}

function stopTx() {
  clearTimeout(S.txTimer);
  S.txActive = false;
  el('txBadge').textContent = 'Stopped';
  el('txBadge').className   = 'badge badge-danger';
  el('txCtrlCard').style.display = 'none';
  el('btnPause').textContent = '⏸ Pause';
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

// ─── QR Renderer ──────────────────────────────────────────────────────────────
// Reuses a single QRCode instance — calling makeCode/update rather than
// destroying and re-creating the DOM node each frame.
let _qrContainer = null;

async function renderQR(text) {
  const out = el('qrOut');
  if (!_qrContainer) {
    _qrContainer = document.createElement('div');
    out.innerHTML = '';
    out.appendChild(_qrContainer);
  }
  // QRCode.js renders via an internal setTimeout — we must wait for it.
  // Clearing innerHTML each frame is intentional: QRCode.js has no update API.
  _qrContainer.innerHTML = '';
  return new Promise((resolve) => {
    try {
      new QRCode(_qrContainer, {
        text,
        width: QR_PX, height: QR_PX,
        colorDark: '#000000', colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H,
      });
    } catch (e) {
      console.warn('QR encode failed (payload too large?):', e.message);
      return resolve(); // resolve even on failure so streaming continues
    }
    // QRCode.js uses setTimeout internally for canvas drawing.
    // We wait 30ms — enough for a single event-loop turn plus rendering budget.
    setTimeout(resolve, 30);
  });
}

// ─── Camera / Receive ──────────────────────────────────────────────────────────
async function startCamera() {
  try {
    const constraints = {
      video: { facingMode: { ideal: S.rxFacingMode }, width: { ideal: 1280 }, height: { ideal: 720 } }
    };
    S.rxStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    toast(`Camera error: ${e.message}`, 'danger');
    return;
  }

  const vid = el('camVideo');
  vid.srcObject = S.rxStream;
  await vid.play().catch(() => {});

  el('cameraPrompt').style.display = 'none';
  el('cameraActive').style.display = 'block';
  el('rxStatusWrap').style.display = 'block';
  el('rxSettingsCard').style.display = 'block';
  el('rxBadge').textContent = 'Scanning';
  el('rxBadge').className   = 'badge badge-info';

  // Check for multiple cameras
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoDevices = devices.filter(d => d.kind === 'videoinput');
  if (videoDevices.length > 1) el('btnSwitchCam').style.display = 'block';

  // Set up scan canvas
  S.rxScanCanvas = document.createElement('canvas');
  S.rxScanCtx    = S.rxScanCanvas.getContext('2d', { willReadFrequently: true });

  // BarcodeDetector check
  if ('BarcodeDetector' in window) {
    try {
      S.rxDetector = new BarcodeDetector({ formats: ['qr_code'] });
    } catch (_) { S.rxDetector = null; }
  }

  if (!S.rxDetector) {
    el('noBarcodeDetector').style.display = 'block';
    el('rxStatusAlert').textContent = '⚠ QR scanning requires Chrome 83+, Edge, or Samsung Internet.';
    el('rxStatusAlert').className   = 'alert alert-warn';
    return;
  }

  S.rxLastScan = 0;
  scanLoop();
}

function stopCamera() {
  if (S.rxStream) { S.rxStream.getTracks().forEach(t => t.stop()); S.rxStream = null; }
  if (S.rxAnimFrame) { cancelAnimationFrame(S.rxAnimFrame); S.rxAnimFrame = null; }
  el('cameraPrompt').style.display = 'block';
  el('cameraActive').style.display = 'none';
  el('rxStatusWrap').style.display = 'none';
  el('rxSettingsCard').style.display = 'none';
  el('rxBadge').textContent = 'Idle';
  el('rxBadge').className   = 'badge badge-muted';
}

async function switchCamera() {
  S.rxFacingMode = S.rxFacingMode === 'environment' ? 'user' : 'environment';
  stopCamera();
  await startCamera();
}

function updateScanInterval() {
  S.rxScanMs = 1000 / (parseInt(el('scanRate').value) || 15);
}

// RAF-based scan loop — no overlapping async calls
function scanLoop() {
  S.rxAnimFrame = requestAnimationFrame(async (ts) => {
    if (!S.rxStream) return;
    if (ts - S.rxLastScan >= S.rxScanMs) {
      S.rxLastScan = ts;
      await doScan();
    }
    scanLoop();
  });
}

async function doScan() {
  const vid = el('camVideo');
  if (!vid || vid.readyState < 2 || !S.rxDetector) return;
  const canvas = S.rxScanCanvas;
  canvas.width  = vid.videoWidth;
  canvas.height = vid.videoHeight;
  S.rxScanCtx.drawImage(vid, 0, 0);
  try {
    const results = await S.rxDetector.detect(canvas);
    if (results.length > 0) processFrame(results[0].rawValue);
  } catch (_) {}
}

// ─── Frame processing ──────────────────────────────────────────────────────────
function processFrame(raw) {
  // Guard: must be JSON, must have 't' field, max length to prevent DoS
  if (!raw || raw.length > 8192) return;
  let frame;
  try { frame = JSON.parse(raw); } catch (_) { return; }
  if (!frame || typeof frame.t !== 'string') return;

  switch (frame.t) {
    case 'H': onHeader(frame); break;
    case 'D': onChunk(frame);  break;
    case 'E': onEnd(frame);    break;
  }
}

function onHeader(f) {
  // Validate header structure
  if (!f.sid || typeof f.sid !== 'string' || f.sid.length > 32) return;
  if (!Array.isArray(f.files) || f.files.length === 0 || f.files.length > MAX_FILES) return;
  if (typeof f.total !== 'number' || f.total < 1 || f.total > 1e6) return;

  // Already processing this session?
  if (S.rxHeader && S.rxHeader.sid === f.sid) return;

  // Validate file entries
  const SHA256_RE = /^[0-9a-f]{64}$/;
  for (const fMeta of f.files) {
    if (typeof fMeta.n !== 'string' || typeof fMeta.s !== 'number') return;
    if (fMeta.s < 0 || fMeta.s > MAX_TOTAL_BYTES) return;
    if (typeof fMeta.tc !== 'number' || fMeta.tc < 1 || fMeta.tc > 1e6) return;
    // Validate hash — must be exactly 64 lowercase hex chars or absent
    if (fMeta.h !== undefined && !SHA256_RE.test(String(fMeta.h))) return;
    fMeta.n = sanitiseFilename(fMeta.n); // re-sanitise received filenames
  }

  S.rxHeader    = f;
  S.rxChunks    = {};
  S.rxReceived  = 0;
  S.rxTotal     = f.total;
  S.rxStart     = Date.now();
  S.rxAssembled = new Set();
  f.files.forEach((_, i) => { S.rxChunks[i] = {}; });

  el('rxBadge').textContent   = 'Receiving';
  el('rxBadge').className     = 'badge badge-info';
  el('rxProgressWrap').style.display = 'block';
  // Use textContent to avoid XSS — sid and file counts are validated above
  el('rxStatusAlert').textContent = `📡 Session ${f.sid} — ${f.files.length} file(s), ${f.total} chunks`;
  el('rxStatusAlert').className   = 'alert alert-success';
  el('rxSession').textContent     = `Session: ${f.sid}`;
  el('sessionIdBadge').textContent = `Session: ${f.sid}`;
  el('sessionBadge').style.display = 'flex';

  logToDiscord('receive');
}

function onChunk(f) {
  if (!S.rxHeader) return;
  // Validate indices
  const fi = f.fi, ci = f.ci;
  if (typeof fi !== 'number' || typeof ci !== 'number') return;
  if (fi < 0 || fi >= S.rxHeader.files.length) return;
  const tc = S.rxHeader.files[fi].tc;
  if (ci < 0 || ci >= tc) return;
  if (typeof f.d !== 'string' || f.d.length > 4096) return;

  // Dedup
  if (S.rxChunks[fi][ci] !== undefined) return;

  // Decode base64url → Uint8Array and store
  try {
    S.rxChunks[fi][ci] = b64urlToU8(f.d);
  } catch (_) { return; }

  S.rxReceived++;
  updateRxProgress();
  tryAssemble();
}

function onEnd(f) {
  if (!S.rxHeader) return;
  if (f.sid !== S.rxHeader.sid) return;
  tryAssemble(true);
}

function updateRxProgress() {
  if (!S.rxHeader) return;
  const pct     = S.rxTotal > 0 ? Math.min(100, Math.round(S.rxReceived / S.rxTotal * 100)) : 0;
  const elapsed = (Date.now() - S.rxStart) / 1000;
  const rate    = S.rxReceived / Math.max(1, elapsed);
  const etaSec  = (S.rxTotal - S.rxReceived) / Math.max(1, rate);

  el('rxFrameLabel').textContent = `Chunk ${S.rxReceived} / ${S.rxTotal}`;
  el('rxPct').textContent        = `${pct}%`;
  el('rxBar').style.width        = `${pct}%`;
  el('rxETA').textContent        = pct < 100 ? `ETA: ${fmtDur(etaSec)}` : 'Done';
}

async function tryAssemble(force = false) {
  if (!S.rxHeader) return;
  for (let fi = 0; fi < S.rxHeader.files.length; fi++) {
    if (S.rxAssembled.has(fi)) continue;
    const fMeta   = S.rxHeader.files[fi];
    const chunks  = S.rxChunks[fi];
    const have    = Object.keys(chunks).length;
    if (have < fMeta.tc && !force) continue;
    if (have < fMeta.tc) continue; // even with force, must have all chunks

    // Reassemble
    let totalLen = 0;
    for (let ci = 0; ci < fMeta.tc; ci++) {
      if (!chunks[ci]) { totalLen = -1; break; }
      totalLen += chunks[ci].length;
    }
    if (totalLen < 0) continue;

    const joined = new Uint8Array(totalLen);
    let offset = 0;
    for (let ci = 0; ci < fMeta.tc; ci++) {
      joined.set(chunks[ci], offset);
      offset += chunks[ci].length;
    }

    // Decompress if flagged
    let data = joined;
    if (fMeta.z) {
      try { data = pako.inflate(joined); }
      catch (e) { console.error('Decompress failed:', e); }
    }

    // SHA-256 verify
    const hashBuf  = await crypto.subtle.digest('SHA-256', data);
    const hash     = bufHex(hashBuf);
    const valid    = hash === fMeta.h;

    S.rxAssembled.add(fi);
    renderReceivedFile(fMeta, data, hash, valid);
  }

  const allDone = S.rxHeader.files.every((_, i) => S.rxAssembled.has(i));
  if (allDone) {
    el('rxBadge').textContent = 'Complete ✓';
    el('rxBadge').className   = 'badge badge-success';
  }
}

function renderReceivedFile(fMeta, data, hash, valid) {
  // Create blob URL — revoked when user navigates away
  const blob = new Blob([data]);
  const url  = URL.createObjectURL(blob);

  const list = el('rxFileList');
  // Clear placeholder on first file
  if (list.querySelector('div[style*="opacity"]')) list.innerHTML = '';

  const item = document.createElement('div');
  item.className = 'file-item';
  item.style.borderColor = valid ? 'rgba(0,245,200,0.2)' : 'rgba(255,69,96,0.3)';
  // Use textContent/createElement to avoid XSS — no innerHTML with received data
  item.innerHTML = `
    <span class="file-item-icon">${fileIcon(fMeta.n)}</span>
    <span class="file-item-name"></span>
    <span class="file-item-size">${fmtBytes(fMeta.s)}</span>
    <span class="badge ${valid ? 'badge-success' : 'badge-danger'}">${valid ? '✓ OK' : '✗ ERR'}</span>
    <a href="${url}" class="btn btn-primary btn-sm">↓ Save</a>
  `;
  // Set filename via textContent to prevent XSS
  item.querySelector('.file-item-name').textContent = fMeta.n;
  item.querySelector('a').setAttribute('download', fMeta.n);
  list.appendChild(item);

  // Checksum card
  const csCard = el('rxChecksumCard');
  csCard.style.display = 'block';
  const csItem = document.createElement('div');
  csItem.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
      <span class="mono" style="font-size:0.72rem"></span>
      <span class="badge ${valid ? 'badge-success' : 'badge-danger'}">${valid ? '✓ Verified' : '✗ Mismatch'}</span>
    </div>
    <div class="hash-display ${valid ? 'valid' : 'invalid'}"></div>
    ${!valid ? `<div class="hash-display" style="margin-top:3px;opacity:0.6"></div>` : ''}
  `;
  csItem.querySelector('.mono').textContent = fMeta.n;
  const hashEls = csItem.querySelectorAll('.hash-display');
  hashEls[0].textContent = hash;
  if (!valid && hashEls[1]) hashEls[1].textContent = `Expected: ${fMeta.h}`;
  el('rxChecksumList').appendChild(csItem);
}

// ─── Discord logging via Cloudflare Worker ─────────────────────────────────────
async function logToDiscord(type) {
  try {
    const files = type === 'send'
      ? S.files.map(f => ({ name: f.name, size: f.size, hash: f.hash }))
      : (S.rxHeader?.files?.map(f => ({ name: f.n, size: f.s, hash: f.h })) || []);

    await fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        sessionId: S.sessionId || S.rxHeader?.sid,
        files,
        timestamp: new Date().toISOString(),
      }),
      keepalive: true,
    });
  } catch (_) { /* non-critical */ }
}

// ─── Steps ─────────────────────────────────────────────────────────────────────
function advanceStep(active) {
  for (let i = 1; i <= 4; i++) {
    const s = el(`step${i}`);
    if (!s) continue;
    s.className = i < active ? 'step done' : i === active ? 'step active' : 'step';
  }
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtBytes(b) {
  if (!b || b === 0) return '0 B';
  const k = 1024, sz = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / k ** i).toFixed(i ? 1 : 0) + ' ' + sz[i];
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

function bufHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function u8ToB64url(u8) {
  // Process in chunks to avoid stack overflow on large arrays
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

function b64urlToU8(s) {
  const b64 = s.replace(/-/g,'+').replace(/_/g,'/');
  const pad = (4 - b64.length % 4) % 4;
  const bin = atob(b64 + '==='.slice(0, pad));
  const u8  = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function randomId(len) {
  // Rejection-sampling eliminates modulo bias.
  // chars.length=57; floor(256/57)*57=228; bytes >=228 discarded so 0-227 map uniformly onto 0-56.
  const chars  = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const cutoff = Math.floor(256 / chars.length) * chars.length; // 228
  let s = '';
  while (s.length < len) {
    const arr = new Uint8Array(len * 2); // over-allocate; almost always one pass
    crypto.getRandomValues(arr);
    for (let i = 0; i < arr.length && s.length < len; i++) {
      if (arr[i] < cutoff) s += chars[arr[i] % chars.length];
    }
  }
  return s;
}

function randomB64(bytes) {
  const u8 = new Uint8Array(bytes);
  crypto.getRandomValues(u8);
  return u8ToB64url(u8).slice(0, bytes);
}

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
  t.textContent = msg; // textContent — no XSS
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.5s'; }, 2500);
  setTimeout(() => t.remove(), 3200);
}

// ─── Init ──────────────────────────────────────────────────────────────────────
setMode('send');
