import React, { useState, useRef, useEffect, useCallback } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {
  Upload, Play, Pause, SkipForward, Camera, CameraOff,
  CheckCircle, AlertTriangle, Zap, Clock, ChevronRight
} from 'lucide-react';
import {
  prepareFiles, buildInitPacket, buildDataPacket, buildEndPacket,
  buildNackPacket, parsePacket, PKT_NACK,
  CHUNK_SIZES, DEFAULT_CHUNK_SIZE, chooseChunkSize,
} from '../lib/protocol.js';
import { fmtBytes, fmtDuration, genSessionId } from '../lib/crypto.js';

const MAX_FILES = 100;
const MAX_BYTES = 1024 * 1024 * 1024; // 1 GB

const PHASE = {
  DROP:     'drop',
  SPEEDTEST:'speedtest',
  SENDING:  'sending',
  NACK_SCAN:'nack_scan',
  DONE:     'done',
};

export default function Sender({ onLog }) {
  const [files,    setFiles]    = useState([]);
  const [phase,    setPhase]    = useState(PHASE.DROP);
  const [prepared, setPrepared] = useState(null);
  const [chunkSize,setChunkSize]= useState(DEFAULT_CHUNK_SIZE);
  const [fps,      setFps]      = useState(2); // QR frames per second
  const [paused,   setPaused]   = useState(false);
  const [currentIdx, setCurrentIdx] = useState(-1); // -1 = init frame
  const [speedResult, setSpeedResult] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [error,    setError]    = useState(null);
  const [preparing,setPreparing] = useState(false);
  const [nackList, setNackList] = useState([]);
  const [nackQueue,setNackQueue] = useState([]);

  const canvasRef      = useRef(null);
  const intervalRef    = useRef(null);
  const sessionId      = useRef(genSessionId());
  const preparedRef    = useRef(null);
  const currentIdxRef  = useRef(-1);
  const pausedRef      = useRef(false);

  // Camera for NACK scanning
  const videoRef       = useRef(null);
  const nackScanRef    = useRef(null);
  const [camActive, setCamActive] = useState(false);

  // ── File handling ──────────────────────────────────────────────────────────
  const addFiles = useCallback((incoming) => {
    setError(null);
    const next = [...files, ...Array.from(incoming)].slice(0, MAX_FILES);
    const totalSize = next.reduce((s, f) => s + f.size, 0);
    if (totalSize > MAX_BYTES) {
      setError(`Total size exceeds 1 GB limit (${fmtBytes(totalSize)})`);
      return;
    }
    setFiles(next);
  }, [files]);

  const removeFile = (i) => setFiles(f => f.filter((_, idx) => idx !== i));

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragOver(false);
    addFiles(e.dataTransfer.files);
  }, [addFiles]);

  // ── Prepare data ───────────────────────────────────────────────────────────
  const handlePrepare = async () => {
    if (!files.length) return;
    setPreparing(true); setError(null);
    try {
      const data = await prepareFiles(files, chunkSize);
      preparedRef.current = data;
      setPrepared(data);
      setPhase(PHASE.SPEEDTEST);
    } catch (e) {
      setError(e.message);
    } finally {
      setPreparing(false);
    }
  };

  // ── Speed test ─────────────────────────────────────────────────────────────
  const [stPhase, setStPhase] = useState('idle'); // idle | running | done
  const [stScans, setStScans] = useState(0);
  const [stFps,   setStFps]   = useState(4); // target during test

  const runSpeedTest = async () => {
    setStPhase('running'); setStScans(0);
    // Show a test QR and ask user to confirm scans (no camera needed for sender-only)
    // We'll just ask the user to confirm what rate feels comfortable
    // Full auto speed test requires receiver camera feedback via server relay
    // For direct mode: show countdown then proceed
    let count = 0;
    const startTime = Date.now();
    const testInterval = setInterval(async () => {
      count++;
      setStScans(count);
      await renderTestQR(count);
      if (count >= 6) {
        clearInterval(testInterval);
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = count / elapsed;
        const selectedFps = Math.max(1, Math.min(4, Math.floor(rate)));
        setFps(selectedFps);
        setSpeedResult({ rate, selectedFps });
        setStPhase('done');
      }
    }, 1000 / stFps);
  };

  const renderTestQR = async (n) => {
    if (!canvasRef.current) return;
    await QRCode.toCanvas(canvasRef.current,
      `QRTEST:${sessionId.current}:${n}`,
      { width: 320, errorCorrectionLevel: 'M', color: { dark: '#000', light: '#fff' } }
    );
  };

  const skipSpeedTest = () => {
    setSpeedResult({ rate: fps, selectedFps: fps });
    setStPhase('done');
  };

  // ── Start sending ──────────────────────────────────────────────────────────
  const startSending = useCallback(async () => {
    const data = preparedRef.current;
    if (!data) return;
    setPhase(PHASE.SENDING);
    setCurrentIdx(-1);
    currentIdxRef.current = -1;
    pausedRef.current = false;
    setPaused(false);

    // Render INIT frame
    const initPkt = buildInitPacket(sessionId.current, data.filesMeta, data.allChunks.length);
    await renderQR(initPkt);

    // Start cycling
    const interval = 1000 / fps;
    intervalRef.current = setInterval(async () => {
      if (pausedRef.current) return;
      const idx = currentIdxRef.current;
      const total = data.allChunks.length;

      if (idx === -1) {
        // Move to first data chunk
        currentIdxRef.current = 0;
        setCurrentIdx(0);
        const chunk = data.allChunks[0];
        const pkt = buildDataPacket(sessionId.current, 0, total, chunk.fileIdx, chunk.data);
        await renderQR(pkt);
      } else if (idx < total - 1) {
        const next = idx + 1;
        currentIdxRef.current = next;
        setCurrentIdx(next);
        const chunk = data.allChunks[next];
        const pkt = buildDataPacket(sessionId.current, next, total, chunk.fileIdx, chunk.data);
        await renderQR(pkt);
      } else {
        // Send END frame
        const endPkt = buildEndPacket(sessionId.current, total);
        await renderQR(endPkt);
        clearInterval(intervalRef.current);
        setPhase(PHASE.NACK_SCAN);
        onLog?.(data.filesMeta, sessionId.current);
      }
    }, interval);
  }, [fps, onLog]);

  const renderQR = async (data) => {
    if (!canvasRef.current) return;
    await QRCode.toCanvas(canvasRef.current, data, {
      width: 340, errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    });
  };

  // ── Pause / resume ─────────────────────────────────────────────────────────
  const togglePause = () => {
    pausedRef.current = !pausedRef.current;
    setPaused(p => !p);
  };

  // ── Re-send from NACK queue ───────────────────────────────────────────────
  const resendMissing = useCallback(async (missing) => {
    const data = preparedRef.current;
    if (!data || !missing.length) return;
    setPhase(PHASE.SENDING);
    setNackList(missing);
    let qi = 0;
    const total = data.allChunks.length;
    intervalRef.current = setInterval(async () => {
      if (qi >= missing.length) {
        const endPkt = buildEndPacket(sessionId.current, total);
        await renderQR(endPkt);
        clearInterval(intervalRef.current);
        setPhase(PHASE.NACK_SCAN);
        return;
      }
      const idx = missing[qi++];
      setCurrentIdx(idx);
      currentIdxRef.current = idx;
      const chunk = data.allChunks[idx];
      const pkt = buildDataPacket(sessionId.current, idx, total, chunk.fileIdx, chunk.data);
      await renderQR(pkt);
    }, 1000 / fps);
  }, [fps]);

  // ── Camera for NACK scanning ──────────────────────────────────────────────
  const startNackCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCamActive(true);
      scanForNack();
    } catch {
      setError('Camera access denied. You can manually mark transfer as done.');
    }
  };

  const stopCamera = () => {
    const stream = videoRef.current?.srcObject;
    if (stream) stream.getTracks().forEach(t => t.stop());
    setCamActive(false);
    if (nackScanRef.current) cancelAnimationFrame(nackScanRef.current);
  };

  const scanForNack = () => {
    const scan = () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) { nackScanRef.current = requestAnimationFrame(scan); return; }
      const tmp = document.createElement('canvas');
      tmp.width = video.videoWidth; tmp.height = video.videoHeight;
      tmp.getContext('2d').drawImage(video, 0, 0);
      const id = tmp.getContext('2d').getImageData(0, 0, tmp.width, tmp.height);
      const code = jsQR(id.data, id.width, id.height);
      if (code?.data) {
        const pkt = parsePacket(code.data);
        if (pkt?.t === PKT_NACK && pkt?.s === sessionId.current) {
          stopCamera();
          resendMissing(pkt.m);
          return;
        }
      }
      nackScanRef.current = requestAnimationFrame(scan);
    };
    nackScanRef.current = requestAnimationFrame(scan);
  };

  // ── Cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => () => {
    clearInterval(intervalRef.current);
    stopCamera();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Total size ─────────────────────────────────────────────────────────────
  const totalSize  = files.reduce((s, f) => s + f.size, 0);
  const totalChunks = prepared?.allChunks?.length || 0;
  const progress   = totalChunks > 0
    ? Math.min(1, (currentIdx + 1) / totalChunks)
    : 0;
  const eta = fps > 0 && totalChunks > 0 && currentIdx >= 0
    ? fmtDuration((totalChunks - currentIdx - 1) / fps)
    : null;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* Steps */}
      <div className="steps">
        {[['1','Files'],['2','Speed'],['3','Sending'],['4','Done']].map(([n, label], i) => {
          const phaseOrder = [PHASE.DROP, PHASE.SPEEDTEST, PHASE.SENDING, PHASE.DONE];
          const ci = phaseOrder.indexOf(phase);
          const cls = i < ci ? 'done' : i === ci ? 'active' : '';
          return (
            <React.Fragment key={n}>
              <div className={`step ${cls}`}>
                <span className="step-num">{i < ci ? '✓' : n}</span>
                {label}
              </div>
              {i < 3 && <div className="step-sep" />}
            </React.Fragment>
          );
        })}
      </div>

      {error && <div className="alert alert-err">⚠ {error}</div>}

      {/* ── PHASE: DROP ── */}
      {phase === PHASE.DROP && (
        <>
          <div
            className={`drop-zone${dragOver ? ' active' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => document.getElementById('file-input-sender').click()}
          >
            <input
              id="file-input-sender" type="file" multiple style={{ display: 'none' }}
              onChange={e => addFiles(e.target.files)}
            />
            <div className="drop-zone-icon"><Upload size={36} strokeWidth={1} /></div>
            <h3>Drop files here</h3>
            <p>Up to 100 files · Max 1 GB total · All file types accepted</p>
          </div>

          {files.length > 0 && (
            <>
              <div className="card">
                <div className="flex-between mb-2">
                  <div className="card-title" style={{ marginBottom: 0 }}>
                    <span className="dot" />{files.length} file{files.length !== 1 ? 's' : ''}
                    {' '}<span className="badge badge-muted">{fmtBytes(totalSize)}</span>
                  </div>
                  <button className="btn btn-ghost btn-sm" onClick={() => setFiles([])}>Clear all</button>
                </div>
                <div className="file-list">
                  {files.map((f, i) => (
                    <div className="file-item" key={i}>
                      <span className="file-icon">📄</span>
                      <span className="file-name">{f.name}</span>
                      <span className="file-size">{fmtBytes(f.size)}</span>
                      <button className="file-remove" onClick={() => removeFile(i)}>✕</button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Chunk size */}
              <div className="card">
                <div className="card-title"><span className="dot" />Chunk Size</div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {Object.entries(CHUNK_SIZES).map(([label, size]) => (
                    <button key={label}
                      className={`btn btn-sm ${chunkSize === size ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => setChunkSize(size)}
                    >
                      {label} ({size}B)
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '8px' }}>
                  Smaller chunks = more reliable scanning. Larger = fewer QR codes but harder to scan.
                </p>
              </div>

              <button
                className="btn btn-primary btn-lg btn-full"
                onClick={handlePrepare}
                disabled={preparing}
              >
                {preparing ? <><span className="spinner" /> Compressing…</> : <><ChevronRight size={16} /> Continue to Speed Test</>}
              </button>
            </>
          )}
        </>
      )}

      {/* ── PHASE: SPEEDTEST ── */}
      {phase === PHASE.SPEEDTEST && prepared && (
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="card">
              <div className="card-title"><span className="dot" />Transfer Summary</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', fontSize: '0.85rem' }}>
                <div><span style={{ color: 'var(--text-muted)' }}>Files</span><br /><strong>{prepared.filesMeta.length}</strong></div>
                <div><span style={{ color: 'var(--text-muted)' }}>Original</span><br /><strong>{fmtBytes(prepared.totalOriginalBytes)}</strong></div>
                <div><span style={{ color: 'var(--text-muted)' }}>Compressed</span><br /><strong>{fmtBytes(prepared.totalCompressedBytes)}</strong></div>
                <div><span style={{ color: 'var(--text-muted)' }}>Total Chunks</span><br /><strong>{prepared.allChunks.length}</strong></div>
              </div>
              {prepared.totalCompressedBytes < prepared.totalOriginalBytes && (
                <div className="alert alert-ok mt-2" style={{ fontSize: '0.8rem' }}>
                  ✓ Compression saved {fmtBytes(prepared.totalOriginalBytes - prepared.totalCompressedBytes)} ({
                    Math.round((1 - prepared.totalCompressedBytes / prepared.totalOriginalBytes) * 100)
                  }%)
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-title"><span className="dot" />Speed Test</div>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                Point the <strong>receiver's camera</strong> at the QR code. This measures how fast it can reliably scan.
                Watch the preview, then select your speed below.
              </p>

              {stPhase === 'idle' && (
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button className="btn btn-secondary" onClick={runSpeedTest}>
                    <Zap size={14} /> Run Speed Test
                  </button>
                  <button className="btn btn-ghost" onClick={skipSpeedTest}>
                    Skip — use default
                  </button>
                </div>
              )}

              {stPhase === 'running' && (
                <div>
                  <p className="mono" style={{ marginBottom: '8px' }}>Cycling test QRs… {stScans}/6 shown</p>
                  <div className="progress-bar"><div className="progress-fill" style={{ width: `${stScans / 6 * 100}%` }} /></div>
                </div>
              )}

              {stPhase === 'done' && speedResult && (
                <>
                  <div className="alert alert-ok">
                    ✓ Using <strong>{speedResult.selectedFps} QR/sec</strong> — est. {
                      fmtDuration(prepared.allChunks.length / speedResult.selectedFps)
                    } transfer time
                  </div>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
                    {[1, 2, 3, 4].map(f => (
                      <button key={f}
                        className={`btn btn-sm ${fps === f ? 'btn-primary' : 'btn-ghost'}`}
                        onClick={() => setFps(f)}
                      >{f} QR/s</button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {(stPhase === 'done' || stPhase === 'idle') && (
              <button className="btn btn-primary btn-lg btn-full" onClick={skipSpeedTest}>
                <Play size={16} /> Start Sending
              </button>
            )}

            {stPhase === 'done' && (
              <button className="btn btn-primary btn-lg btn-full" onClick={startSending}>
                <Play size={16} /> Begin Transfer
              </button>
            )}
          </div>

          {/* QR preview canvas */}
          <div className="card">
            <div className="card-title"><span className="dot" />QR Preview</div>
            <div className="transfer-qr-wrap">
              <canvas ref={canvasRef} />
              {stPhase === 'idle' && (
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Run speed test to see live QR</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── PHASE: SENDING ── */}
      {phase === PHASE.SENDING && prepared && (
        <div className="grid-2" style={{ alignItems: 'start' }}>
          {/* QR display */}
          <div className="card">
            <div className="card-title"><span className="dot" />
              {currentIdx === -1 ? 'Sending INIT frame' : nackList.length > 0
                ? `Re-sending chunk ${nackList.indexOf(currentIdx) + 1}/${nackList.length}`
                : `Chunk ${currentIdx + 1} / ${totalChunks}`}
            </div>
            <div className="transfer-qr-wrap">
              <canvas ref={canvasRef} />
              <div className="qr-chunk-label">
                {currentIdx >= 0 ? `Session ${sessionId.current} · chunk ${currentIdx}` : `Session ${sessionId.current} · INIT`}
              </div>
            </div>
            <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
              <button className="btn btn-secondary btn-sm" onClick={togglePause}>
                {paused ? <><Play size={13} /> Resume</> : <><Pause size={13} /> Pause</>}
              </button>
            </div>
          </div>

          {/* Progress */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div className="card">
              <div className="card-title"><span className="dot" />Progress</div>
              <div className="progress-bar" style={{ marginBottom: '10px' }}>
                <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                <span>{Math.round(progress * 100)}% sent</span>
                {eta && <span><Clock size={11} style={{ verticalAlign: 'middle' }} /> ~{eta} remaining</span>}
              </div>
            </div>

            <div className="card">
              <div className="card-title"><span className="dot" />Files</div>
              <div className="file-list">
                {prepared.filesMeta.map((f, i) => (
                  <div className="file-item" key={i}>
                    <span className="file-icon">📄</span>
                    <span className="file-name">{f.name}</span>
                    <span className="file-size">{fmtBytes(f.size)}</span>
                    <span className="file-status">
                      <span className="badge badge-muted" style={{ fontSize: '0.65rem' }}>{f.chunks} chunks</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {paused && (
              <div className="alert alert-warn">
                ⏸ Paused — receiver is waiting. Resume when ready.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── PHASE: NACK_SCAN ── */}
      {phase === PHASE.NACK_SCAN && (
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <div className="card">
            <div className="card-title"><span className="dot" />Scan Receiver's NACK</div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '14px' }}>
              If the receiver missed chunks, they'll show a QR code listing them. Point your camera here to scan it and automatically re-send missing chunks.
            </p>
            <div className="camera-wrap">
              <video ref={videoRef} muted playsInline style={{ display: camActive ? 'block' : 'none' }} />
              {!camActive && (
                <div className="flex-center" style={{ height: '100%', minHeight: '200px' }}>
                  <button className="btn btn-secondary" onClick={startNackCamera}>
                    <Camera size={14} /> Enable Camera
                  </button>
                </div>
              )}
              {camActive && (
                <>
                  <div className="camera-overlay">
                    <div className="scan-frame">
                      <div className="scan-corners" />
                      <div className="scan-line" />
                    </div>
                  </div>
                  <div className="camera-status">
                    <div className="dot-live" />
                    Scanning for NACK QR…
                  </div>
                </>
              )}
            </div>
            {camActive && (
              <button className="btn btn-ghost btn-sm mt-2" onClick={stopCamera}>
                <CameraOff size={12} /> Stop Camera
              </button>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div className="alert alert-ok">
              <CheckCircle size={14} />
              All chunks sent! Waiting for receiver confirmation.
            </div>
            <button className="btn btn-primary btn-full" onClick={() => setPhase(PHASE.DONE)}>
              <CheckCircle size={14} /> Mark Transfer Complete
            </button>
            <button className="btn btn-ghost btn-full" onClick={startSending}>
              <SkipForward size={14} /> Re-send All (from start)
            </button>
          </div>
        </div>
      )}

      {/* ── PHASE: DONE ── */}
      {phase === PHASE.DONE && (
        <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
          <div style={{ fontSize: '3rem', marginBottom: '12px' }}>✅</div>
          <h2 style={{ fontWeight: 700, marginBottom: '8px' }}>Transfer Complete</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '20px' }}>
            {prepared?.filesMeta?.length} file{prepared?.filesMeta?.length !== 1 ? 's' : ''} sent ·{' '}
            {fmtBytes(prepared?.totalOriginalBytes || 0)} · Session {sessionId.current}
          </p>
          <button className="btn btn-secondary" onClick={() => {
            setPhase(PHASE.DROP); setFiles([]); setPrepared(null);
            sessionId.current = genSessionId(); setCurrentIdx(-1);
          }}>
            Start New Transfer
          </button>
        </div>
      )}
    </div>
  );
}
