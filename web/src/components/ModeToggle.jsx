import React from 'react';
import './ModeToggle.css';

const OPTIONS = [
  { key: 'mock', label: 'Mock', hint: 'Offline, simulated' },
  { key: 'live', label: 'Live', hint: 'Contacts the gateway you enter' },
];

/** Header control on every page. The server decides the mode; this only asks it to change. */
export default function ModeToggle({ mode, onChange }) {
  return (
    <div className="mode-toggle" role="group" aria-label="Gateway mode">
      <span className={mode === 'mock' ? 'mode-toggle__current mode-toggle__current--mock' : 'mode-toggle__current mode-toggle__current--live'}>
        {mode === 'mock' ? 'MOCK' : 'LIVE'}
      </span>
      {OPTIONS.map((opt) => (
        <button
          key={opt.key}
          type="button"
          className={mode === opt.key ? 'mode-toggle__btn mode-toggle__btn--on' : 'mode-toggle__btn'}
          aria-pressed={mode === opt.key}
          title={opt.hint}
          onClick={() => { if (mode !== opt.key) onChange(opt.key); }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
