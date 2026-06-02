# QRForge

> **Free · Open Source · No Third-Party Tracking**  
> https://qr.insecure.co.nz · [GitHub](https://github.com/SethBodine/qr)

---

## Features

### 🎨 QR Code Generator — Full Premium Feature Set
| Feature | QRForge | Paid tools |
|---|---|---|
| Custom dot styles (6 patterns) | ✅ | ✅ |
| Gradient dots (linear + radial) | ✅ | ✅ |
| Gradient background | ✅ | ✅ |
| Custom eye/finder patterns | ✅ | ✅ |
| Per-eye colour override | ✅ | ✅ |
| Logo overlay with padding | ✅ | ✅ |
| **14 content types** | ✅ | ✅ |
| PNG export up to 2048px | ✅ | ✅ |
| JPEG export | ✅ | ✅ |
| Transparent PNG export | ✅ | ✅ |
| True vector SVG export | ✅ | ✅ |
| One-click copy to clipboard | ✅ | ✅ |
| Print support | ✅ | ✅ |
| Preset themes | ✅ | ✅ |
| SHA-256 content hash | ✅ | ❌ |
| Scan verification in browser | ✅ | ❌ |
| URL click tracking (via shortener) | ✅ | ❌ paid |
| No watermark | ✅ | ❌ paid |
| No account | ✅ | ❌ |

**14 content types:** URL, Text, Wi-Fi, vCard, Email, Phone, SMS, Location, Event, WhatsApp, Telegram, Bitcoin, PayPal, App Store.

### 📡 QR File Transfer
- Stream files device-to-device using QR codes — no cloud, no server storage, no apps to install
- Auto-calibration measures render throughput and picks the largest safe chunk size for your device
- pako/deflate compression for text-based files
- SHA-256 integrity verified on receiver before any download link is shown
- Up to **100 files · 1 GB total** per session
- **Discord logging** of transfer metadata (filename, size, SHA-256, IPs) via Cloudflare secret

---

## How to Transfer a File

### Sending
1. Open **File Transfer** on the sending device
2. Drag and drop files (or click to browse) — up to 100 files, 1 GB total
3. Click **⚡ Calibrate** — the tool displays test frames and measures how fast your screen can render them; this takes about 5 seconds and only needs to be done once per device
4. Click **▶ Start** — QR frames begin cycling automatically
5. Keep the screen visible and steady; do not lock the screen

### Receiving
1. Open **File Transfer** on the receiving device and click **Start Camera**
2. Point the camera at the sender's screen — scanning begins immediately
3. A progress bar tracks how many frames have been captured
4. When all frames are received, SHA-256 checksums are verified automatically
5. A **↓ Save** link appears for each file — tap to download to your device

**Tips:**
- Use calibration in the actual lighting conditions you'll be transferring in
- If scanning stalls, reduce the chunk size preset on the sender (Small → Medium → Large → XL)
- Files stay entirely in browser memory — nothing is uploaded anywhere

---

## Deploy (5 minutes)

### Project structure
```
qrforge/
├── index.html            # QR Generator (single-page, no build step)
├── transfer.html         # File Transfer (single-page, no build step)
├── assets/
│   ├── css/style.css
│   └── js/
│       ├── qr-generator.js
│       └── transfer.js
├── functions/
│   └── api/
│       └── log.js        # Cloudflare Pages Function — posts transfer metadata to Discord
├── _headers              # Cloudflare Pages security headers (deployed)
├── public/_headers       # Headers for `vite dev` only — not deployed
├── wrangler.toml         # Cloudflare project config (name, output dir, env vars)

```

> **"Zero backend" clarification:** QRForge has no database, no file storage, and no user accounts. There is one Cloudflare Pages Function (`/api/log`) that receives transfer metadata from the browser and forwards it to a Discord webhook. No data is stored — the Function is stateless. All file data stays in browser memory.

### Option A — Cloudflare Pages GUI
1. Fork this repo on GitHub
2. [Cloudflare Pages](https://pages.cloudflare.com) → **Create project** → **Connect Git** → select your fork
3. Build settings: **Build command** *(leave empty)* · **Output directory** `.`
4. Click **Save and Deploy** — done

**Custom domain** (e.g. `qr.yourdomain.com`):
- Cloudflare Dashboard → Pages → `qrforge` → **Custom domains** → **Set up a custom domain**
- Enter your subdomain and follow the DNS instructions (adds a CNAME automatically if your domain is on Cloudflare)

To enable Discord logging:
- Cloudflare Dashboard → Pages → `qrforge` → **Settings** → **Environment variables**
- Add `DISCORD_WEBHOOK_URL` (type: **Secret**) = your Discord webhook URL

### Option B — Wrangler CLI
```bash
npm install -g wrangler
wrangler login
wrangler pages deploy . --project-name qrforge

# Add Discord webhook secret
wrangler secret put DISCORD_WEBHOOK_URL
```

`wrangler.toml` sets the project name and output directory so you don't need to pass flags on every deploy. Secrets set via `wrangler secret put` are encrypted at rest and never appear in logs or git history.



---

## Protocol Specification

### Frame types

```
HDR  { t:'H', sid, v:1, files:[{i,n,s,h,tc,z}], total }
DAT  { t:'D', s, fi, ci, d }     ← s=global seq, d=base64url chunk
END  { t:'E', sid, total }
CAL  { t:'C', seq, sz, d }       ← calibration probe
```

### Transfer flow
```
Sender:  [HDR×5] [DAT×N...] [END×5]  → loops continuously
Receiver: deduplicates by (fi,ci) → reassembles → SHA-256 → download
```

### Chunk sizes (error correction H)
| Preset | Bytes/frame | Typical use |
|---|---|---|
| Small  | 80  | Very slow cameras, high interference |
| Medium | 220 | Default / calibrated safe minimum |
| Large  | 460 | Good lighting, steady hands |
| XL     | 820 | Ideal conditions, tripod |

### Calibration
Displays **42 test frames** (7 chunk sizes × 6 frames per size) at a fixed 8 fps target and measures actual render time per frame. Picks the largest chunk size whose median render time stays at or below 160 ms, then backs off the display rate by 20% to leave headroom. Caps at 15 fps since camera scan rate — not screen render rate — is the real bottleneck. The error correction level is fixed at H throughout.

---

## Dependencies

| Library | Version | Used in | Purpose |
|---|---|---|---|
| [qr-code-styling](https://github.com/kozakdenys/qr-code-styling) | 1.9.2 | Generator | Styled QR rendering — gradients, logos, dot patterns |
| [qrcodejs](https://github.com/davidshimjs/qrcodejs) | 1.0.0 | File Transfer | Fast QR generation for the high-frequency transfer frames |
| [pako](https://github.com/nodeca/pako) | 2.1.0 | File Transfer | zlib/deflate compression of text-based file chunks |

All three are loaded from jsDelivr CDN with **Subresource Integrity (SRI)** hashes — browsers will refuse to execute them if the CDN serves tampered files.

---

## Security

- **All file data stays in memory** — no server, no temp files, no IndexedDB
- **SHA-256 verified** before any download link is rendered on the receiver
- **Filenames sanitised** on both sender (before encoding) and receiver (on header parse)
- **Input validation** on all received frame fields — bounds-checked, length-capped
- **No innerHTML on received data** — `textContent` / `createElement` only
- **CORS** locked to production domain on the `/api/log` endpoint (preview URLs also allowed during development)
- **Body limit** of 64 KB on the `/api/log` endpoint
- **Webhook URL validated** server-side before use
- **Session IDs** generated with `crypto.getRandomValues` (cryptographically random)
- **CSP** restricts script sources, blocks frames and objects; `unsafe-eval` is limited to `transfer.html` where `qrcodejs` requires it
- **Security headers**: `X-Frame-Options: DENY`, `COOP: same-origin`, `CORP: same-origin`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`
- **SRI hashes** on all CDN scripts — browsers reject tampered library files
- **Discord webhook** stored as Cloudflare secret — never in git
- **Camera permission** only requested when user actively clicks **Start Camera**
- **`form-action 'none'`** in CSP — no form submissions permitted
- **`robots.txt`** blocks crawlers from `/api/` endpoints
- No cookies, no third-party analytics or tracking
- URL click tracking is **opt-in only** and clearly labelled; a tooltip discloses what is collected before the user enables it

---

## Browser Support

| Feature | Chrome | Edge | Firefox | Safari |
|---|---|---|---|---|
| QR Generator | ✅ | ✅ | ✅ | ✅ |
| File Transfer (Send) | ✅ | ✅ | ✅ | ✅ |
| File Transfer (Receive) | ✅ 83+ | ✅ 83+ | ❌* | ❌* |
| Copy to clipboard | ✅ | ✅ | ✅ 87+ | ✅ 13.1+ |

\* Firefox and Safari do not support `BarcodeDetector`. Receive shows a clear warning.
  Users on those browsers can send but not receive. The QR generator works everywhere.
