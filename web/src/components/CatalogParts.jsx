import React from 'react';
import { inspectText } from '../lib/catalog';

/** A small labelled tag. The words carry the meaning; the style only helps. */
export function Badge({ kind, children }) {
  return <span className="catalog-badge" data-kind={kind}>{children}</span>;
}

/**
 * Untrusted text from a server (a description, a resource body). It is only ever
 * a React text child, so markup in it is shown as characters and never parsed.
 * Invisible characters are called out below the text.
 */
export function PlainText({ value, className = 'catalog-text' }) {
  const info = inspectText(value);
  return (
    <>
      <p className={className}>{info.text}</p>
      <TextFlags info={info} />
    </>
  );
}

/** Notes about text that looks odd: markup-like text, and characters you cannot see. */
export function TextFlags({ info }) {
  if (!info.htmlLike && info.invisible.length === 0) return null;
  return (
    <div className="catalog-flags" role="note">
      {info.htmlLike && <p className="catalog-flags__line">This text contains HTML-looking characters. It is shown as text and never run.</p>}
      {info.invisible.length > 0 && (
        <>
          <p className="catalog-flags__line">
            This text contains {info.invisible.length} invisible character{info.invisible.length === 1 ? '' : 's'} ({info.invisibleSummary}). They are shown as markers:
          </p>
          <pre className="catalog-flags__marked">{info.marked}</pre>
        </>
      )}
    </div>
  );
}

/** Badges that warn about odd text, for a list row. */
export function TextBadges({ value }) {
  const info = inspectText(value);
  return (
    <>
      {info.htmlLike && <Badge kind="warn">HTML-like text</Badge>}
      {info.invisible.length > 0 && <Badge kind="warn">invisible characters</Badge>}
    </>
  );
}
