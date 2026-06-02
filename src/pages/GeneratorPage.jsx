import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Download, Image, Palette, Settings2, RotateCcw,
  Link, Type, Wifi, User, Mail, Phone
} from 'lucide-react';

// Lazy-load qr-code-styling (it's heavy)
let QRCodeStyling = null;
async function getQRLib() {
  if (!QRCodeStyling) {
    const mod = await import('qr-code-styling');
    QRCodeStyling = mod.default;
  }
  return QRCodeStyling;
}

// ── Input type helpers ────────────────────────────────────────────────────────
const INPUT_TYPES = [
  { id: 'url',   label: 'URL',   icon: Link,  placeholder: 'https://example.com' },
  { id: 'text',  label: 'Text',  icon: Type,  placeholder: 'Any text or message...' },
  { id: 'email', label: 'Email', icon: Mail,  placeholder: 'user@example.com' },
  { id: 'phone', label: 'Phone', icon: Phone, placeholder: '+64 21 000 0000' },
  { id: 'wifi',  label: 'WiFi',  icon: Wifi,  placeholder: 'Network name' },
  { id: 'vcard', label: 'vCard', icon: User,  placeholder: 'Name' },
];

function buildQrData(type, fields) {
  switch (type) {
    case 'url':   return fields.value || 'https://qrforge.dev';
    case 'text':  return fields.value || '';
    case 'email': return `mailto:${fields.value || ''}`;
    case 'phone': return `tel:${fields.value || ''}`;
    case 'wifi':  return `WIFI:T:${fields.security || 'WPA'};S:${fields.value || ''};P:${fields.password || ''};;`;
    case 'vcard': return [
      'BEGIN:VCARD', 'VERSION:3.0',
      `FN:${fields.value || ''}`,
      fields.org   ? `ORG:${fields.org}`      : '',
      fields.tel   ? `TEL:${fields.tel}`      : '',
      fields.email ? `EMAIL:${fields.email2}` : '',
      fields.url2  ? `URL:${fields.url2}`     : '',
      'END:VCARD',
    ].filter(Boolean).join('\n');
    default: return fields.value || '';
  }
}

// ── Dot style SVG previews ────────────────────────────────────────────────────
const DOT_STYLES = [
  { id: 'square',        label: 'Square',    preview: '▪▪▪' },
  { id: 'dots',          label: 'Dots',      preview: '●●●' },
  { id: 'rounded',       label: 'Rounded',   preview: '▫▫▫' },
  { id: 'classy',        label: 'Classy',    preview: '◆◆◆' },
  { id: 'classy-rounded',label: 'Classy+',   preview: '◈◈◈' },
  { id: 'extra-rounded', label: 'Fluid',     preview: '⬡⬡⬡' },
];

const CORNER_STYLES = [
  { id: 'square',        label: 'Square' },
  { id: 'dot',           label: 'Dot'    },
  { id: 'extra-rounded', label: 'Round'  },
];

const EC_LEVELS = [
  { id: 'L', label: 'L — Low (7%)',      note: 'More data, less resilience' },
  { id: 'M', label: 'M — Medium (15%)',  note: 'Balanced' },
  { id: 'Q', label: 'Q — High (25%)',    note: 'Good for logos' },
  { id: 'H', label: 'H — Highest (30%)', note: 'Best for logos, less data' },
];

// ── Preset themes ─────────────────────────────────────────────────────────────
const PRESETS = [
  { id: 'classic',  label: 'Classic',  fg: '#000000', bg: '#ffffff', dotType: 'square',        cornerType: 'square' },
  { id: 'dots',     label: 'Bubbly',   fg: '#1a1a2e', bg: '#ffffff', dotType: 'dots',           cornerType: 'dot' },
  { id: 'rounded',  label: 'Soft',     fg: '#2d6a4f', bg: '#ffffff', dotType: 'rounded',        cornerType: 'extra-rounded' },
  { id: 'dark',     label: 'Dark',     fg: '#e8ede8', bg: '#0d0f0e', dotType: 'classy-rounded', cornerType: 'extra-rounded' },
  { id: 'neon',     label: 'Neon',     fg: '#4ade80', bg: '#0d0f0e', dotType: 'dots',           cornerType: 'dot' },
  { id: 'classy',   label: 'Classy',   fg: '#1a0533', bg: '#f3f0ff', dotType: 'classy',         cornerType: 'square' },
];

export default function GeneratorPage() {
  // ── State ──
  const [inputType, setInputType] = useState('url');
  const [fields, setFields]       = useState({ value: 'https://qrforge.dev' });
  const [dotType,    setDotType]    = useState('rounded');
  const [cornerType, setCornerType] = useState('extra-rounded');
  const [fgColor,    setFgColor]    = useState('#000000');
  const [bgColor,    setBgColor]    = useState('#ffffff');
  const [ecLevel,    setEcLevel]    = useState('Q');
  const [logoDataUrl, setLogoDataUrl] = useState(null);
  const [logoSize,   setLogoSize]   = useState(25);
  const [logoHideBg, setLogoHideBg] = useState(true);
  const [qrSize,     setQrSize]     = useState(320);
  const [ready,      setReady]      = useState(false);

  const qrRef        = useRef(null);
  const containerRef = useRef(null);
  const qrInstance   = useRef(null);

  // ── Init QR ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const Lib = await getQRLib();
      if (cancelled) return;
      qrInstance.current = new Lib({
        width: qrSize, height: qrSize,
        data: buildQrData(inputType, fields),
        image: logoDataUrl || undefined,
        qrOptions: { errorCorrectionLevel: ecLevel },
        dotsOptions: { type: dotType, color: fgColor },
        cornersSquareOptions: { type: cornerType, color: fgColor },
        cornersDotOptions: { color: fgColor },
        backgroundOptions: { color: bgColor },
        imageOptions: {
          hideBackgroundDots: logoHideBg,
          imageSize: logoSize / 100,
          margin: 6,
          crossOrigin: 'anonymous',
        },
      });
      if (containerRef.current) {
        qrInstance.current.append(containerRef.current);
      }
      setReady(true);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Update QR on any change ──
  useEffect(() => {
    if (!qrInstance.current) return;
    qrInstance.current.update({
      data: buildQrData(inputType, fields),
      image: logoDataUrl || undefined,
      width: qrSize, height: qrSize,
      qrOptions: { errorCorrectionLevel: ecLevel },
      dotsOptions: { type: dotType, color: fgColor },
      cornersSquareOptions: { type: cornerType, color: fgColor },
      cornersDotOptions: { color: fgColor },
      backgroundOptions: { color: bgColor },
      imageOptions: {
        hideBackgroundDots: logoHideBg,
        imageSize: logoSize / 100,
        margin: 6,
        crossOrigin: 'anonymous',
      },
    });
  }, [inputType, fields, dotType, cornerType, fgColor, bgColor,
      ecLevel, logoDataUrl, logoSize, logoHideBg, qrSize]);

  const handleLogoUpload = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setLogoDataUrl(ev.target.result);
    reader.readAsDataURL(file);
  }, []);

  const applyPreset = (preset) => {
    setFgColor(preset.fg);
    setBgColor(preset.bg);
    setDotType(preset.dotType);
    setCornerType(preset.cornerType);
  };

  const reset = () => {
    setFgColor('#000000');
    setBgColor('#ffffff');
    setDotType('rounded');
    setCornerType('extra-rounded');
    setLogoDataUrl(null);
    setLogoSize(25);
    setEcLevel('Q');
  };

  const download = async (ext) => {
    if (!qrInstance.current) return;
    await qrInstance.current.download({ name: 'qrforge', extension: ext });
  };

  const field = (key) => fields[key] || '';
  const setField = (key, val) => setFields(f => ({ ...f, [key]: val }));

  const currentInputType = INPUT_TYPES.find(t => t.id === inputType);

  return (
    <div className="anim">
      <div className="page-header">
        <h1>QR <span className="hl">Generator</span></h1>
        <p>Create styled QR codes with custom logos, colors, and dot patterns. Free, no limits, no account.</p>
      </div>

      <div className="grid-2" style={{ gap: '24px' }}>

        {/* ── LEFT PANEL — Controls ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

          {/* Input type selector */}
          <div className="card">
            <div className="card-title"><span className="dot" />Content</div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px' }}>
              {INPUT_TYPES.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => { setInputType(id); setFields({ value: '' }); }}
                  className={`btn btn-sm ${inputType === id ? 'btn-primary' : 'btn-ghost'}`}
                >
                  <Icon size={12} />
                  {label}
                </button>
              ))}
            </div>

            {/* Dynamic fields */}
            {inputType === 'wifi' ? (
              <>
                <div className="field">
                  <label>Network Name (SSID)</label>
                  <input type="text" value={field('value')} placeholder="My WiFi" onChange={e => setField('value', e.target.value)} />
                </div>
                <div className="row">
                  <div className="field">
                    <label>Password</label>
                    <input type="text" value={field('password')} placeholder="Password" onChange={e => setField('password', e.target.value)} />
                  </div>
                  <div className="field" style={{ maxWidth: '120px' }}>
                    <label>Security</label>
                    <select value={field('security') || 'WPA'} onChange={e => setField('security', e.target.value)}>
                      <option value="WPA">WPA/WPA2</option>
                      <option value="WEP">WEP</option>
                      <option value="nopass">None</option>
                    </select>
                  </div>
                </div>
              </>
            ) : inputType === 'vcard' ? (
              <>
                <div className="row">
                  <div className="field">
                    <label>Full Name</label>
                    <input type="text" value={field('value')} placeholder="Jane Smith" onChange={e => setField('value', e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Organisation</label>
                    <input type="text" value={field('org')} placeholder="Acme Ltd" onChange={e => setField('org', e.target.value)} />
                  </div>
                </div>
                <div className="row">
                  <div className="field">
                    <label>Phone</label>
                    <input type="text" value={field('tel')} placeholder="+64 21 000 0000" onChange={e => setField('tel', e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Email</label>
                    <input type="text" value={field('email2')} placeholder="jane@acme.com" onChange={e => setField('email2', e.target.value)} />
                  </div>
                </div>
                <div className="field">
                  <label>Website</label>
                  <input type="text" value={field('url2')} placeholder="https://acme.com" onChange={e => setField('url2', e.target.value)} />
                </div>
              </>
            ) : (
              <div className="field">
                <label>{currentInputType?.label}</label>
                <textarea
                  value={field('value')}
                  placeholder={currentInputType?.placeholder}
                  onChange={e => setField('value', e.target.value)}
                  rows={inputType === 'text' ? 4 : 2}
                />
              </div>
            )}
          </div>

          {/* Style */}
          <div className="card">
            <div className="card-title"><span className="dot" />Dot Style</div>
            <div className="style-grid">
              {DOT_STYLES.map(s => (
                <React.Fragment key={s.id}>
                  <input type="radio" name="dotStyle" id={`ds-${s.id}`} className="style-option"
                    checked={dotType === s.id} onChange={() => setDotType(s.id)} />
                  <label htmlFor={`ds-${s.id}`} className="style-label">
                    <span className="style-preview" style={{ letterSpacing: '2px' }}>{s.preview}</span>
                    {s.label}
                  </label>
                </React.Fragment>
              ))}
            </div>

            <div style={{ marginTop: '14px' }}>
              <div className="card-title" style={{ marginBottom: '8px' }}><span className="dot" />Corner Style</div>
              <div style={{ display: 'flex', gap: '8px' }}>
                {CORNER_STYLES.map(s => (
                  <button key={s.id}
                    className={`btn btn-sm ${cornerType === s.id ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setCornerType(s.id)}
                  >{s.label}</button>
                ))}
              </div>
            </div>
          </div>

          {/* Colours */}
          <div className="card">
            <div className="card-title"><span className="dot" />Colors</div>

            {/* Presets */}
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px' }}>
              {PRESETS.map(p => (
                <button key={p.id}
                  className="btn btn-sm btn-ghost"
                  onClick={() => applyPreset(p)}
                  style={{ fontSize: '0.72rem' }}
                >
                  <span style={{
                    display: 'inline-block', width: 10, height: 10,
                    borderRadius: 3, background: p.fg, border: '1px solid #444', marginRight: 2
                  }} />
                  {p.label}
                </button>
              ))}
            </div>

            <div className="row">
              <div className="field">
                <label>Foreground</label>
                <div className="color-row">
                  <input type="color" value={fgColor} onChange={e => setFgColor(e.target.value)} />
                  <input type="text" value={fgColor} onChange={e => setFgColor(e.target.value)} placeholder="#000000" />
                </div>
              </div>
              <div className="field">
                <label>Background</label>
                <div className="color-row">
                  <input type="color" value={bgColor} onChange={e => setBgColor(e.target.value)} />
                  <input type="text" value={bgColor} onChange={e => setBgColor(e.target.value)} placeholder="#ffffff" />
                </div>
              </div>
            </div>
          </div>

          {/* Logo */}
          <div className="card">
            <div className="card-title"><span className="dot" />Logo / Image</div>
            <div className="field">
              <label>Upload Image (PNG, SVG, JPG)</label>
              <input type="file" accept="image/*"
                onChange={handleLogoUpload}
                style={{ display: 'none' }}
                id="logo-upload"
              />
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <label htmlFor="logo-upload" className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
                  <Image size={13} /> Choose file
                </label>
                {logoDataUrl && (
                  <>
                    <img src={logoDataUrl} alt="logo preview"
                      style={{ width: 32, height: 32, objectFit: 'contain', border: '1px solid var(--border)', borderRadius: 4 }}
                    />
                    <button className="btn btn-ghost btn-sm" onClick={() => setLogoDataUrl(null)}>Remove</button>
                  </>
                )}
              </div>
            </div>

            {logoDataUrl && (
              <>
                <div className="field">
                  <label>Logo Size — {logoSize}%</label>
                  <div className="range-row">
                    <input type="range" min="10" max="40" step="1"
                      value={logoSize} onChange={e => setLogoSize(Number(e.target.value))} />
                    <span className="range-val">{logoSize}%</span>
                  </div>
                </div>
                <div className="field" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input type="checkbox" id="logo-hidebg" checked={logoHideBg}
                    onChange={e => setLogoHideBg(e.target.checked)}
                    style={{ width: 'auto', accentColor: 'var(--accent)' }}
                  />
                  <label htmlFor="logo-hidebg" style={{ marginBottom: 0, textTransform: 'none', letterSpacing: 0 }}>
                    Hide QR dots behind logo
                  </label>
                </div>
              </>
            )}
          </div>

          {/* Advanced */}
          <div className="card">
            <div className="card-title"><span className="dot" />Advanced</div>
            <div className="row">
              <div className="field">
                <label>Error Correction</label>
                <select value={ecLevel} onChange={e => setEcLevel(e.target.value)}>
                  {EC_LEVELS.map(l => (
                    <option key={l.id} value={l.id}>{l.label}</option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ maxWidth: '130px' }}>
                <label>Size (px)</label>
                <select value={qrSize} onChange={e => setQrSize(Number(e.target.value))}>
                  {[200, 256, 320, 400, 512, 600, 800, 1024].map(s => (
                    <option key={s} value={s}>{s}×{s}</option>
                  ))}
                </select>
              </div>
            </div>
            {logoDataUrl && ecLevel === 'L' && (
              <div className="alert alert-warn mt-2">
                ⚠ Using a logo with low error correction may make the QR unreadable. Use Q or H.
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT PANEL — Preview ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="card" style={{ position: 'sticky', top: '72px' }}>
            <div className="flex-between mb-2">
              <div className="card-title" style={{ marginBottom: 0 }}><span className="dot" />Preview</div>
              <button className="btn btn-ghost btn-sm" onClick={reset}>
                <RotateCcw size={12} /> Reset
              </button>
            </div>

            <div className="qr-wrap" style={{ background: bgColor, minHeight: '320px' }}>
              {!ready && <div className="spinner" />}
              <div ref={containerRef} />
            </div>

            {/* Download */}
            <div style={{ marginTop: '16px' }}>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '8px', fontWeight: 500 }}>
                Download
              </div>
              <div className="btn-group">
                <button className="btn btn-primary" onClick={() => download('png')}>
                  <Download size={14} /> PNG
                </button>
                <button className="btn btn-secondary" onClick={() => download('svg')}>
                  <Download size={14} /> SVG
                </button>
                <button className="btn btn-secondary" onClick={() => download('jpeg')}>
                  <Download size={14} /> JPEG
                </button>
                <button className="btn btn-secondary" onClick={() => download('webp')}>
                  <Download size={14} /> WebP
                </button>
              </div>
            </div>

            {/* QR data info */}
            <hr />
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              <div style={{ marginBottom: '4px' }}>
                <span style={{ color: 'var(--text-muted)' }}>Data: </span>
                <span className="mono" style={{ wordBreak: 'break-all' }}>
                  {buildQrData(inputType, fields).slice(0, 80)}{buildQrData(inputType, fields).length > 80 ? '…' : ''}
                </span>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Size: </span>
                <span className="mono">{buildQrData(inputType, fields).length} chars</span>
                {' '}
                <span style={{ color: 'var(--text-muted)' }}>EC: </span>
                <span className="mono">{ecLevel}</span>
                {' '}
                <span style={{ color: 'var(--text-muted)' }}>Style: </span>
                <span className="mono">{dotType}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
