// functions/api/ack.js — Cloudflare Pages Function
// Lightweight KV-backed ACK relay for QRForge transfer sessions.
//
// The receiver POSTs an ACK when it successfully decodes a frame.
// The sender polls GET to learn the last ACKed sequence and receiver fps.
//
// Storage: Cloudflare KV namespace bound as ACK_STORE.
// Keys:    ack:{sid}  →  JSON { seq, fps, ts }
// TTL:     60 seconds (KV native expiration — no manual eviction needed)
//
// seq: -1 is a valid calibration sentinel (fps-only ACK, no data sequence).
//
// POST /api/ack  { sid, seq, fps }   → { ok: true }
// GET  /api/ack?sid=xxx              → { sid, seq, fps, ts } | { error }
// OPTIONS /api/ack                   → CORS preflight

const ACK_TTL_S = 60;          // KV entry expiry in seconds
const SID_RE    = /^[A-Za-z0-9]{4,32}$/;

function cors(env, request) {
  const origin    = request.headers.get('Origin') || '';
  const allowed   = env.ALLOWED_ORIGIN || 'https://qr.insecure.co.nz';
  const isAllowed = origin === allowed ||
    /^https:\/\/[a-z0-9-]+\.qrforge\.pages\.dev$/.test(origin);
  return {
    'Access-Control-Allow-Origin':  isAllowed ? origin : allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: cors(context.env, context.request) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const h   = cors(env, request);
  const url = new URL(request.url);
  const sid = url.searchParams.get('sid') || '';

  if (!SID_RE.test(sid)) return json({ error: 'invalid sid' }, 400, h);

  if (!env.ACK_STORE) return json({ error: 'storage unavailable' }, 503, h);

  const raw = await env.ACK_STORE.get(`ack:${sid}`);
  if (!raw) return json({ error: 'no ack yet', sid }, 404, h);

  let entry;
  try { entry = JSON.parse(raw); } catch { return json({ error: 'corrupt entry' }, 500, h); }

  return json({ sid, seq: entry.seq, fps: entry.fps ?? null, ts: entry.ts }, 200, h);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const h  = cors(env, request);
  const ct = request.headers.get('Content-Type') || '';

  if (!ct.includes('application/json')) return new Response(null, { status: 415, headers: h });

  let body;
  try {
    const text = await request.text();
    if (text.length > 512) throw new Error('body too large');
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400, headers: h });
  }

  const { sid, seq, fps } = body;

  if (!SID_RE.test(String(sid || '')))
    return json({ error: 'invalid sid' }, 400, h);

  // seq: -1 is the calibration sentinel (fps-only ACK, no data frame acked).
  // Any non-negative value up to 0xFFFFFF is a valid data sequence number.
  if (typeof seq !== 'number' || seq < -1 || seq > 0xFFFFFF || !Number.isInteger(seq))
    return json({ error: 'invalid seq' }, 400, h);

  if (!env.ACK_STORE) return json({ error: 'storage unavailable' }, 503, h);

  const entry = {
    seq,
    fps: typeof fps === 'number' && fps > 0 && fps <= 30
      ? Math.round(fps * 10) / 10
      : null,
    ts: Date.now(),
  };

  await env.ACK_STORE.put(`ack:${sid}`, JSON.stringify(entry), {
    expirationTtl: ACK_TTL_S,
  });

  return json({ ok: true }, 200, h);
}
