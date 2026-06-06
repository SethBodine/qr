// functions/api/ack.js — Cloudflare Pages Function
// Lightweight in-memory ACK relay for QRForge transfer sessions.
//
// The receiver POSTs an ACK when it successfully decodes a frame.
// The sender polls GET to learn the last ACKed sequence and receiver fps.
//
// Storage: a module-level Map (Cloudflare Worker isolate memory).
// Entries expire after ACK_TTL_MS with no activity — no persistence needed.
// A single isolate serves a session; if the isolate is recycled, the session
// simply resumes from the last known good position on the next sender poll.
//
// POST /api/ack  { sid, seq, fps, ua }   → { ok: true }
// GET  /api/ack?sid=xxx                  → { sid, seq, fps, ts } | { error }
// OPTIONS /api/ack                       → CORS preflight

const ACK_TTL_MS  = 60_000;   // drop session from memory after 60s of silence
const MAX_SESSIONS = 500;     // guard against unbounded growth
const SID_RE       = /^[A-Za-z0-9]{4,32}$/;

// Module-level store: sid → { seq, fps, ts }
const store = new Map();

function evict() {
  const now = Date.now();
  for (const [sid, v] of store) {
    if (now - v.ts > ACK_TTL_MS) store.delete(sid);
  }
}

function cors(env, request) {
  const origin       = request.headers.get('Origin') || '';
  const allowed      = env.ALLOWED_ORIGIN || 'https://qr.insecure.co.nz';
  const isAllowed    = origin === allowed ||
    /^https:\/\/[a-z0-9-]+\.qrforge\.pages\.dev$/.test(origin);
  return {
    'Access-Control-Allow-Origin':  isAllowed ? origin : allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: cors(context.env, context.request) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const h = cors(env, request);
  const url = new URL(request.url);
  const sid = url.searchParams.get('sid') || '';

  if (!SID_RE.test(sid)) {
    return new Response(JSON.stringify({ error: 'invalid sid' }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...h } });
  }

  evict();
  const entry = store.get(sid);
  if (!entry) {
    return new Response(JSON.stringify({ error: 'no ack yet', sid }),
      { status: 404, headers: { 'Content-Type': 'application/json', ...h } });
  }

  return new Response(JSON.stringify({ sid, seq: entry.seq, fps: entry.fps, ts: entry.ts }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...h } });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const h = cors(env, request);

  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) {
    return new Response(null, { status: 415, headers: h });
  }

  let body;
  try {
    const text = await request.text();
    if (text.length > 512) throw new Error('body too large');
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400, headers: h });
  }

  const { sid, seq, fps } = body;
  if (!SID_RE.test(String(sid || ''))) {
    return new Response(JSON.stringify({ error: 'invalid sid' }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...h } });
  }
  if (typeof seq !== 'number' || seq < 0 || seq > 0xFFFFFF) {
    return new Response(JSON.stringify({ error: 'invalid seq' }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...h } });
  }

  // Evict expired sessions before potentially adding a new one
  evict();
  if (store.size >= MAX_SESSIONS && !store.has(sid)) {
    return new Response(JSON.stringify({ error: 'server full' }),
      { status: 503, headers: { 'Content-Type': 'application/json', ...h } });
  }

  store.set(sid, {
    seq: seq,
    fps: typeof fps === 'number' && fps > 0 && fps <= 30 ? Math.round(fps * 10) / 10 : null,
    ts:  Date.now(),
  });

  return new Response(JSON.stringify({ ok: true }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...h } });
}
