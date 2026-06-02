import React, { useState, useRef, useEffect, useCallback } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { Camera, CameraOff, Download, CheckCircle, AlertTriangle, RefreshCw } from 'lucide-react';
import {
  createReceiverSession, handlePacket, getMissingChunks,
  assembleFiles, buildNackPacket, parsePacket,
} from '../lib/protocol.js';
import { fmtBytes } from '../lib/crypto.js';

const PHASE = {
  IDLE:      'idle',
  SCANNING:  'scanning',
  COMPLETE:  'complete',
  ERROR:     'error',
};

export default function Receiver() {
  const [phase,    setPhase]    = useState(PHASE.IDLE);
  const [session,  setSession]  = useState(() => createReceiverSession());
  const [stats,    setStats]    = useState({ received: 0, total: 0, dupes: 0, errors: 0 });
  const [files,    setFiles]    = useState([]);
  const [error,    setError]    = useState(null);
  const [lastScan, setLastScan] = useState(null);
  const [nackQr,   setNackQr]   = useState(null);  // data URL for NACK QR
  const [camFacing, setCamFacing] = useState('environment');

  const videoRef    = useRef(null);
  const scanRef     = useRef(null);
  const sessionRef  = useRef(session);
  const statsRef    = useRef(stats);

  // Keep refs in sync
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { statsRef.current   = stats;   }, [stats]);

  // ── Camera ─────────────────────────────────────────────────────────────────
  const startCamera = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: camFacing, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setPhase(PHASE.SCANNING);
      startScan();
    } catch (e) {
      setError(`Camera error: ${e.message}`);
    }
  };

  const stopCamera = useCallback(() => {
    const stream = videoRef.current?.srcObject;
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (scanRef.current) cancelAnimationFrame(scanRef.current);
    setPhase(PHASE.IDLE);
  }, []);

  const flipCamera = async () => {
    stopCamera();
    const next = camFacing === 'environment' ? 'user' : 'environment';
    setCamFacing(next);
    // Small delay to let stream release
    setTimeout(() => startCamera(), 200);
  };

  // ── QR Scanning loop ───────────────────────────────────────────────────────
  const startScan = useCallback(() => {
    let lastData = null;
    let lastDataTime = 0;
    const DEBOUNCE_MS = 150; // don't process same QR twice in <150ms

    const scan = () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) {
        scanRef.current = requestAnimationFrame(scan);
        return;
      }

      const tmp = document.createElement('canvas');
      tmp.width  = video.videoWidth;
      tmp.height = video.videoHeight;
      const ctx  = tmp.getContext('2d');
      ctx.drawImage(video, 0, 0);
      const imageData = ctx.getImageData(0, 0, tmp.width, tmp.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'dontInvert',
      });

      if (code?.data) {
        const now = Date.now();
        if (code.data !== lastData || now - lastDataTime > DEBOUNCE_MS) {
          lastData = code.data;
          lastDataTime = now;
          setLastScan(code.data.slice(0, 40) + (code.data.length > 40 ? '…' : ''));
          processPacket(code.data);
        }
      }

      scanRef.current = requestAnimationFrame(scan);
    };

    scanRef.current = requestAnimationFrame(scan);
  }, []);

  const processPacket = useCallback((raw) => {
    const pkt = parsePacket(raw);
    if (!pkt) return;

    const sess = sessionRef.current;
    const result = handlePacket(sess, pkt);

    if (!result.ok) {
      if (result.error !== 'session mismatch') {
        statsRef.current.errors++;
        setStats(s => ({ ...s, errors: s.errors + 1 }));
      }
      return;
    }

    if (result.type === 'duplicate') {
      statsRef.current.dupes++;
      setStats(s => ({ ...s, dupes: s.dupes + 1 }));
      return;
    }

    if (result.type === 'init') {
      setStats({ received: 0, total: sess.totalChunks, dupes: 0, errors: 0 });
      setSession({ ...sess });
      return;
    }

    if (result.type === 'data') {
      statsRef.current.received = sess.receivedCount;
      setStats(s => ({ ...s, received: sess.receivedCount, total: sess.totalChunks }));
      setSession({ ...sess });
      return;
    }

    if (result.type === 'end_complete') {
      stopCamera();
      setPhase(PHASE.COMPLETE);
      assembleFinalFiles(sess);
      return;
    }

    if (result.type === 'end_incomplete') {
      // Show NACK QR for sender to scan
      const nackPkt = buildNackPacket(sess.sessionId, result.missing);
      QRCode.toDataURL(nackPkt, { width: 280, errorCorrectionLevel: 'M',
        color: { dark: '#000', light: '#fff' } })
        .then(url => setNackQr(url));
      // Keep scanning — sender will retransmit
    }
  }, [stopCamera]);

  const assembleFinalFiles = async (sess) => {
    try {
      const assembled = await assembleFiles(sess);
      setFiles(assembled);
    } catch (e) {
      setError(`Assembly error: ${e.message}`);
      setPhase(PHASE.ERROR);
    }
  };

  const downloadFile = (file) => {
    const url = URL.createObjectURL(file.blob);
    const a = document.createElement('a');
    a.href = url; a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const reset = () => {
    stopCamera();
    setSession(createReceiverSession());
    setStats({ received: 0, total: 0, dupes: 0, errors: 0 });
    setFiles([]); setError(null); setNackQr(null);
    setPhase(PHASE.IDLE);
  };

  // ── Cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => () => {
    if (scanRef.current) cancelAnimationFrame(scanRef.current);
    const stream = videoRef.current?.srcObject;
    if (stream) stream.getTracks().forEach(t => t.stop());
  }, []);

  const pct = stats.total > 0 ? Math.round(stats.received / stats.total * 100) : 0;
  const missing = session.phase === 'receiving' ? getMissingChunks(session) : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {error && <div className="alert alert-err">⚠ {error}</div>}

      {/* ── IDLE ── */}
      {phase === PHASE.IDLE && (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '12px' }}>📷</div>
          <h3 style={{ fontWeight: 700, marginBottom: '8px' }}>Ready to Receive</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '20px', fontSize: '0.9rem', maxWidth: '360px', margin: '0 auto 20px' }}>
            Point your camera at the sender's screen. Scanning begins automatically the moment a QR code is detected.
          </p>
          <button className="btn btn-primary btn-lg" onClick={startCamera}>
            <Camera size={16} /> Start Camera
          </button>
          {session.phase === 'receiving' && session.receivedCount > 0 && (
            <div className="alert alert-info mt-3" style={{ textAlign: 'left' }}>
              Resuming session {session.sessionId} — {session.receivedCount} of {session.totalChunks} chunks already received.
            </div>
          )}
        </div>
      )}

      {/* ── SCANNING ── */}
      {phase === PHASE.SCANNING && (
        <div className="grid-2" style={{ alignItems: 'start' }}>
          {/* Camera */}
          <div>
            <div className="camera-wrap">
              <video ref={videoRef} muted playsInline />
              <div className="camera-overlay">
                <div className="scan-frame">
                  <div className="scan-corners" />
                  <div className="scan-line" />
                </div>
              </div>
              <div className="camera-status">
                <div className="dot-live" />
                {lastScan
                  ? <span>Scanning · <span className="mono">{lastScan}</span></span>
                  : 'Waiting for QR code…'
                }
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <button className="btn btn-ghost btn-sm" onClick={stopCamera}>
                <CameraOff size={12} /> Stop
              </button>
              <button className="btn btn-ghost btn-sm" onClick={flipCamera}>
                <RefreshCw size={12} /> Flip Camera
              </button>
            </div>
          </div>

          {/* Progress */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div className="card">
              <div className="card-title"><span className="dot" />Progress</div>

              {session.phase === 'awaiting_init' ? (
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                  Waiting for INIT frame from sender…
                </div>
              ) : (
                <>
                  <div className="flex-between mb-2" style={{ fontSize: '0.8rem' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>
                      Session <span className="mono">{session.sessionId}</span>
                    </span>
                    <span className="badge badge-ok">{pct}%</span>
                  </div>
                  <div className="progress-bar" style={{ marginBottom: '10px' }}>
                    <div className="progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '8px', fontSize: '0.8rem', textAlign: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 700, color: 'var(--accent)' }}>{stats.received}</div>
                      <div style={{ color: 'var(--text-muted)' }}>Received</div>
                    </div>
                    <div>
                      <div style={{ fontWeight: 700 }}>{stats.total - stats.received}</div>
                      <div style={{ color: 'var(--text-muted)' }}>Remaining</div>
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, color: stats.errors > 0 ? 'var(--danger)' : 'inherit' }}>{stats.errors}</div>
                      <div style={{ color: 'var(--text-muted)' }}>Errors</div>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Chunk grid */}
            {session.totalChunks > 0 && (
              <div className="card">
                <div className="card-title"><span className="dot" />Chunk Map</div>
                <div className="chunks-grid">
                  {Array.from({ length: Math.min(session.totalChunks, 200) }, (_, i) => (
                    <div key={i} className={`chunk-cell ${session.chunks[i] ? 'received' : ''}`}
                      title={`Chunk ${i}`}
                    />
                  ))}
                  {session.totalChunks > 200 && (
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', alignSelf: 'center' }}>
                      +{session.totalChunks - 200} more
                    </span>
                  )}
                </div>
                <div style={{ marginTop: '6px', fontSize: '0.72rem', color: 'var(--text-muted)', display: 'flex', gap: '12px' }}>
                  <span>🟢 received</span>
                  <span>⬛ pending</span>
                </div>
              </div>
            )}

            {/* Files being received */}
            {session.filesMeta && (
              <div className="card">
                <div className="card-title"><span className="dot" />Files</div>
                <div className="file-list">
                  {session.filesMeta.map((f, i) => (
                    <div className="file-item" key={i}>
                      <span className="file-icon">📄</span>
                      <span className="file-name">{f.name}</span>
                      <span className="file-size">{fmtBytes(f.size)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* NACK QR — shown when END received with missing chunks */}
            {nackQr && missing.length > 0 && (
              <div className="card" style={{ borderColor: 'rgba(251,191,36,0.3)' }}>
                <div className="card-title" style={{ color: 'var(--warn)' }}>
                  <AlertTriangle size={13} /> Show this NACK QR to sender
                </div>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                  {missing.length} chunk{missing.length !== 1 ? 's' : ''} missing.
                  Let the sender scan this QR to automatically re-transmit them.
                </p>
                <div style={{ background: '#fff', borderRadius: '8px', padding: '16px', display: 'inline-block' }}>
                  <img src={nackQr} alt="NACK QR" style={{ display: 'block', maxWidth: '200px' }} />
                </div>
                <div className="hash mt-2">{missing.slice(0, 20).join(', ')}{missing.length > 20 ? '…' : ''}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── COMPLETE ── */}
      {phase === PHASE.COMPLETE && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="alert alert-ok">
            <CheckCircle size={16} /> All chunks received and verified. Files ready to download.
          </div>

          <div className="card">
            <div className="card-title"><span className="dot" />Received Files</div>
            <div className="file-list">
              {files.map((f, i) => (
                <div key={i}>
                  <div className="file-item">
                    <span className="file-icon">📄</span>
                    <span className="file-name">{f.name}</span>
                    <span className="file-size">{fmtBytes(f.size)}</span>
                    <span className="file-status">
                      {f.hashMatch
                        ? <span className="badge badge-ok">✓ Verified</span>
                        : <span className="badge badge-err">✕ Checksum fail</span>
                      }
                    </span>
                    <button className="btn btn-primary btn-sm" onClick={() => downloadFile(f)}>
                      <Download size={12} /> Save
                    </button>
                  </div>
                  {/* Checksum display */}
                  <div className={`hash mt-2 ${f.hashMatch ? 'ok' : 'err'}`} style={{ fontSize: '0.68rem' }}>
                    SHA-256: {f.actualChecksum}
                    {!f.hashMatch && <span style={{ marginLeft: '8px' }}>Expected: {f.checksum}</span>}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
              <button className="btn btn-primary" onClick={() => files.forEach(downloadFile)}>
                <Download size={14} /> Download All
              </button>
              <button className="btn btn-ghost" onClick={reset}>
                <RefreshCw size={14} /> New Transfer
              </button>
            </div>
          </div>

          {/* Session stats */}
          <div className="card">
            <div className="card-title"><span className="dot" />Session Summary</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: '12px', fontSize: '0.85rem' }}>
              <div><span style={{ color: 'var(--text-muted)' }}>Session ID</span><br /><span className="mono">{session.sessionId}</span></div>
              <div><span style={{ color: 'var(--text-muted)' }}>Total chunks</span><br /><strong>{stats.total}</strong></div>
              <div><span style={{ color: 'var(--text-muted)' }}>Duplicates skipped</span><br /><strong>{stats.dupes}</strong></div>
              <div><span style={{ color: 'var(--text-muted)' }}>CRC errors</span><br /><strong style={{ color: stats.errors > 0 ? 'var(--danger)' : 'inherit' }}>{stats.errors}</strong></div>
            </div>
          </div>
        </div>
      )}

      {/* Hidden video ref (always in DOM for camera access) */}
      <video ref={videoRef} muted playsInline style={{ display: 'none' }} />
    </div>
  );
}
