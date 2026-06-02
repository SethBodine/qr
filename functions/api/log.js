// functions/api/log.js — Cloudflare Pages Function
// Receives transfer metadata from the browser and posts a Discord embed.
// The Discord webhook URL is stored as a Cloudflare secret (never in git).
//
// Set it via:   wrangler secret put DISCORD_WEBHOOK_URL
// Or via:       Cloudflare Dashboard → Pages → Project → Settings → Environment Variables

export async function onRequestPost(context) {
  const { request, env } = context;

  // Allow requests from the production domain or any Cloudflare Pages preview URL.
  // Set ALLOWED_ORIGIN env var to lock down to production only (recommended for live).
  const origin = request.headers.get('Origin') || '';
  const allowedOrigin = env.ALLOWED_ORIGIN || 'https://qr.insecure.co.nz';
  const isAllowed =
    origin === allowedOrigin ||
    /^https:\/\/[a-z0-9-]+\.qrforge\.pages\.dev$/.test(origin);

  const CORS = {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowedOrigin,
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };

  // ── Input validation ────────────────────────────────────────────────────────
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) {
    return new Response(null, { status: 415, headers: CORS });
  }

  let body;
  try {
    // Limit body size to 64 KB to prevent abuse
    const text = await limitedText(request, 65536);
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400, headers: CORS });
  }

  const { type, sessionId: rawSessionId, files, timestamp } = body;

  // Validate fields
  if (!['send','receive'].includes(type)) return new Response(null, { status: 400, headers: CORS });
  if (typeof rawSessionId !== 'string' || rawSessionId.length > 32) return new Response(null, { status: 400, headers: CORS });

  // Sanitise sessionId — strip anything that is not alphanumeric or hyphen.
  // Prevents Discord markdown injection (backticks, asterisks, etc.) via crafted POST.
  const sessionId = rawSessionId.replace(/[^A-Za-z0-9\-]/g, '').slice(0, 32) || 'unknown';
  if (!Array.isArray(files) || files.length > 100) return new Response(null, { status: 400, headers: CORS });

  // Validate each file entry
  const safeFiles = files.map(f => ({
    name: String(f.name || '').slice(0, 200).replace(/[^\w.\- ()]/g, '_'),
    size: Number(f.size) || 0,
    hash: /^[0-9a-f]{64}$/.test(String(f.hash)) ? f.hash : '(unknown)',
  })).slice(0, 10); // cap at 10 for the embed

  // ── Get real IPs from Cloudflare headers ────────────────────────────────────
  const senderIp  = request.headers.get('CF-Connecting-IP') || 'unknown';
  // Sanitise CF headers - these come from Cloudflare infra and are trusted,
  // but we still validate format before placing in Discord embed.
  const rawCountry = request.headers.get('CF-IPCountry') || '??';
  const country    = /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : '??';
  const rawRay     = request.headers.get('CF-Ray') || '';
  const cfRay      = /^[a-f0-9]+-[A-Z]{3}$/i.test(rawRay) ? rawRay : '(none)';
  const totalSize = files.reduce((s, f) => s + (Number(f.size) || 0), 0);

  // ── Build Discord embed ─────────────────────────────────────────────────────
  const isSend  = type === 'send';
  const fields  = [
    { name: '🔑 Session',   value: `\`${sessionId}\``,          inline: true },
    { name: '🌐 IP',        value: `\`${senderIp}\` (${country})`, inline: true },
    { name: '☁️ CF-Ray',    value: cfRay !== '(none)' ? `\`${cfRay}\`` : '—', inline: true },
    { name: '📦 Total',     value: `${files.length} file(s) · ${fmtBytes(totalSize)}`, inline: true },
    // Sanitise timestamp: only allow ISO-8601 chars (digits, T, Z, :, -, .) to prevent Discord injection
    { name: '🕐 Time', value: String(timestamp || '').replace(/[^0-9TZ:\-\.]/g, '').slice(0,24) || new Date().toISOString().slice(0,24), inline: true },
    ...safeFiles.map(f => ({
      name:   f.name,
      value:  `\`${fmtBytes(f.size)}\`\nSHA-256: \`${f.hash}\``,
      inline: true,
    })),
  ];

  if (files.length > 10) {
    fields.push({ name: `+${files.length - 10} more`, value: 'truncated', inline: false });
  }

  const embed = {
    title:     isSend ? '📤 Transfer Initiated' : '📥 Transfer Received',
    color:     isSend ? 0x00f5c8 : 0x5eaaff,
    fields,
    footer:    { text: 'QRForge · qr.insecure.co.nz' },
    timestamp: new Date().toISOString(),
  };

  // ── Post to Discord ─────────────────────────────────────────────────────────
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    // Webhook not configured — return 200 so client doesn't retry
    return new Response(JSON.stringify({ ok: false, reason: 'not configured' }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
  }

  // Basic URL validation
  if (!webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
    return new Response(JSON.stringify({ ok: false, reason: 'invalid webhook' }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
  }

  try {
    const dr = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    return new Response(JSON.stringify({ ok: dr.ok }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch {
    return new Response(JSON.stringify({ ok: false }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}

export function onRequestOptions(context) {
  const origin = context.request.headers.get('Origin') || '';
  const allowedOrigin = (context.env && context.env.ALLOWED_ORIGIN) || 'https://qr.insecure.co.nz';
  const isAllowed =
    origin === allowedOrigin ||
    /^https:\/\/[a-z0-9-]+\.qrforge\.pages\.dev$/.test(origin);

  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': isAllowed ? origin : allowedOrigin,
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
async function limitedText(request, maxBytes) {
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) throw new Error('body too large');
    chunks.push(value);
  }
  return new TextDecoder().decode(
    chunks.reduce((acc, c) => { const n = new Uint8Array(acc.length + c.length); n.set(acc); n.set(c, acc.length); return n; }, new Uint8Array(0))
  );
}

function fmtBytes(b) {
  if (!b || b === 0) return '0 B';
  const k = 1024, sz = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(Math.max(1,b)) / Math.log(k));
  return (b / k**i).toFixed(i ? 1 : 0) + ' ' + sz[i];
}
