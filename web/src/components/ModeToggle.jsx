import React from 'react';
import './ModeToggle.css';

const OPTIONS = [
  { key: 'mock', label: 'Mock', hint: 'Offline, simulated' },
  { key: 'real', label: 'Real', hint: 'Contacts the gateway you enter' },
];

/** Header control on every page. The server decides the mode; this only asks it to change.
    Real is disabled when the server reports no configured gateway (rule 19). */
export default function ModeToggle({ mode, onChange, realAvailable = true }) {
  return (
    <div className="mode-toggle" role="group" aria-label="Gateway mode">
      <span className={mode === 'mock' ? 'mode-toggle__current mode-toggle__current--mock' : 'mode-toggle__current mode-toggle__current--live'}>
        {mode === 'mock' ? 'MOCK' : 'REAL'}
      </span>
      {OPTIONS.map((opt) => {
        const unavailable = opt.key === 'real' && !realAvailable;
        return (
          <button
            key={opt.key}
            type="button"
            className={mode === opt.key ? 'mode-toggle__btn mode-toggle__btn--on' : 'mode-toggle__btn'}
            aria-pressed={mode === opt.key}
            disabled={unavailable}
            title={unavailable ? 'Real is not available: no gateway host is configured. Set PRIVILEGE_GATEWAY_HOST in the shared settings file.' : opt.hint}
            onClick={() => { if (mode !== opt.key) onChange(opt.key); }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
