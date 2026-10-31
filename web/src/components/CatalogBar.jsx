import React from 'react';
import { countsLine } from '../lib/catalog';
import './Catalog.css';

/**
 * Sits under the source bar. In mock mode it holds the sample picker. It always shows
 * what the active door serves, and next to it what the other door serves when that is known.
 */
export default function CatalogBar({
  mockSamples, activeSample, onSample, busy,
  doorLabel, summary, otherLabel, otherSummary,
}) {
  const active = mockSamples?.find((s) => s.id === activeSample);
  return (
    <section className="catalog-bar" aria-label="Server contents">
      {mockSamples && (
        <div className="catalog-bar__sample">
          <label className="catalog-bar__label" htmlFor="mock-sample">Mock sample</label>
          <select id="mock-sample" className="catalog-bar__select" value={activeSample} disabled={busy} onChange={(e) => onSample(e.target.value)}>
            {mockSamples.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          {active && <p className="catalog-bar__purpose">{active.purpose}</p>}
        </div>
      )}
      <div className="catalog-bar__counts" aria-live="polite">
        {summary
          ? <p className="catalog-bar__line">{countsLine(doorLabel, summary)}</p>
          : <p className="catalog-bar__line catalog-bar__line--quiet">{doorLabel}: sign in and load to see what this door serves.</p>}
        {otherSummary && <p className="catalog-bar__line catalog-bar__line--quiet">{countsLine(otherLabel, otherSummary)}</p>}
      </div>
    </section>
  );
}
