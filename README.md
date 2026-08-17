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
- **Fountain-coded (LT/Luby transform)** — the receiver rebuilds the file from *any* ~k×1.15 distinct frames in *any* order. Dropped or blurred frames cost a little time, never correctness, and there's no rewind/resync logic because there's nothing to resync.
- **No backend involved in the transfer itself** — sender and receiver never call any server. Everything travels as light: the sender streams QR frames, the receiver's camera decodes them straight off the screen. Works identically whether the two devices are next to each other, across a room, online, or fully air-gapped.
- A join-link QR is shown as a convenience (it opens the receiver straight into Receive mode) — it's a plain client-side URL, nothing is posted anywhere to create or use it.
- Local-only calibration: measures *this device's own* render throughput using the exact same render path live transmission uses, so the numbers it reports are the numbers you get. Never waits on the network or the receiver.
- pako/deflate compression for text-based files
- SHA-256 integrity verified on receiver before any download link is shown
- Up to **100 files** per session, **~60 MB total** in one optical stream (see [Protocol Specification](#protocol-specification) for why)
- **Discord logging** of transfer metadata (filename, size, SHA-256, IPs) via Cloudflare secret — an owner-side record, independent of the transfer itself

---

## How to Transfer a File

### Sending
1. Open **File Transfer** on the sending device
2. Drag and drop files (or click to browse) — up to 100 files
3. Click **▶ Send** — the tool briefly calibrates its own render speed, packs your files, then starts an endless fountain-coded QR stream
4. Keep the screen visible and steady; do not lock the screen. There's no "done" state to wait for on the sender — stop manually once the receiver has the file

### Receiving
1. Open **File Transfer** on the receiving device and click **Start Camera** (or scan the sender's join-link QR, which does this for you)
2. Point the camera at the sender's screen — decoding begins the moment one valid frame is seen, from anywhere in the stream
3. A progress bar estimates completion from unique frames collected vs. the fountain code's expected overhead
4. Once enough blocks are collected, SHA-256 checksums are verified automatically per file
5. A **↓ Save** link appears for each file — tap to download to your device

**Tips:**
- If scanning stalls, reduce the chunk size preset on the sender (Small → Medium → Large → XL) — smaller frames decode more reliably in poor lighting at the cost of needing more of them
- Filenames only appear once the transfer is nearly complete — the file directory is fountain-coded along with the data, so (like the [decimen](https://github.com/bashalarmistalt/decimen-optical-transfer) project this protocol is adapted from) there's no separate "header" frame to reveal them early. The incoming size and block count ARE shown from the very first frame.
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
├── public/site.webmanifest # PWA manifest (deployed)
├── wrangler.toml         # Cloudflare project config (name, output dir, env vars)
└── .github/
    └── workflows/
        └── deploy.yml    # GitHub Actions workflow — deploys to Cloudflare Pages on push to main
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

### Option C — GitHub Actions (auto-deploy on push to `main`)

The workflow lives at `.github/workflows/deploy.yml`. It runs on every push to `main` and on pull requests. It checks out the repo and calls `cloudflare/wrangler-action@v3` (the official, actively maintained successor to the now-deprecated `pages-action`) to deploy the output directory `.` to Cloudflare Pages.

Add these two secrets to your GitHub repository (**Settings → Secrets and variables → Actions**):

| Secret | Where to find it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) — create with **Cloudflare Pages: Edit** permission |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard → right sidebar |

Push to `main` — CI handles the rest. Pull requests automatically get a preview URL at `https://<hash>.qrforge.pages.dev`.

---

## Protocol Specification

**v5 (fountain-coded, no backend).** File Transfer used to send a strict
sequence of `{fileIndex, chunkIndex}` chunks and lean on the receiver's ACK,
relayed through a Cloudflare Pages Function + KV store, to tell the sender
where to rewind to after a pause — workable on a phone with a steady
connection, fragile everywhere else, and outright unusable on a laptop pair
with no network path between them at all. It also carried a "networked vs
airgap" mode toggle that, in practice, never changed how the file itself
moved — both modes always streamed the same optical QR sequence; the toggle
only gated an advisory progress readout. That readout depended on
infrastructure — a KV-backed relay — that's awkward to debug from a phone
and had nothing to do with whether a QR code can be read off a screen, so
it's gone. v5 ports the core protocol from
[bashalarmistalt/decimen-optical-transfer](https://github.com/bashalarmistalt/decimen-optical-transfer)'s
MIT-licensed v0.3.0 release (credit Evan Crawley; that project relicensed to
AGPL at v0.4.0, so this port is taken from, and stays pinned to, the earlier
MIT tag) — an LT (Luby transform) fountain code — and adds a multi-file
container on top of it. Full credit for the fountain-coding design and the
original writeup: see that project's
[docs/technical/protocol.md](https://github.com/bashalarmistalt/decimen-optical-transfer/blob/main/docs/technical/protocol.md).

### Why fountain coding

A screen-to-camera link has no back-channel: frames get missed to blur,
autofocus hunting, and refresh-cycle straddling. The old protocol looped a
fixed frame sequence and depended on the receiver telling the sender where it
got stuck. Two failure modes fell out of that:

- **The rewind math broke on large transfers.** The global sequence number
  was a `uint16` (wraps at 65,536); the rewind logic searched for the first
  un-acked frame by comparing wrapped sequence numbers, which is ambiguous
  once a transfer has looped past 65,536 chunks. Large transfers could
  silently resume at the wrong offset.
- **Starting at all required a network round trip.** The sender wouldn't
  leave "waiting for receiver" until it heard back from a KV-backed ACK
  relay — a non-starter for two air-gapped laptops with no route to that
  endpoint, and a source of confusing stalls even on a normal connection
  whenever the relay itself had a bad moment.

Fountain coding removes both problems by construction. The sender emits an
endless stream of frames; frame `seq` XORs together a pseudorandom subset of
the file's blocks (subset size drawn from a robust-soliton distribution, subset
membership derived deterministically from `seq`). The receiver reconstructs
the file from **any** ~k×1.15 distinct frames, in **any** order — a dropped
frame costs a little time, never correctness, and pausing/resuming is just
"stop and later keep counting from the same `seq`." No rewind, because
there's nothing to rewind to.

### Wire format

Each QR encodes `base64url( 20-byte header || fountain block )`:

```
offset  size  field         notes
0       u8    magic 0xD1
1       u8    magic 0x0C
2       u16   sessionId     random per Send click
4       u32   seq           drives the fountain PRNG — monotonic, never resets
8       u16   k             source block count
10      u16   blockLen      payload bytes per frame
12      u32   totalLen      length of the packed container
16      u32   payloadFnv    FNV-1a of the whole container
```

Every field a decoder needs to keep accepting frames — everything but `seq` —
is present on **every single frame**. There is no separate header frame and
no repeat-N-times handshake: a receiver that starts scanning mid-stream locks
on from the very next frame it sees.

### Container (multi-file)

The bytes fountain-coded inside the frames are QRForge's own directory format
— a small extension of decimen's single-file container to carry up to 100
files as one LT stream:

```
MAGIC "QRF2"                         4 bytes
fileCount                            u16
per file:
  nameLen u16, name (utf8)
  typeLen u16, type (utf8)
  compressed u8
  originalSize u32, transmittedSize u32
  sha256                             32 bytes
blob: concatenated transmitted bytes, one file after another
```

Because the directory is fountain-coded along with the data, filenames aren't
known until the stream is nearly fully decoded (same tradeoff decimen makes
for its single file). `totalLen`/`k`/`blockLen` ride on every frame, though,
so the receiver can show "~230 KB incoming" from frame one.

### No backend in the transfer path

The sender streams QR frames and the receiver decodes them off the camera —
that's the entire transfer, with no network call on either device, whether
they're across a desk or across a room, online or fully air-gapped. A
join-link QR is generated and read entirely client-side (`location.origin +
pathname + ?sid=`) purely so the receiver doesn't have to manually switch to
Receive mode; nothing is posted to produce or use it.

The one server call left anywhere in File Transfer is `/api/log` — a
one-way, fire-and-forget POST to a Discord webhook for the site owner's own
record of transfers (filename, size, SHA-256, IP). It has no effect on
whether a transfer succeeds; see the [API endpoints](#-api-endpoints) table
below.

### Chunk sizes (error correction H)
| Preset | Block bytes | Typical use |
|---|---|---|
| Small  | 80  | Very slow cameras, high interference |
| Medium | 220 | Default / calibrated safe minimum |
| Large  | 460 | Good lighting, steady hands |
| XL     | 820 | Ideal conditions, tripod |

Error correction stays fixed at **H** (30% codeword redundancy) rather than
dropping to L the way decimen does — decimen decodes with a dedicated
zxing-wasm worker reading raw pixels off the canvas; this app decodes with
the browser's native `BarcodeDetector`, which has less headroom on marginal
phone cameras, so the extra in-frame ECC is kept as a safety margin.

### Calibration

Renders **42 test frames** (7 sizes × 6 frames each) through the *exact same*
render path a live transfer uses — `new QRCode(...)` followed by a
double-`requestAnimationFrame`, which confirms an actual GPU composite rather
than a fixed `setTimeout` guess. (The old calibration used double-rAF too, but
live transmission paced itself with `setTimeout` and a hardcoded 30ms "paint
delay" — the two paths measured different things, so a calibration result
didn't necessarily describe what a real transfer would do. Sharing one
render function fixes that.) Calibration only measures this device's own
render throughput; it never waits on the receiver or the network.

### Practical size ceiling

`k` (source block count) is a `u16` on the wire — max 65,535 blocks. At the
largest chunk size that fits a version-40-H QR through this app's base64url
text encoding (~934 bytes), that puts the real ceiling around **61 MB per
transfer**, not the old flat "1 GB" claim. `Send` validates this up front —
same idea as decimen's `frame-capacity.ts` — and tells you which chunk-size
preset would fit, instead of failing partway through a multi-hour transfer.

---

## Dependencies

| Library | Version | Used in | Purpose |
|---|---|---|---|
| [qr-code-styling](https://github.com/kozakdenys/qr-code-styling) | 1.9.2 | Generator | Styled QR rendering — gradients, logos, dot patterns |
| [qrcodejs](https://github.com/davidshimjs/qrcodejs) | 1.0.0 | File Transfer | Fast QR generation for the high-frequency transfer frames |
| [pako](https://github.com/nodeca/pako) | 2.1.0 | File Transfer | zlib/deflate compression of text-based file chunks |

All three are loaded from jsDelivr CDN with **Subresource Integrity (SRI)** hashes — browsers will refuse to execute them if the CDN serves tampered files.

The fountain-coding protocol in `assets/js/transfer.js` (LT encoder/decoder,
frame header, capacity math, progress estimation) is ported from
[bashalarmistalt/decimen-optical-transfer](https://github.com/bashalarmistalt/decimen-optical-transfer)
by Evan Crawley, MIT licensed. No code or package from that repo is imported
at runtime — it's a from-scratch JS port of the relevant `shared/*.ts` files,
credited inline in the source comments.

### Cloudflare Pages Functions

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/log` | POST | Posts transfer metadata (filenames, sizes, SHA-256, IP, country) to a Discord webhook. Requires `DISCORD_WEBHOOK_URL` secret. Fire-and-forget — a failed or blocked request has no effect on the transfer itself. |

This is the only server-side endpoint File Transfer uses. It reads `ALLOWED_ORIGIN` from environment variables (set in `wrangler.toml` or Cloudflare dashboard). Cloudflare Pages preview URLs (`*.qrforge.pages.dev`) are always allowed for development.

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
- **Camera permission** only requested when user actively clicks **Start Camera**; browser support checked first with a specific actionable message if `BarcodeDetector` is absent
- **`form-action 'none'`** in CSP — no form submissions permitted
- **`robots.txt`** blocks crawlers from `/api/` endpoints
- **`/api/*` headers** set `Cache-Control: no-store, no-cache` to prevent any proxy caching of log responses
- No cookies, no third-party analytics or tracking
- URL click tracking is **opt-in only** and clearly labelled; a tooltip discloses what is collected before the user enables it

---

## Browser Support

| Feature | Chrome | Edge | Firefox | Safari | Chrome Android | Samsung Internet |
|---|---|---|---|---|---|---|
| QR Generator | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| File Transfer (Send) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| File Transfer (Receive) | ✅ 83+ | ✅ 83+ | ❌ | ❌ | ✅ | ✅ 13+ |
| Copy to clipboard | ✅ | ✅ | ✅ 87+ | ✅ 13.1+ | ✅ | ✅ |

Firefox and Safari do not implement the `BarcodeDetector` API. On these browsers the receive panel detects the missing API before requesting camera permission and shows a specific message identifying the browser and recommending a supported alternative. Sending works on all browsers.
