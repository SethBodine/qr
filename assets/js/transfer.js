// ═══════════════════════════════════════════════════════════════════════════════
// QRForge Transfer Engine v3
//
// PROTOCOL OVERVIEW
// ─────────────────
// Each QR code encodes one JSON frame. Frame types:
//
//   HDR  { t:'H', sid, v:1, files:[{i,n,s,h,tc,z}], total }
//        Sent HEADER_REPEATS times before data begins.
//
//   DAT  { t:'D', s, fi, ci, d }
//        s  = global sequence (uint16, wraps at 0xFFFF)
//        fi = file index
//        ci = chunk index within file
//        d  = base64url chunk data
//
//   END  { t:'E', sid, total }
//        Sent END_REPEATS times. Receiver reassembles when all chunks seen.
//
//   CAL  { t:'C', seq, sz, d }
//        Calibration probe. Receiver times gaps between decoded CAL frames
//        and POSTs measured fps to /api/ack. Sender reads and adapts.
//
// SESSION JOIN
// ────────────
// Before files are added the sender shows a join-link QR:
//   https://qr.insecure.co.nz/transfer?sid=<sessionId>
// Receiver scans → page loads in receive mode → camera auto-starts.
//
// ACK / CALIBRATION FLOW
// ──────────────────────
// 1. Sender streams CAL frames while waiting.
// 2. Receiver decodes CAL frames, measures decode fps, POSTs
//    { sid, seq, fps } to /api/ack.
// 3. Sender polls /api/ack every ACK_POLL_MS. When it sees a fps value
//    it adapts txFps to min(senderMax, receiverFps) and begins transfer.
// 4. During transfer the receiver ACKs every ACK_EVERY frames:
//    POST { sid, seq } to /api/ack.
// 5. Sender pauses if no ACK within ACK_TIMEOUT_MS. On pause it rewinds
//    txIndex to the frame immediately after the last ACKed seq position.
//    Transfer resumes automatically when a fresh ACK arrives.
//
// DEVICE SUPPORT
// ──────────────
// BarcodeDetector (Chrome 83+, Edge 83+, Samsung Internet 13+, Chrome Android).
// Firefox and Safari do not support BarcodeDetector — clear warning shown on
// camera start before any scanning is attempted.
//
// DATA FLOW
// ─────────
// Sender reads files in chunks of `chunkBytes`, compresses eligible files,
// base64url-encodes each chunk, emits one QR per chunk at target fps.
// The full sequence loops continuously — receiver deduplicates by (fi,ci).
//
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_FILES           = 100;
const MAX_TOTAL_BYTES     = 1 * 1024 * 1024 * 1024;
const QR_PX               = 380;    // fits well on mobile screens
const QR_MAX_CHARS        = 1273;   // qrcode.js v40-H byte-mode capacity
const QR_WRAPPER_OVERHEAD = 45;
const QR_MAX_CHUNK_BYTES  = Math.floor((QR_MAX_CHARS - QR_WRAPPER_OVERHEAD) * 3 / 4);
const HEADER_REPEATS      = 5;
const END_REPEATS         = 5;

const CHUNK_PRESETS    = { s: 80, m: 220, l: 460, xl: 820 };
const CHUNK_AUTO_DEFAULT = 220;

// ACK / pause thresholds
const ACK_POLL_MS         = 1500;   // sender polls /api/ack every 1.5 s
const ACK_TIMEOUT_MS      = 6000;   // pause TX if no ACK for 6 s during transfer
const ACK_EVERY           = 10;     // receiver ACKs every N decoded frames
const FIRST_ACK_GRACE_MS  = 20000;  // wait up to 20 s for first ACK before pausing

// Calibration
const CAL_SIZES          = [80, 150, 220, 360, 500, 680, 820];
const CAL_FPS_TARGET     = 8;
const CAL_FRAMES_PER_SIZE = 6;

const NO_COMPRESS_EXT = new Set([
  'zip','gz','bz2','xz','7z','rar','zst','br',
  'jpg','jpeg','png','gif','webp','avif','heic','heif',
  'mp4','mov','avi','mkv','webm','m4v',
  'mp3','aac','ogg','flac','m4a','opus','pdf',
]);

// ─── Mutable state ────────────────────────────────────────────────────────────
let S = makeState();

function makeState() {
  return {
    mode: 'send',
    // TX
    files: [], totalBytes: 0,
    sessionId: randomId(8),
    txActive: false, txPaused: false,
    txFrames: [], txIndex: 0,
    txFps: 4, txChunkBytes: CHUNK_AUTO_DEFAULT,
    txTimer: null, txStart: null,
    // ACK tracking (TX side)
    txLastAckSeq: -1,       // last seq confirmed by receiver
    txLastAckTs:  0,        // timestamp of last received ack
    txAckPollTimer: null,
    txAckReceived: false,   // has at least one ack come in this session?
    // Calibration
    calRunning: false,
    // RX
    rxExpectedSid: null,
    rxStream: null, rxFacingMode: 'environment',
    rxAnimFrame: null, rxLastScan: 0, rxScanMs: 1000 / 15,
    rxScanCanvas: null, rxScanCtx: null, rxDetector: null,
    rxHeader: null, rxChunks: {}, rxReceived: 0, rxTotal: 0,
    rxStart: null, rxAssembled: new Set(),
    // ACK tracking (RX side)
    rxDecodedCount: 0,      // total frames decoded this session
    rxCalFrameTimes: [],    // timestamps of decoded CAL frames for fps measurement
    rxLastAckedSeq: -1,
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
  el('btnStart').disabled = S.files.length === 0;
  if (S.files.length > 0) advanceStep(2);
  else advanceStep(1);
}

function sanitiseFilename(name) {
  return name.replace(/.*[/\\]/, '').replace(/[^\w.\-() ]/g, '_').slice(0, 200) || 'file';
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
  let totalFrames = 0;
  S.files.forEach(f => { totalFrames += Math.ceil(f.size / chunkBytes); });
  const fps = parseInt(el('fpsSlider').value) || 4;
  el('statFiles').textContent  = S.files.length;
  el('statSize').textContent   = fmtBytes(S.totalBytes);
  el('statChunks').textContent = totalFrames.toLocaleString();
  el('statETA').textContent    = fmtDur(totalFrames / fps);
}

function updateETA() { updateSummary(); }
function getChunkBytes() {
  const mode = el('chunkMode').value;
  return mode === 'auto' ? S.txChunkBytes : (CHUNK_PRESETS[mode] || CHUNK_AUTO_DEFAULT);
}

// ─── Calibration ──────────────────────────────────────────────────────────────
async function runCalibration() {
  if (S.calRunning) return;
  S.calRunning = true;
  setTxBadge('Calibrating…', 'warn');

  const waitForPaint = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const timings = [];

  for (const sz of CAL_SIZES) {
    const safeSz  = Math.min(sz, QR_MAX_CHUNK_BYTES);
    const payload = JSON.stringify({ t:'C', seq: timings.length, sz: safeSz, d: randomB64(safeSz) });
    for (let j = 0; j < CAL_FRAMES_PER_SIZE; j++) {
      const t0 = performance.now();
      await renderQR(payload);
      await waitForPaint();
      const t1 = performance.now();
      timings.push({ sz: safeSz, ms: t1 - t0 });
      const rem = 1000 / CAL_FPS_TARGET - (t1 - t0);
      if (rem > 0) await sleep(rem);
    }
  }

  const bySize = {};
  for (const { sz, ms } of timings) (bySize[sz] = bySize[sz] || []).push(ms);

  const SAFE_CAL_SIZES = CAL_SIZES.filter(sz => sz <= QR_MAX_CHUNK_BYTES);
  let bestSz = SAFE_CAL_SIZES[0] || 80;
  for (const sz of SAFE_CAL_SIZES) {
    if (median(bySize[sz] || [999]) <= 160) bestSz = sz;
  }

  const medMs     = median(bySize[bestSz] || [250]);
  const senderMax = Math.min(Math.floor(1000 / medMs * 0.8), 15);

  S.txChunkBytes = bestSz;
  S.txFps        = Math.max(1, senderMax);

  el('fpsSlider').value         = S.txFps;
  el('fpsLabel').textContent    = S.txFps;
  el('calFps').textContent      = S.txFps;
  el('calBps').textContent      = fmtBytes(bestSz * S.txFps) + '/s';
  el('calChunk').textContent    = bestSz + 'B';
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

  S.txFps        = parseInt(el('fpsSlider').value) || 4;
  S.txChunkBytes = getChunkBytes();
  S.txActive     = true;
  S.txPaused     = false;
  S.txIndex      = 0;
  S.txStart      = Date.now();
  S.txLastAckTs  = Date.now(); // grace period before first pause check
  S.txLastAckSeq = -1;
  S.txAckReceived = false;

  advanceStep(3);
  toast('Building frames…', 'info');
  S.txFrames = await buildFrames();

  el('statChunks').textContent       = S.txFrames.length.toLocaleString();
  el('txProgressWrap').style.display = 'block';
  el('txCtrlCard').style.display     = 'block';
  renderChecksums();
  logToDiscord('send');

  // Show join QR again so receiver can still scan in
  showJoinQR();
  setTxBadge('Waiting for receiver…', 'warn');
  el('txCtrlCard').style.display = 'block';

  // Wait for first receiver ACK before streaming data.
  // Poll /api/ack; begin transfer once we see a seq response.
  // After FIRST_ACK_GRACE_MS with no ACK, show a skip option.
  startAckPolling();
  await waitForFirstAck();
  scheduleFrame();
}

// ─── Sequence helpers ─────────────────────────────────────────────────────────
// DAT frame sequences are uint16 (wraps at 0xFFFF). Use half-range comparison
// so seqGt(1, 65535) = true (1 is "greater" because seq wrapped).
function seqGt(a, b) {
  if (b < 0) return true;   // anything > sentinel -1
  const diff = (a - b) & 0xFFFF;
  return diff > 0 && diff < 0x8000;
}

// ─── Wait for first receiver ACK before streaming ────────────────────────────
async function waitForFirstAck() {
  // Show "waiting" state with a skip button the user can tap if receiver is
  // already scanning (e.g. laptop→laptop where user can see both screens)
  el('skipWaitBtn').style.display = 'inline-flex';
  setTxBadge('Waiting for receiver…', 'warn');

  const start = Date.now();
  while (!S.txAckReceived) {
    await sleep(500);
    const elapsed = Date.now() - start;
    const remaining = Math.max(0, Math.ceil((FIRST_ACK_GRACE_MS - elapsed) / 1000));

    if (elapsed < FIRST_ACK_GRACE_MS) {
      setTxBadge(`Waiting for receiver… ${remaining}s`, 'warn');
    } else {
      // Grace period expired — pause and keep waiting indefinitely
      // but now show a more prominent message
      setTxBadge('No receiver found — scan the QR to join', 'danger');
    }
  }
  el('skipWaitBtn').style.display = 'none';
  setTxBadge('Receiver joined — starting', 'success');
  await sleep(600); // brief visual confirmation
}

function skipWait() {
  // User explicitly skips waiting — stream anyway (laptop→laptop, receiver already watching)
  S.txAckReceived = true;
  S.txLastAckTs   = Date.now();
}

// ─── ACK polling (sender side) ────────────────────────────────────────────────
function startAckPolling() {
  stopAckPolling();
  S.txAckPollTimer = setInterval(pollAck, ACK_POLL_MS);
}

function stopAckPolling() {
  if (S.txAckPollTimer) { clearInterval(S.txAckPollTimer); S.txAckPollTimer = null; }
}

async function pollAck() {
  if (!S.txActive) { stopAckPolling(); return; }
  try {
    const r = await fetch(`/api/ack?sid=${encodeURIComponent(S.sessionId)}`);
    if (!r.ok) return; // 404 = no ack yet, not an error
    const data = await r.json();
    if (typeof data.seq !== 'number') return;

    const prevAck = S.txLastAckSeq;
    S.txLastAckSeq = data.seq;
    S.txLastAckTs  = Date.now();
    S.txAckReceived = true;

    // If receiver reported its measured fps, adapt sender speed
    if (typeof data.fps === 'number' && data.fps > 0) {
      const newFps = Math.max(1, Math.min(S.txFps, Math.floor(data.fps * 0.9)));
      if (newFps !== S.txFps) {
        S.txFps = newFps;
        el('fpsSlider').value = newFps;
        el('fpsLabel').textContent = newFps;
        toast(`Speed adapted to receiver: ${newFps} fps`, 'info');
      }
    }

    // Resume if paused and fresh ack arrived (seqGt handles uint16 wrap-around)
    if (S.txPaused && seqGt(data.seq, prevAck)) {
      resumeAfterAck(data.seq);
    }
  } catch (_) { /* network hiccup, ignore */ }
}

function resumeAfterAck(ackedSeq) {
  // Find the txFrames index corresponding to the frame after ackedSeq
  // The global seq is stored in DAT frames as frame.s (uint16)
  // Walk forward from HEADER_REPEATS to find the first frame with s > ackedSeq
  let rewindTo = HEADER_REPEATS;
  for (let i = HEADER_REPEATS; i < S.txFrames.length - END_REPEATS; i++) {
    try {
      const f = JSON.parse(S.txFrames[i]);
      if (f.s !== undefined && seqGt(f.s, ackedSeq & 0xFFFF)) { rewindTo = i; break; }
    } catch (_) {}
  }
  S.txIndex  = rewindTo;
  S.txPaused = false;
  el('btnPause').textContent = '⏸ Pause';
  setTxBadge('Streaming', 'info');
  toast('Receiver caught up — resuming', 'success');
  scheduleFrame();
}

function checkAckTimeout() {
  if (!S.txActive || S.txPaused) return;
  // By the time scheduleFrame() runs, waitForFirstAck() has already completed,
  // so txAckReceived is always true here. Check ongoing ACK health.
  if (Date.now() - S.txLastAckTs > ACK_TIMEOUT_MS) {
    S.txPaused = true;
    clearTimeout(S.txTimer);
    el('btnPause').textContent = '▶ Resume';
    setTxBadge('Waiting for receiver…', 'warn');
    toast('No ACK from receiver — paused. Will resume automatically.', 'warn');
  }
}

// ─── Frame scheduling ──────────────────────────────────────────────────────────
async function scheduleFrame() {
  if (!S.txActive || S.txPaused) return;

  if (S.txIndex >= S.txFrames.length) {
    S.txIndex = HEADER_REPEATS;
  }

  await renderQR(S.txFrames[S.txIndex]);
  updateTxProgress();
  checkAckTimeout();
  S.txIndex++;

  S.txTimer = setTimeout(scheduleFrame, 1000 / S.txFps);
}

function updateTxProgress() {
  const total   = S.txFrames.length;
  const dataLen = total - HEADER_REPEATS - END_REPEATS;
  const dataIdx = Math.max(0, S.txIndex - HEADER_REPEATS);
  const pct     = dataLen > 0 ? Math.min(100, Math.round(dataIdx / dataLen * 100)) : 0;
  const elapsed = Math.round((Date.now() - S.txStart) / 1000);
  const etaSec  = Math.max(0, (dataLen - dataIdx) / S.txFps);
  const ackedPct = S.txTotal > 0
    ? Math.round((S.txLastAckSeq + 1) / S.txTotal * 100) : 0;

  el('txFrameLabel').textContent = `Frame ${S.txIndex} / ${total}`;
  el('txPct').textContent        = `${pct}%`;
  el('txBar').style.width        = `${pct}%`;
  el('txAckBar').style.width     = `${Math.max(0, Math.min(100, ackedPct))}%`;
  el('txElapsed').textContent    = `${fmtDur(elapsed)} elapsed`;
  el('txETA').textContent        = pct < 100 ? `ETA: ${fmtDur(etaSec)}` : 'Looping…';
  setTxBadge(pct < 100 ? `${pct}%` : 'Looping', pct < 100 ? 'info' : 'success');
}

function setTxBadge(text, type) {
  el('txBadge').textContent = text;
  el('txBadge').className   = `badge badge-${type}`;
}

function togglePause() {
  if (!S.txActive) return;
  S.txPaused = !S.txPaused;
  el('btnPause').textContent = S.txPaused ? '▶ Resume' : '⏸ Pause';
  setTxBadge(S.txPaused ? 'Paused' : 'Streaming', S.txPaused ? 'warn' : 'info');
  if (!S.txPaused) scheduleFrame();
}

function stopTx() {
  clearTimeout(S.txTimer);
  stopAckPolling();
  S.txActive = false;
  el('txCtrlCard').style.display = 'none';
  el('btnPause').textContent = '⏸ Pause';
  showJoinQR();
}

// ─── Build frames ──────────────────────────────────────────────────────────────
async function buildFrames() {
  const chunkBytes = S.txChunkBytes;
  if (chunkBytes > QR_MAX_CHUNK_BYTES) S.txChunkBytes = QR_MAX_CHUNK_BYTES;
  const safe = Math.min(chunkBytes, QR_MAX_CHUNK_BYTES);

  const compress = el('compressMode').value;
  const frames   = [];
  let totalChunks = 0;
  const fileMeta  = [];

  for (let fi = 0; fi < S.files.length; fi++) {
    const f = S.files[fi];
    let data = new Uint8Array(f._buf || await f.file.arrayBuffer());
    let compressed = false;

    if (compress !== 'off') {
      const ext = f.name.split('.').pop().toLowerCase();
      if ((compress === 'on' || !NO_COMPRESS_EXT.has(ext)) && typeof pako !== 'undefined') {
        try {
          const c = pako.deflate(data, { level: 6 });
          if (c.length < data.length * 0.92) { data = c; compressed = true; }
        } catch (_) {}
      }
    }

    const chunkCount = Math.ceil(data.length / safe);
    for (let ci = 0; ci < chunkCount; ci++) {
      const slice = data.subarray(ci * safe, (ci + 1) * safe);
      frames.push(JSON.stringify({ t:'D', s: totalChunks & 0xFFFF, fi, ci, d: u8ToB64url(slice) }));
      totalChunks++;
    }
    fileMeta.push({ i: fi, n: f.name, s: f.size, h: f.hash, tc: chunkCount, z: compressed ? 1 : 0 });
    f.compressed = compressed;
    f.chunkCount = chunkCount;
  }

  S.txTotal = totalChunks;

  const hdr = JSON.stringify({ t:'H', sid: S.sessionId, v:1, files: fileMeta, total: totalChunks });
  const end = JSON.stringify({ t:'E', sid: S.sessionId, total: totalChunks });
  const all = [];
  for (let i = 0; i < HEADER_REPEATS; i++) all.push(hdr);
  all.push(...frames);
  for (let i = 0; i < END_REPEATS; i++) all.push(end);
  return all;
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
let _qrContainer = null;

async function renderQR(text) {
  const out = el('qrOut');
  if (!_qrContainer) {
    _qrContainer = document.createElement('div');
    out.innerHTML = '';
    out.appendChild(_qrContainer);
  }
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
      console.warn('QR encode failed:', e.message);
      _qrContainer.innerHTML = `<div style="width:${QR_PX}px;height:${QR_PX}px;display:flex;
        align-items:center;justify-content:center;background:#1a0000;border:2px solid #ff4444;
        border-radius:8px;color:#ff4444;font-size:13px;text-align:center;padding:16px;box-sizing:border-box;">
        ⚠ Frame too large<br><small>Reduce chunk size</small></div>`;
      return resolve();
    }
    setTimeout(resolve, 30);
  });
}

// ─── Camera / Receive ──────────────────────────────────────────────────────────
function checkBarcodeSupport() {
  if ('BarcodeDetector' in window) return true;
  // Show specific, actionable message based on detected browser
  const ua = navigator.userAgent;
  let msg;
  if (/Firefox/i.test(ua)) {
    msg = '⚠ Firefox does not support QR scanning (BarcodeDetector API). Please use Chrome or Edge on this device.';
  } else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) {
    msg = '⚠ Safari does not support QR scanning (BarcodeDetector API). Please use Chrome on iOS or switch to a Mac/PC with Chrome.';
  } else {
    msg = '⚠ This browser does not support QR scanning. Please use Chrome 83+, Edge 83+, or Samsung Internet 13+.';
  }
  el('browserWarning').textContent  = msg;
  el('browserWarning').style.display = 'block';
  el('cameraPrompt').style.display   = 'none';
  return false;
}

async function startCamera() {
  // Check support before requesting camera permission — fail fast with clear message
  if (!checkBarcodeSupport()) return;

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

  el('cameraPrompt').style.display  = 'none';
  const ap = el('autoStartPrompt');
  if (ap) ap.style.display          = 'none';
  el('cameraActive').style.display  = 'block';
  el('rxStatusWrap').style.display  = 'block';
  el('rxSettingsCard').style.display = 'block';
  el('rxBadge').textContent = 'Scanning';
  el('rxBadge').className   = 'badge badge-info';

  const devices = await navigator.mediaDevices.enumerateDevices();
  if (devices.filter(d => d.kind === 'videoinput').length > 1)
    el('btnSwitchCam').style.display = 'inline-flex';

  S.rxScanCanvas = document.createElement('canvas');
  S.rxScanCtx    = S.rxScanCanvas.getContext('2d', { willReadFrequently: true });
  S.rxDetector   = new BarcodeDetector({ formats: ['qr_code'] });

  S.rxLastScan = 0;
  setRxStatus('📡 Waiting for sender to start…', 'info');
  scanLoop();
}

function stopCamera() {
  if (S.rxStream) { S.rxStream.getTracks().forEach(t => t.stop()); S.rxStream = null; }
  if (S.rxAnimFrame) { cancelAnimationFrame(S.rxAnimFrame); S.rxAnimFrame = null; }
  if (!S.rxExpectedSid) {
    const cp = el('cameraPrompt');
    if (cp) cp.style.display = 'block';
  }
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

function updateScanInterval() {
  S.rxScanMs = 1000 / (parseInt(el('scanRate').value) || 15);
}

function setRxStatus(msg, type) {
  const a = el('rxStatusAlert');
  a.textContent = msg;
  a.className   = `alert alert-${type}`;
}

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
  if (!raw || raw.length > 8192) return;
  let frame;
  try { frame = JSON.parse(raw); } catch (_) { return; }
  if (!frame || typeof frame.t !== 'string') return;

  switch (frame.t) {
    case 'H': onHeader(frame); break;
    case 'D': onChunk(frame);  break;
    case 'E': onEnd(frame);    break;
    case 'C': onCalFrame(frame); break;
  }
}

// ─── Calibration frame handler (receiver side) ────────────────────────────────
function onCalFrame(f) {
  const now = Date.now();
  S.rxCalFrameTimes.push(now);

  // Keep a sliding window of the last 12 CAL frame timestamps
  if (S.rxCalFrameTimes.length > 12) S.rxCalFrameTimes.shift();

  // Need at least 4 samples to estimate fps
  if (S.rxCalFrameTimes.length < 4) return;

  const times = S.rxCalFrameTimes;
  const gaps  = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i-1]);
  const medGap = median(gaps);
  if (medGap <= 0) return;

  const measuredFps = Math.round(1000 / medGap * 10) / 10;

  // POST fps ACK to /api/ack so sender can adapt
  postAck(S.rxExpectedSid || '', -1, measuredFps);
  setRxStatus(`📡 Calibrating… ${measuredFps} fps measured`, 'info');
}

// ─── ACK sender (receiver side) ───────────────────────────────────────────────
function postAck(sid, seq, fps) {
  if (!sid) return;
  const body = { sid, seq };
  if (fps != null) body.fps = fps;
  fetch('/api/ack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
}

function onHeader(f) {
  if (!f.sid || typeof f.sid !== 'string' || f.sid.length > 32) return;
  if (!Array.isArray(f.files) || f.files.length === 0 || f.files.length > MAX_FILES) return;
  if (typeof f.total !== 'number' || f.total < 1 || f.total > 1e6) return;
  if (S.rxExpectedSid && f.sid !== S.rxExpectedSid) return;
  if (S.rxHeader && S.rxHeader.sid === f.sid) return;

  const SHA256_RE = /^[0-9a-f]{64}$/;
  for (const fMeta of f.files) {
    if (typeof fMeta.n !== 'string' || typeof fMeta.s !== 'number') return;
    if (fMeta.s < 0 || fMeta.s > MAX_TOTAL_BYTES) return;
    if (typeof fMeta.tc !== 'number' || fMeta.tc < 1 || fMeta.tc > 1e6) return;
    if (fMeta.h !== undefined && !SHA256_RE.test(String(fMeta.h))) return;
    fMeta.n = sanitiseFilename(fMeta.n);
  }

  S.rxHeader   = f;
  S.rxChunks   = {};
  S.rxReceived = 0;
  S.rxTotal    = f.total;
  S.rxStart    = Date.now();
  S.rxAssembled = new Set();
  f.files.forEach((_, i) => { S.rxChunks[i] = {}; });

  el('rxBadge').textContent = 'Receiving';
  el('rxBadge').className   = 'badge badge-info';
  el('rxProgressWrap').style.display = 'block';
  setRxStatus(`📡 Session ${esc(f.sid)} — ${f.files.length} file(s), ${f.total} chunks`, 'success');
  el('rxSession').textContent      = `Session: ${f.sid}`;
  el('sessionIdBadge').textContent = `Session: ${f.sid}`;
  el('sessionBadge').style.display = 'flex';
  logToDiscord('receive');
}

function onChunk(f) {
  if (!S.rxHeader) return;
  const fi = f.fi, ci = f.ci;
  if (typeof fi !== 'number' || typeof ci !== 'number') return;
  if (fi < 0 || fi >= S.rxHeader.files.length) return;
  if (ci < 0 || ci >= S.rxHeader.files[fi].tc) return;
  if (typeof f.d !== 'string' || f.d.length > 4096) return;
  if (S.rxChunks[fi][ci] !== undefined) return;

  try { S.rxChunks[fi][ci] = b64urlToU8(f.d); } catch (_) { return; }

  S.rxReceived++;
  S.rxDecodedCount++;

  // ACK every N frames
  if (S.rxDecodedCount % ACK_EVERY === 0) {
    postAck(S.rxExpectedSid || S.rxHeader?.sid || '', f.s ?? -1, null);
    S.rxLastAckedSeq = f.s ?? -1;
  }

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
  const pct    = S.rxTotal > 0 ? Math.min(100, Math.round(S.rxReceived / S.rxTotal * 100)) : 0;
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
    const fMeta  = S.rxHeader.files[fi];
    const chunks = S.rxChunks[fi];
    if (Object.keys(chunks).length < fMeta.tc) continue;

    let totalLen = 0;
    for (let ci = 0; ci < fMeta.tc; ci++) {
      if (!chunks[ci]) { totalLen = -1; break; }
      totalLen += chunks[ci].length;
    }
    if (totalLen < 0) continue;

    const joined = new Uint8Array(totalLen);
    let offset = 0;
    for (let ci = 0; ci < fMeta.tc; ci++) { joined.set(chunks[ci], offset); offset += chunks[ci].length; }

    let data = joined;
    if (fMeta.z) { try { data = pako.inflate(joined); } catch (e) { console.error('Decompress failed:', e); } }

    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    const hash    = bufHex(hashBuf);
    const valid   = hash === fMeta.h;
    S.rxAssembled.add(fi);
    renderReceivedFile(fMeta, data, hash, valid);
  }

  if (S.rxHeader.files.every((_, i) => S.rxAssembled.has(i))) {
    el('rxBadge').textContent = 'Complete ✓';
    el('rxBadge').className   = 'badge badge-success';
    // Final ACK
    postAck(S.rxExpectedSid || S.rxHeader?.sid || '', S.rxTotal, null);
  }
}

function renderReceivedFile(fMeta, data, hash, valid) {
  const blob = new Blob([data]);
  const url  = URL.createObjectURL(blob);
  const list = el('rxFileList');
  if (list.querySelector('div[style*="opacity"]')) list.innerHTML = '';

  const item = document.createElement('div');
  item.className = 'file-item';
  item.style.borderColor = valid ? 'rgba(0,245,200,0.2)' : 'rgba(255,69,96,0.3)';
  item.innerHTML = `
    <span class="file-item-icon">${fileIcon(fMeta.n)}</span>
    <span class="file-item-name"></span>
    <span class="file-item-size">${fmtBytes(fMeta.s)}</span>
    <span class="badge ${valid ? 'badge-success' : 'badge-danger'}">${valid ? '✓ OK' : '✗ ERR'}</span>
    <a href="${url}" class="btn btn-primary btn-sm">↓ Save</a>
  `;
  item.querySelector('.file-item-name').textContent = fMeta.n;
  item.querySelector('a').setAttribute('download', fMeta.n);
  list.appendChild(item);

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

// ─── Discord logging ───────────────────────────────────────────────────────────
async function logToDiscord(type) {
  try {
    const files = type === 'send'
      ? S.files.map(f => ({ name: f.name, size: f.size, hash: f.hash }))
      : (S.rxHeader?.files?.map(f => ({ name: f.n, size: f.s, hash: f.h })) || []);
    await fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, sessionId: S.sessionId || S.rxHeader?.sid, files, timestamp: new Date().toISOString() }),
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

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

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

function bufHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function u8ToB64url(u8) {
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < u8.length; i += CHUNK)
    bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
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
  const chars  = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const cutoff = Math.floor(256 / chars.length) * chars.length;
  let s = '';
  while (s.length < len) {
    const arr = new Uint8Array(len * 2);
    crypto.getRandomValues(arr);
    for (let i = 0; i < arr.length && s.length < len; i++)
      if (arr[i] < cutoff) s += chars[arr[i] % chars.length];
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
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.5s'; }, 2500);
  setTimeout(() => t.remove(), 3200);
}

// ─── Init ──────────────────────────────────────────────────────────────────────
function init() {
  const params = new URLSearchParams(window.location.search);
  const sid    = params.get('sid');
  if (sid && /^[A-Za-z0-9]{4,32}$/.test(sid)) {
    S.rxExpectedSid = sid;
    setMode('receive');
    const cp = el('cameraPrompt');
    const ap = el('autoStartPrompt');
    if (cp) cp.style.display = 'none';
    if (ap) ap.style.display = 'block';
    requestAnimationFrame(() => startCamera());
    return;
  }
  setMode('send');
  showJoinQR();
}

function showJoinQR() {
  const joinUrl = `${location.origin}${location.pathname}?sid=${S.sessionId}`;
  el('sessionIdBadge').textContent = `Session: ${S.sessionId}`;
  el('sessionBadge').style.display = 'flex';
  renderJoinQR(joinUrl);
}

function renderJoinQR(url) {
  const out = el('qrOut');
  out.innerHTML = '';
  const wrap = document.createElement('div');
  out.appendChild(wrap);
  try {
    new QRCode(wrap, {
      text: url,
      width: QR_PX, height: QR_PX,
      colorDark: '#000000', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  } catch(e) { out.textContent = url; }
  setTxBadge('Waiting for receiver', 'info');
  el('joinUrlDisplay').textContent = url;
  el('joinUrlDisplay').href        = url;
  el('joinQrCaption').style.display = 'block';
}

init();
