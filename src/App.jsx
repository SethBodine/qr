import React, { useState, useEffect } from 'react';
import { QrCode, Wifi, Github, Shield } from 'lucide-react';
import GeneratorPage from './pages/GeneratorPage.jsx';
import TransferPage  from './pages/TransferPage.jsx';

const TABS = [
  { id: 'generator', label: 'QR Generator', icon: QrCode },
  { id: 'transfer',  label: 'QR Transfer',  icon: Wifi },
];

export default function App() {
  const [tab, setTab] = useState(() => {
    const hash = window.location.hash.replace('#', '');
    return TABS.find(t => t.id === hash)?.id || 'generator';
  });

  useEffect(() => {
    window.location.hash = tab;
  }, [tab]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* NAV */}
      <nav className="nav">
        <a className="nav-logo" href="/" onClick={e => { e.preventDefault(); setTab('generator'); }}>
          <span className="nav-logo-mark">
            <QrCode size={16} />
          </span>
          <span className="nav-logo-name">
            QR<span>Forge</span>
          </span>
        </a>

        <div className="nav-tabs">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-tab${tab === id ? ' active' : ''}`}
              onClick={() => setTab(id)}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>

        <div className="nav-right">
          <span className="nav-badge">FREE</span>
          <a
            className="btn btn-ghost btn-sm"
            href="https://github.com/YOUR_USERNAME/qrforge"
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'flex', alignItems: 'center', gap: '5px' }}
          >
            <Github size={14} />
            Source
          </a>
        </div>
      </nav>

      {/* PAGES */}
      <main className="main" style={{ flex: 1 }}>
        {tab === 'generator' && <GeneratorPage />}
        {tab === 'transfer'  && <TransferPage />}
      </main>

      {/* FOOTER */}
      <footer className="footer">
        <span>QRForge — open source, no accounts, no storage</span>
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
          <Shield size={12} />
          <span>All processing is local. Nothing leaves your browser.</span>
          <a href="https://github.com/YOUR_USERNAME/qrforge" target="_blank" rel="noopener noreferrer">GitHub</a>
        </div>
      </footer>
    </div>
  );
}
