# Protocol tests (not part of the deployed site)

Standalone Node scripts that load `assets/js/transfer.js` into a sandboxed VM
with browser-API stubs (crypto, TextEncoder, btoa/atob, pako) and exercise
the fountain-coding protocol directly. They test the *actual shipped file*,
not a copy — so they can't silently drift out of sync with it.

Not wired into any build step or CI job (this repo has no build step, per
the main README). Run manually, or wire into GitHub Actions if you want a
pre-deploy gate.

## Run

    npm install        # pulls in pako, the only dependency these need
    node fountain-roundtrip.test.js
    node container-integration.test.js

## What they cover

- `fountain-roundtrip.test.js` — LTEncoder/LTDecoder round-trip under
  simulated frame loss and reordering, across payload sizes from 1 byte to
  ~3.3 MB and block lengths from 50–800 bytes, including a k≈65535 case near
  the u16 block-count ceiling.
- `container-integration.test.js` — the full pipeline: multi-file container
  pack → capacity validation → fountain encode → simulated lossy/reordered
  optical channel → fountain decode → container unpack → per-file SHA-256
  verification. Also checks the oversize-payload rejection path.
