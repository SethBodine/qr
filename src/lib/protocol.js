import pako from 'pako';
import { crc32, sha256Hex } from './crypto.js';

// ── Constants ─────────────────────────────────────────────────────────────────
export const PKT_INIT  = 'I'; // session init  (sender → receiver)
export const PKT_DATA  = 'D'; // data chunk    (sender → receiver)
export const PKT_END   = 'E'; // transfer end  (sender → receiver)
export const PKT_NACK  = 'N'; // missing chunks (receiver → sender, shown as QR)
export const PKT_ACK   = 'A'; // chunk ack     (used in server-relay mode)

// Max payload bytes we try to put in a QR code data string.
// QR v40-H can hold ~1273 bytes; v40-M ~2331 bytes; v40-L ~2953 bytes.
// We use error level M for a balance of density and reliability.
// After JSON framing overhead (~60 chars), this gives ~1800 bytes of base64.
// base64(1800) decodes to ~1350 bytes, which after pako decomp can be 5-10× more for text.
export const CHUNK_SIZES = {
  slow:   400,   // ~1 QR/s   - very noisy environment
  medium: 900,   // ~2-3 QR/s - typical
  fast:   1600,  // ~4-5 QR/s - ideal conditions
};
export const DEFAULT_CHUNK_SIZE = CHUNK_SIZES.medium;

// ── File → chunks ─────────────────────────────────────────────────────────────
export async function prepareFiles(files, chunkSize = DEFAULT_CHUNK_SIZE) {
  const filesMeta = [];
  const allChunks = [];   // { fileIdx, chunkIdx, data: Uint8Array }
  let totalOriginalBytes = 0;
  let totalCompressedBytes = 0;

  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    const raw = new Uint8Array(await file.arrayBuffer());
    const compressed = pako.deflate(raw, { level: 6 });
    const checksum = await sha256Hex(raw);

    totalOriginalBytes   += raw.length;
    totalCompressedBytes += compressed.length;

    // Split into chunks
    const fileChunks = [];
    for (let offset = 0; offset < compressed.length; offset += chunkSize) {
      fileChunks.push(compressed.slice(offset, offset + chunkSize));
    }
    // Edge case: empty file
    if (fileChunks.length === 0) fileChunks.push(new Uint8Array(0));

    filesMeta.push({
      name:     file.name,
      size:     raw.length,
      compressed: compressed.length,
      chunks:   fileChunks.length,
      checksum,
      mimeType: file.type || 'application/octet-stream',
    });

    fileChunks.forEach((chunk, ci) => {
      allChunks.push({ fileIdx: fi, chunkIdx: ci, data: chunk });
    });
  }

  return { filesMeta, allChunks, totalOriginalBytes, totalCompressedBytes };
}

// ── Packet builders ────────────────────────────────────────────────────────────

/** INIT packet — tells receiver what's coming */
export function buildInitPacket(sessionId, filesMeta, totalChunks) {
  return JSON.stringify({
    t: PKT_INIT,
    s: sessionId,
    z: totalChunks,
    f: filesMeta.map(f => ({
      n: f.name,
      b: f.size,
      c: f.chunks,
      k: f.checksum,
      m: f.mimeType,
    })),
    v: 1, // protocol version
  });
}

/** DATA packet for chunk at globalIndex */
export function buildDataPacket(sessionId, globalIndex, totalChunks, fileIdx, chunkData) {
  const crc = crc32(chunkData);
  const b64 = uint8ToBase64(chunkData);
  return JSON.stringify({
    t: PKT_DATA,
    s: sessionId,
    i: globalIndex,
    z: totalChunks,
    fi: fileIdx,
    d: b64,
    k: crc,
  });
}

/** END packet */
export function buildEndPacket(sessionId, totalChunks) {
  return JSON.stringify({
    t: PKT_END,
    s: sessionId,
    z: totalChunks,
  });
}

/** NACK packet — list of missing global chunk indices */
export function buildNackPacket(sessionId, missingIndices) {
  return JSON.stringify({
    t: PKT_NACK,
    s: sessionId,
    m: missingIndices,
  });
}

// ── Packet parser ─────────────────────────────────────────────────────────────
export function parsePacket(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// ── Receiver state machine ─────────────────────────────────────────────────────
export function createReceiverSession() {
  return {
    sessionId: null,
    totalChunks: null,
    filesMeta: null,
    chunks: {},          // globalIndex → Uint8Array
    receivedCount: 0,
    phase: 'awaiting_init', // awaiting_init | receiving | complete
    lastChunkAt: null,
  };
}

/** Returns { ok, error, done, progress } */
export function handlePacket(session, pkt) {
  if (!pkt) return { ok: false, error: 'invalid packet' };

  if (pkt.t === PKT_INIT) {
    if (session.phase !== 'awaiting_init') return { ok: false, error: 'unexpected INIT' };
    session.sessionId   = pkt.s;
    session.totalChunks = pkt.z;
    session.filesMeta   = pkt.f.map(f => ({
      name: f.n, size: f.b, chunks: f.c, checksum: f.k, mimeType: f.m,
    }));
    session.phase = 'receiving';
    return { ok: true, type: 'init' };
  }

  if (pkt.t === PKT_DATA) {
    if (session.phase !== 'receiving') return { ok: false, error: 'unexpected DATA' };
    if (pkt.s !== session.sessionId) return { ok: false, error: 'session mismatch' };

    // Already have this chunk?
    if (session.chunks[pkt.i] !== undefined) return { ok: true, type: 'duplicate' };

    // Decode + verify
    const raw = base64ToUint8(pkt.d);
    const actualCrc = crc32(raw);
    if (actualCrc !== pkt.k) return { ok: false, error: `CRC mismatch chunk ${pkt.i}` };

    session.chunks[pkt.i] = raw;
    session.receivedCount++;
    session.lastChunkAt = Date.now();

    const progress = session.receivedCount / session.totalChunks;
    return { ok: true, type: 'data', index: pkt.i, progress };
  }

  if (pkt.t === PKT_END) {
    if (session.phase !== 'receiving') return { ok: false, error: 'unexpected END' };
    const missing = getMissingChunks(session);
    if (missing.length > 0) {
      return { ok: true, type: 'end_incomplete', missing };
    }
    session.phase = 'complete';
    return { ok: true, type: 'end_complete' };
  }

  return { ok: false, error: `unknown packet type ${pkt.t}` };
}

/** Get list of missing global chunk indices */
export function getMissingChunks(session) {
  if (!session.totalChunks) return [];
  const missing = [];
  for (let i = 0; i < session.totalChunks; i++) {
    if (!session.chunks[i]) missing.push(i);
  }
  return missing;
}

/** Assemble received chunks back into file Blobs */
export async function assembleFiles(session) {
  const { filesMeta, chunks, totalChunks } = session;
  if (!filesMeta) throw new Error('No session metadata');

  // Concatenate all chunks in order
  const allCompressed = concatUint8Arrays(
    Array.from({ length: totalChunks }, (_, i) => chunks[i] || new Uint8Array(0))
  );

  // Split by file boundaries
  let offset = 0;
  const files = [];
  for (const meta of filesMeta) {
    // Each file's compressed data is meta.chunks * chunkSize bytes (approx)
    // We can't know exact split without per-file byte counts. We stored compressed size.
    // Re-derive from individual file's chunk spans.
    // Actually we need to store which chunks belong to which file during send.
    // Our allChunks array has { fileIdx }, and we order chunks by file.
    // So we can compute file byte boundaries from chunk ordering.
    // Since we stored meta.chunks per file, we know how many chunks per file.
    // But chunk sizes vary (last chunk is smaller). We need to track this differently.
    //
    // Simpler: inflate the entire stream and split by original file sizes.
    // This works because we concatenate file data before splitting into chunks.
  }

  // Actually: we concatenated ALL files' compressed data into one stream and split into chunks.
  // Wait - no, let me re-read prepareFiles: each file is compressed separately.
  // We need to track per-file chunk boundaries.
  // Let's rebuild by grouping chunks by fileIdx.

  // Group chunks by fileIdx using totalChunks ordering
  // We need to know each chunk's fileIdx - stored in DATA packet as pkt.fi
  // But session.chunks is keyed by globalIndex, not fileIdx.
  // We need to store fileIdx alongside chunk data.
  // Let's update session structure to store { data, fileIdx } per chunk.
  
  // For now, reassemble using file chunk counts:
  const result = [];
  let globalIdx = 0;
  for (const meta of filesMeta) {
    const fileChunkParts = [];
    for (let ci = 0; ci < meta.chunks; ci++) {
      const chunk = session.chunks[globalIdx++];
      if (chunk) fileChunkParts.push(chunk);
    }
    const compressedFile = concatUint8Arrays(fileChunkParts);
    let decompressed;
    try {
      decompressed = pako.inflate(compressedFile);
    } catch (e) {
      throw new Error(`Decompression failed for ${meta.name}: ${e.message}`);
    }

    // Verify checksum
    const actualHash = await sha256Hex(decompressed);
    const hashMatch = actualHash === meta.checksum;

    result.push({
      name: meta.name,
      size: meta.size,
      mimeType: meta.mimeType,
      checksum: meta.checksum,
      actualChecksum: actualHash,
      hashMatch,
      blob: new Blob([decompressed], { type: meta.mimeType }),
    });
  }
  return result;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function uint8ToBase64(uint8) {
  let binary = '';
  const len = uint8.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(uint8[i]);
  return btoa(binary);
}

function base64ToUint8(b64) {
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf;
}

function concatUint8Arrays(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

// ── Speed test helpers ────────────────────────────────────────────────────────
export const SPEED_TEST_PAYLOAD = 'QRSPEEDTEST_' + 'X'.repeat(200);

export function chooseChunkSize(successfulScansPerSec) {
  if (successfulScansPerSec >= 3) return CHUNK_SIZES.fast;
  if (successfulScansPerSec >= 1.5) return CHUNK_SIZES.medium;
  return CHUNK_SIZES.slow;
}
