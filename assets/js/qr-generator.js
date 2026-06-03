// ─── QRForge Generator ────────────────────────────────────────────────────────
// Uses qr-code-styling v1.6 for native dot/eye/gradient/logo rendering.
// https://github.com/kozakdenys/qr-code-styling
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

let qrCode        = null;   // QRCodeStyling instance (created lazily on first generate)
let scheduleTimer = null;
let logoDataUrl   = null;
let currentType   = 'url';
let lastContent   = null;

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  // Wire all radio inputs
  document.querySelectorAll('input[name="dots"], input[name="eyeSquare"], input[name="eyeDot"]')
    .forEach(r => r.addEventListener('change', schedule));

  // ARIA accessibility for tab bar
  document.querySelectorAll('.tab').forEach(btn => {
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', btn.classList.contains('active') ? 'true' : 'false');
    btn.setAttribute('tabindex', btn.classList.contains('active') ? '0' : '-1');
  });
  document.getElementById('typeTabs')?.addEventListener('keydown', tabKeyNav);
}

function tabKeyNav(e) {
  const tabs = [...document.querySelectorAll('.tab')];
  const idx  = tabs.indexOf(document.activeElement);
  if (idx < 0) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); tabs[(idx + 1) % tabs.length].focus(); }
  if (e.key === 'ArrowLeft')  { e.preventDefault(); tabs[(idx + tabs.length - 1) % tabs.length].focus(); }
}

// ── Content types ─────────────────────────────────────────────────────────────
function setType(type, tabEl) {
  currentType = type;
  document.querySelectorAll('.type-fields').forEach(el => el.style.display = 'none');
  const panel = document.getElementById('f-' + type);
  if (panel) panel.style.display = 'block';
  // F6 fix: update aria-selected on every switch
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.remove('active');
    t.setAttribute('aria-selected', 'false');
    t.setAttribute('tabindex', '-1');
  });
  tabEl.classList.add('active');
  tabEl.setAttribute('aria-selected', 'true');
  tabEl.setAttribute('tabindex', '0');
  schedule();
}

// Allowed URL schemes — block javascript:, data:, vbscript: etc.
const SAFE_SCHEMES = new Set(['http:', 'https:', 'ftp:']);

function buildContent() {
  const g = id => (document.getElementById(id)?.value || '').trim();

  switch (currentType) {

    // ── URL ───────────────────────────────────────────────────────────────────
    case 'url': {
      const u = g('in-url');
      if (!u) return null;
      // Scheme safety check — prevent javascript: / data: QRs
      try {
        const parsed = new URL(u);
        if (!SAFE_SCHEMES.has(parsed.protocol)) return null;
      } catch (_) {
        // Not parseable — still encode as-is (user may have typed a partial URL)
        if (/^javascript:|^data:|^vbscript:/i.test(u)) return null;
      }
      return u;
    }

    // ── Text ──────────────────────────────────────────────────────────────────
    case 'text':   return g('in-text') || null;

    // ── Wi-Fi ────────────────────────────────────────────────────────────────
    // Spec: WIFI:T:<auth>;S:<ssid>;P:<pass>;H:<hidden>;;
    // Escape chars per ZXing: \ ; , " :
    case 'wifi': {
      const ssid = g('in-wifi-ssid'); if (!ssid) return null;
      const sec  = ['WPA','WEP','nopass'].includes(g('in-wifi-sec')) ? g('in-wifi-sec') : 'WPA';
      const pass = g('in-wifi-pass');
      const hid  = document.getElementById('in-wifi-hidden')?.checked ? 'true' : 'false';
      return `WIFI:T:${sec};S:${escWifi(ssid)};P:${escWifi(pass)};H:${hid};;`;
    }

    // ── vCard 3.0 ────────────────────────────────────────────────────────────
    case 'vcard': {
      const first = g('vc-first'), last = g('vc-last');
      if (!first && !last) return null;
      const fn = (first + (first && last ? ' ' : '') + last).trim();
      return [
        'BEGIN:VCARD', 'VERSION:3.0',
        `FN:${escVcard(fn)}`,
        `N:${escVcard(last)};${escVcard(first)};;;`,
        g('vc-phone') ? `TEL;TYPE=CELL:${g('vc-phone')}` : '',
        g('vc-email') ? `EMAIL:${escVcard(g('vc-email'))}` : '',
        g('vc-org')   ? `ORG:${escVcard(g('vc-org'))}` : '',
        g('vc-title') ? `TITLE:${escVcard(g('vc-title'))}` : '',
        g('vc-url')   ? `URL:${g('vc-url')}` : '',
        g('vc-addr')  ? `ADR:;;${escVcard(g('vc-addr'))};;;;` : '',
        'END:VCARD',
      ].filter(Boolean).join('\r\n');
    }

    // ── Email (mailto:) ───────────────────────────────────────────────────────
    case 'email': {
      const to = g('in-email-to'); if (!to) return null;
      // Strip newlines from to field to prevent header injection
      const safeTo = to.replace(/[\r\n]/g, '');
      const parts = [];
      const sub  = g('in-email-sub');
      const body = g('in-email-body');
      if (sub)  parts.push('subject=' + encodeURIComponent(sub));
      if (body) parts.push('body='    + encodeURIComponent(body));
      return `mailto:${safeTo}${parts.length ? '?' + parts.join('&') : ''}`;
    }

    // ── Phone (tel:) ──────────────────────────────────────────────────────────
    case 'phone': {
      const p = g('in-phone').replace(/\s+/g, '');
      return p ? `tel:${p}` : null;
    }

    // ── SMS ───────────────────────────────────────────────────────────────────
    // Use sms:number?body=... — works on iOS and Android (smsto: is Android-only)
    case 'sms': {
      const to = g('in-sms-to').replace(/\s+/g, ''); if (!to) return null;
      const msg = g('in-sms-msg');
      return msg ? `sms:${to}?body=${encodeURIComponent(msg)}` : `sms:${to}`;
    }

    // ── Geo ───────────────────────────────────────────────────────────────────
    case 'geo': {
      const lat = parseFloat(g('in-geo-lat')), lng = parseFloat(g('in-geo-lng'));
      if (isNaN(lat) || isNaN(lng)) return null;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
      const label = g('in-geo-label');
      return label
        ? `geo:${lat.toFixed(6)},${lng.toFixed(6)}?q=${encodeURIComponent(label)}`
        : `geo:${lat.toFixed(6)},${lng.toFixed(6)}`;
    }

    // ── iCal Event (RFC 5545) ─────────────────────────────────────────────────
    case 'event': {
      const title = g('ev-title'); if (!title) return null;
      // Convert datetime-local value to iCal UTC format: YYYYMMDDTHHmmssZ
      const toICS = s => {
        if (!s) return '';
        try {
          return new Date(s).toISOString()
            .replace(/[-:]/g, '')      // remove dashes and colons
            .replace(/\.\d{3}/, '');   // remove milliseconds (.000) — Z stays
        } catch { return ''; }
      };
      const start = document.getElementById('ev-start')?.value;
      const end   = document.getElementById('ev-end')?.value;
      // UID is required by RFC 5545 §3.6.1
      // Must be stable — generated once and cached on the module, not per-call.
      // Resets when the page reloads, which is acceptable (new QR = new event intent).
      if (!buildContent._eventUid) {
        buildContent._eventUid = `${Date.now()}-${Math.random().toString(36).slice(2,8)}@qr.insecure.co.nz`;
      }
      const uid = buildContent._eventUid;
      return [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//QRForge//qr.insecure.co.nz//EN',
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `SUMMARY:${escVcard(title)}`,
        start ? `DTSTART:${toICS(start)}` : '',
        end   ? `DTEND:${toICS(end)}`     : '',
        g('ev-loc')  ? `LOCATION:${escVcard(g('ev-loc'))}` : '',
        g('ev-desc') ? `DESCRIPTION:${escVcard(g('ev-desc'))}` : '',
        'END:VEVENT',
        'END:VCALENDAR',
      ].filter(Boolean).join('\r\n');
    }

    // ── WhatsApp ──────────────────────────────────────────────────────────────
    case 'whatsapp': {
      const num = g('in-wa-num').replace(/[\s\-()]/g, ''); if (!num) return null;
      const msg = g('in-wa-msg');
      return msg
        ? `https://wa.me/${num}?text=${encodeURIComponent(msg)}`
        : `https://wa.me/${num}`;
    }

    // ── Telegram ──────────────────────────────────────────────────────────────
    case 'telegram': {
      const user = g('in-tg-user').replace(/^@/, ''); if (!user) return null;
      const msg  = g('in-tg-msg');
      return msg
        ? `https://t.me/${encodeURIComponent(user)}?text=${encodeURIComponent(msg)}`
        : `https://t.me/${encodeURIComponent(user)}`;
    }

    // ── Bitcoin / Crypto ──────────────────────────────────────────────────────
    case 'bitcoin': {
      const addr   = g('in-btc-addr'); if (!addr) return null;
      const amount = parseFloat(g('in-btc-amount'));
      const label  = g('in-btc-label');
      const parts  = [];
      if (!isNaN(amount) && amount > 0) parts.push(`amount=${amount}`);
      if (label) parts.push(`label=${encodeURIComponent(label)}`);
      return `bitcoin:${addr}${parts.length ? '?' + parts.join('&') : ''}`;
    }

    // ── PayPal.me ────────────────────────────────────────────────────────────
    case 'paypal': {
      const user   = g('in-pp-user'); if (!user) return null;
      const amount = g('in-pp-amount');
      return amount
        ? `https://paypal.me/${encodeURIComponent(user)}/${encodeURIComponent(amount)}`
        : `https://paypal.me/${encodeURIComponent(user)}`;
    }

    // ── App Store / Play Store ────────────────────────────────────────────────
    case 'appstore': {
      const platform = g('in-app-platform');
      const appId    = g('in-app-id'); if (!appId) return null;
      if (platform === 'ios') {
        return `https://apps.apple.com/app/id${encodeURIComponent(appId)}`;
      }
      return `https://play.google.com/store/apps/details?id=${encodeURIComponent(appId)}`;
    }

  }
  return null;
}

// ── Escape helpers ────────────────────────────────────────────────────────────

// Wi-Fi QR spec (ISO/IEC 18004 + ZXing): escape \ ; , " : with a leading backslash.
function escWifi(s) { return String(s).replace(/([\\;,":])/g, '\\$1'); }

// vCard / iCal: escape \ ; , and fold newlines
function escVcard(s) { return String(s).replace(/([\\;,])/g, '\\$1').replace(/\n/g, '\\n'); }

// ── Geolocation ────────────────────────────────────────────────────────────────
function useMyLocation() {
  if (!navigator.geolocation) { toast('Geolocation not supported', 'warn'); return; }
  navigator.geolocation.getCurrentPosition(
    pos => {
      setVal('in-geo-lat', pos.coords.latitude.toFixed(6));
      setVal('in-geo-lng', pos.coords.longitude.toFixed(6));
      schedule();
    },
    () => toast('Could not get location — check browser permissions', 'warn')
  );
}

// ── Colour controls ───────────────────────────────────────────────────────────
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
function syncCol(which) {
  const v = document.getElementById(which + 'Color')?.value;
  if (v) { setVal(which + 'Hex', v); schedule(); }
}
function syncHex(which) {
  const v = document.getElementById(which + 'Hex')?.value;
  if (HEX_RE.test(v)) { setVal(which + 'Color', v); schedule(); }
}
function syncGCol(id) {
  const v = document.getElementById(id + 'Color')?.value;
  if (v) { setVal(id + 'Hex', v); schedule(); }
}
function syncGHex(id) {
  const v = document.getElementById(id + 'Hex')?.value;
  if (HEX_RE.test(v)) { setVal(id + 'Color', v); schedule(); }
}
function resetEyeColor() {
  const dot = document.getElementById('dotHex')?.value || '#000000';
  setVal('eyeColor', dot); setVal('eyeHex', dot); schedule();
}
function toggleGrad(which) {
  const on    = document.getElementById(which + 'GradOn')?.checked;
  const solid = document.getElementById(which + 'Solid');
  const panel = document.getElementById(which + 'Grad');
  if (solid) solid.style.display = on ? 'none' : 'flex';
  if (panel) panel.classList.toggle('open', !!on);
  schedule();
}

// ── Logo ──────────────────────────────────────────────────────────────────────
function handleLogo(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Only image files can be used as logos', 'warn'); return; }
  if (file.size > 4 * 1024 * 1024)    { toast('Logo must be under 4 MB', 'warn'); return; }

  const reader = new FileReader();
  reader.onload = e => {
    // Resize to max 512×512 before storing. Large images cause qr-code-styling to
    // stall on canvas drawImage and render a white square, especially on mobile.
    const img = new Image();
    img.onload = () => {
      const MAX = 512;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const w = Math.round(img.width  * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      logoDataUrl = canvas.toDataURL('image/png');
      const title = document.getElementById('logoDropTitle');
      if (title) title.textContent = `${file.name} (${w}×${h})`;
      const controls = document.getElementById('logoControls');
      if (controls) controls.style.display = 'block';
      setVal('ecLevel', 'H'); // H correction is required when a logo obscures modules
      schedule();
    };
    img.onerror = () => toast('Could not load image — try a different file', 'warn');
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function removeLogo() {
  logoDataUrl = null;
  const title = document.getElementById('logoDropTitle');
  if (title) title.textContent = 'Drop logo here';
  const controls = document.getElementById('logoControls');
  if (controls) controls.style.display = 'none';
  const input = document.getElementById('logoInput');
  if (input) input.value = '';
  schedule();
}

// ── Build qr-code-styling options ─────────────────────────────────────────────
function buildOptions(content) {
  const size   = Math.min(2048, Math.max(64, parseInt(document.getElementById('qrSize')?.value) || 1024));
  const margin = Math.min(10,   Math.max(0,  parseInt(document.getElementById('qrMargin')?.value) || 4));
  const ec     = (['L','M','Q','H'].includes(document.getElementById('ecLevel')?.value)
                  ? document.getElementById('ecLevel').value : 'M');
  const dotType = document.querySelector('input[name="dots"]:checked')?.value    || 'square';
  const esType  = document.querySelector('input[name="eyeSquare"]:checked')?.value || 'square';
  const edType  = document.querySelector('input[name="eyeDot"]:checked')?.value  || 'square';
  const dotGrad = document.getElementById('dotGradOn')?.checked;
  const bgGrad  = document.getElementById('bgGradOn')?.checked;
  const dotHex  = validHex(document.getElementById('dotHex')?.value) || '#000000';
  const bgHex   = validHex(document.getElementById('bgHex')?.value)  || '#ffffff';
  const eyeHex  = validHex(document.getElementById('eyeHex')?.value) || dotHex;

  const dotsOptions = dotGrad
    ? { type: dotType, gradient: gradientOpts('dot') }
    : { type: dotType, color: dotHex };

  const backgroundOptions = bgGrad
    ? { gradient: gradientOpts('bg') }
    : { color: bgHex };

  const imageOptions = logoDataUrl ? {
    // crossOrigin must NOT be set for data: URLs — it triggers CORS errors in some browsers
    // and causes qr-code-styling to render a blank white square instead of the logo.
    imageSize:   Math.min(0.5, Math.max(0.1, (parseInt(document.getElementById('logoSize')?.value) || 35) / 100)),
    margin:      Math.min(20,  Math.max(0,   parseInt(document.getElementById('logoPad')?.value)  || 5)),
    hideBackgroundDots: document.getElementById('logoHide')?.value !== 'false',
  } : { imageSize: 0, margin: 0 };

  return {
    width:  size,
    height: size,
    margin: margin * 4,
    data:   content,
    image:  logoDataUrl || undefined,
    qrOptions:            { errorCorrectionLevel: ec },
    dotsOptions,
    backgroundOptions,
    cornersSquareOptions: { type: esType, color: eyeHex },
    cornersDotOptions:    { type: edType, color: eyeHex },
    imageOptions,
    type: 'canvas',
  };
}

function gradientOpts(which) {
  const type  = document.getElementById(which + 'GradType')?.value || 'linear';
  const angle = (parseFloat(document.getElementById(which + 'GradAngle')?.value) || 0) * Math.PI / 180;
  const c1    = validHex(document.getElementById(which + 'G1Hex')?.value) || '#000000';
  const c2    = validHex(document.getElementById(which + 'G2Hex')?.value) || '#ffffff';
  return { type, rotation: angle, colorStops: [{ offset: 0, color: c1 }, { offset: 1, color: c2 }] };
}

function validHex(v) { return HEX_RE.test(v) ? v : null; }

// ── Generate ──────────────────────────────────────────────────────────────────
function schedule() {
  clearTimeout(scheduleTimer);
  scheduleTimer = setTimeout(generate, 220);
}

async function generate() {
  const content = buildContent();
  const display = document.getElementById('qrDisplay');

  if (!content) {
    qrCode = null;
    display.innerHTML = '<div class="qr-placeholder"><div>◼</div><p style="font-size:0.8rem">Enter content above</p></div>';
    document.getElementById('qrMeta').style.display = 'none';
    document.getElementById('scanTestRow').style.display = 'none';
    document.getElementById('qrBadge').textContent = '—';
    document.getElementById('qrBadge').className = 'badge badge-muted';
    setEnabled(false);
    lastContent = null;
    return;
  }

  const opts = buildOptions(content);

  if (!qrCode) {
    display.innerHTML = '';
    qrCode = new QRCodeStyling(opts);
    qrCode.append(display);
  } else {
    qrCode.update(opts);
  }

  lastContent = content;

  // Metadata
  const hashHex = await sha256(content);
  const ec  = opts.qrOptions.errorCorrectionLevel;
  const sz  = opts.width;
  document.getElementById('qrHash').textContent = `SHA-256: ${hashHex}`;
  document.getElementById('qrMetaBadges').innerHTML =
    `<span class="badge badge-success">✓ Generated</span>` +
    `<span class="badge badge-muted">EC: ${ec}</span>` +
    `<span class="badge badge-muted">${sz}px</span>` +
    (logoDataUrl ? `<span class="badge badge-info">Logo</span>` : '');
  document.getElementById('qrBadge').textContent = 'Ready';
  document.getElementById('qrBadge').className = 'badge badge-success';
  document.getElementById('qrMeta').style.display = 'block';
  document.getElementById('scanTestRow').style.display = 'block';
  document.getElementById('scanResult').style.display = 'none';
  setEnabled(true);
}

function setEnabled(on) {
  ['dlPng','dlSvg','dlJpg','dlTransparent','cpBtn','printBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  });
}

// ── Download ──────────────────────────────────────────────────────────────────
function dl(ext) {
  if (!qrCode || !lastContent) return;
  const name = `qrforge-${Date.now()}`;

  if (ext === 'png') {
    qrCode.download({ name, extension: 'png' });

  } else if (ext === 'svg') {
    // Use a separate SVG-type instance — never mutate the live canvas instance
    const svgInst = new QRCodeStyling({ ...buildOptions(lastContent), type: 'svg' });
    svgInst.download({ name, extension: 'svg' });

  } else if (ext === 'jpg') {
    qrCode.getRawData('png').then(blob => {
      const objUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(objUrl);
        c.toBlob(jpgBlob => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(jpgBlob);
          a.download = name + '.jpg';
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        }, 'image/jpeg', 0.92);
      };
      img.src = objUrl;
    }).catch(() => toast('JPEG export failed', 'warn'));

  } else if (ext === 'transparent') {
    // PNG with transparent background — override backgroundOptions
    const tOpts = { ...buildOptions(lastContent), backgroundOptions: { color: 'transparent' }, type: 'canvas' };
    const tInst = new QRCodeStyling(tOpts);
    tInst.download({ name: name + '-transparent', extension: 'png' });
  }
}

async function copyImg() {
  if (!qrCode) return;
  try {
    const blob = await qrCode.getRawData('png');
    if (!blob) throw new Error('no data');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Copied to clipboard ✓', 'success');
  } catch (_) {
    const canvas = document.querySelector('#qrDisplay canvas');
    if (!canvas) { toast('Copy failed — please download instead', 'warn'); return; }
    canvas.toBlob(async b => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]);
        toast('Copied ✓', 'success');
      } catch { toast('Clipboard not supported — download instead', 'warn'); }
    });
  }
}

// ── Scan verification ─────────────────────────────────────────────────────────
async function runScanTest() {
  const resultEl = document.getElementById('scanResult');
  resultEl.style.display = 'flex';
  resultEl.className = 'scan-result alert alert-info';
  resultEl.textContent = 'Scanning…';

  const canvas = document.querySelector('#qrDisplay canvas');
  if (!canvas) { resultEl.textContent = 'No QR generated yet.'; return; }

  if (!('BarcodeDetector' in window)) {
    resultEl.className = 'scan-result alert alert-warn';
    resultEl.innerHTML = '⚠️ In-browser scan test requires Chrome or Edge 83+. To verify: open your camera app and point it at the QR code above.';
    return;
  }

  try {
    const bd      = new BarcodeDetector({ formats: ['qr_code'] });
    const results = await bd.detect(canvas);
    if (results.length > 0) {
      const decoded = results[0].rawValue;
      resultEl.className = 'scan-result alert alert-success';
      resultEl.textContent = `✓ Scannable — "${decoded.length > 80 ? decoded.slice(0,80)+'…' : decoded}"`;
    } else {
      resultEl.className = 'scan-result alert alert-warn';
      resultEl.textContent = '⚠ Could not decode — try higher error correction or a simpler dot style';
    }
  } catch (e) {
    resultEl.className = 'scan-result alert alert-warn';
    resultEl.textContent = `Scan test error: ${e.message}`;
  }
}

// ── Preset themes ──────────────────────────────────────────────────────────────
function applyTheme(name) {
  const T = {
    classic: { dot:'#000000', bg:'#ffffff', eye:'#000000', dg:false, dotType:'square',         es:'square',        ed:'square' },
    dark:    { dot:'#00f5c8', bg:'#0a0a1a', eye:'#00f5c8', dg:false, dotType:'rounded',        es:'extra-rounded', ed:'dot'    },
    ocean:   { bg:'#ffffff',  eye:'#6366f1', dg:true, dotType:'dots',          es:'extra-rounded', ed:'dot',    d1:'#0ea5e9', d2:'#6366f1', dt:'linear', da:45  },
    sunset:  { bg:'#fff7ed',  eye:'#ec4899', dg:true, dotType:'rounded',       es:'extra-rounded', ed:'dot',    d1:'#f97316', d2:'#ec4899', dt:'linear', da:135 },
    forest:  { bg:'#f0fdf4',  eye:'#059669', dg:true, dotType:'dots',          es:'square',        ed:'square', d1:'#22c55e', d2:'#059669', dt:'linear', da:90  },
    neon:    { bg:'#07070f',  eye:'#f0abfc', dg:true, dotType:'extra-rounded', es:'extra-rounded', ed:'dot',    d1:'#00f5c8', d2:'#818cf8', dt:'linear', da:45  },
    gold:    { bg:'#fffbeb',  eye:'#f59e0b', dg:true, dotType:'classy-rounded',es:'square',        ed:'square', d1:'#f59e0b', d2:'#d97706', dt:'radial', da:0   },
    candy:   { bg:'#fdf4ff',  eye:'#ec4899', dg:true, dotType:'extra-rounded', es:'extra-rounded', ed:'dot',    d1:'#f0abfc', d2:'#818cf8', dt:'linear', da:135 },
  };
  const t = T[name]; if (!t) return;

  const check = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
  check('dotGradOn', t.dg);
  toggleGrad('dot');
  if (t.dg) {
    setVal('dotG1Color', t.d1); setVal('dotG1Hex', t.d1);
    setVal('dotG2Color', t.d2); setVal('dotG2Hex', t.d2);
    setVal('dotGradType', t.dt);
    setVal('dotGradAngle', t.da);
    const lbl = document.getElementById('dotAngLabel'); if (lbl) lbl.textContent = t.da;
  } else {
    setVal('dotColor', t.dot); setVal('dotHex', t.dot);
  }
  check('bgGradOn', false);
  toggleGrad('bg');
  setVal('bgColor', t.bg);   setVal('bgHex', t.bg);
  setVal('eyeColor', t.eye); setVal('eyeHex', t.eye);

  const chk = (nm, val) => {
    const r = document.querySelector(`input[name="${nm}"][value="${val}"]`);
    if (r) r.checked = true;
  };
  chk('dots', t.dotType || 'square');
  chk('eyeSquare', t.es  || 'square');
  chk('eyeDot',    t.ed  || 'square');
  schedule();
}

// ── SHA-256 ───────────────────────────────────────────────────────────────────
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v; }

function toast(msg, type = 'info') {
  document.querySelectorAll('.toast').forEach(e => e.remove());
  const t = document.createElement('div');
  t.className = `toast alert alert-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.4s'; }, 2600);
  setTimeout(() => t.remove(), 3200);
}

document.addEventListener('DOMContentLoaded', init);

// ═══════════════════════════════════════════════════════════════════════════════
// URL Shortener Integration (optional — uses urls.insecure.co.nz)
//
// When enabled on a URL-type QR, the URL is first shortened via the URL
// shortener API. Click tracking (IP, UA, country, timestamp) is recorded
// there for each scan. The user's browser fingerprint is used as anonymous
// ownership so they can view their link's stats later.
//
// The fingerprint is: stable browser signals joined with '||', then sent
// as X-Fingerprint. The server HMAC-SHA256s it and returns X-Owner-Hash.
// We cache the hash in localStorage so subsequent calls don't re-derive.
//
// Privacy: The fingerprint never leaves the device in raw form to third
// parties — it only goes to qr.insecure.co.nz (same operator as this site).
// ═══════════════════════════════════════════════════════════════════════════════

const SHORTENER_BASE = 'https://urls.insecure.co.nz';
const FP_CACHE_KEY   = 'qrforge_fp_uuid';
const HASH_CACHE_KEY = 'qrforge_owner_hash';

async function buildFingerprint() {
  const signals = [
    navigator.userAgent,
    navigator.language,
    navigator.hardwareConcurrency,
    navigator.deviceMemory || '',
    screen.width + 'x' + screen.height,
    screen.colorDepth,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    // navigator.platform is deprecated (removed/empty in Chrome 110+) — omitted
    navigator.cookieEnabled,
  ];

  // Stable UUID stored locally — makes fingerprint persistent across visits
  let uuid = localStorage.getItem(FP_CACHE_KEY);
  if (!uuid) {
    uuid = crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36));
    localStorage.setItem(FP_CACHE_KEY, uuid);
  }
  signals.push(uuid);

  // Canvas fingerprint for extra entropy
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#00f5c8';
    ctx.fillText('QRForge', 2, 2);
    signals.push(c.toDataURL());
  } catch (_) {}

  return signals.join('||');
}

async function shortenUrl(longUrl) {
  const rawFp = await buildFingerprint();

  // Hash the fingerprint before sending to avoid giant header (canvas dataURL alone
  // can be 5-10KB which exceeds many proxy/server header limits and gets truncated).
  // The server's _security.js receives this hash as the "rawFingerprint" and HMACs it
  // with OWNER_HASH_SECRET to produce the stable ownerHash.
  const fpHashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawFp));
  const fpHex     = Array.from(new Uint8Array(fpHashBuf)).map(b => b.toString(16).padStart(2,'0')).join('');

  // Cached owner hash from a previous shorten (avoids server round-trip)
  const cachedHash = localStorage.getItem(HASH_CACHE_KEY) || '';

  const headers = {
    'Content-Type':  'application/json',
    'X-Fingerprint': fpHex,  // send the SHA-256 hash, not the raw string (header size safety)
  };
  if (cachedHash) headers['X-Owner-Hash'] = cachedHash;

  const res = await fetch(`${SHORTENER_BASE}/api/shorten`, {
    method:  'POST',
    headers,
    body:    JSON.stringify({ url: longUrl }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Shortener returned ${res.status}`);
  }

  const data = await res.json();

  // Cache the server-derived owner hash so future calls link to same identity
  if (data.ownerHash) localStorage.setItem(HASH_CACHE_KEY, data.ownerHash);

  return data.shortUrl;
}

// Called by the "Track clicks" toggle in the URL tab
let _applyShortenerBusy = false;
async function applyShortener() {
  const toggle = document.getElementById('trackToggle');
  const status = document.getElementById('trackStatus');
  const urlInput = document.getElementById('in-url');
  if (!toggle || !status || !urlInput) return;
  if (_applyShortenerBusy) { toggle.checked = !toggle.checked; return; } // prevent re-entry

  if (!toggle.checked) {
    // Restore original URL if we had previously replaced it
    const original = urlInput.dataset.original;
    if (original) {
      urlInput.value = original;
      delete urlInput.dataset.original;
    }
    status.textContent = '';
    schedule();
    return;
  }

  const url = urlInput.value.trim();
  if (!url) { toggle.checked = false; return; }

  // Don't shorten if already a short URL from our domain
  if (url.startsWith(SHORTENER_BASE)) {
    status.textContent = '✓ Already shortened';
    return;
  }

  status.textContent = '⟳ Shortening…';
  _applyShortenerBusy = true;
  try {
    const short = await shortenUrl(url);
    urlInput.dataset.original = url;  // preserve original so toggle-off restores it
    urlInput.value = short;
    status.textContent = `✓ ${short} — click tracking active`;
    schedule();
  } catch (e) {
    toggle.checked = false;
    status.textContent = `✗ ${e.message}`;
    toast('Shortener unavailable — using original URL', 'warn');
  } finally {
    _applyShortenerBusy = false;
  }
}
