import React, { useState } from 'react';
import { Badge, TextBadges } from './CatalogParts';
import { isLong, pageNote, toolBadges } from '../lib/catalog';
import './Catalog.css';

export const CATALOG_TABS = [
  { key: 'tools', label: 'Tools', one: 'tool', many: 'tools', listKey: 'tools' },
  { key: 'resources', label: 'Resources', one: 'resource', many: 'resources', listKey: 'resources' },
  { key: 'templates', label: 'Templates', one: 'template', many: 'templates', listKey: 'resourceTemplates' },
  { key: 'prompts', label: 'Prompts', one: 'prompt', many: 'prompts', listKey: 'prompts' },
];

/** The id each kind of item is selected by. */
export const itemId = (tab, item) => (tab === 'resources' ? item.uri : tab === 'templates' ? item.uriTemplate : item.name);

function Row({ tab, item, hidden, selected, onSelect, badges }) {
  const [expanded, setExpanded] = useState(false);
  const title = item.title && item.title !== item.name ? item.title : null;
  const long = isLong(item.description);
  const sub = tab === 'resources' ? item.uri : tab === 'templates' ? item.uriTemplate : null;
  const args = tab === 'prompts' && Array.isArray(item.arguments) && item.arguments.length
    ? item.arguments.map((a) => `${a.name}${a.required ? '*' : ''}`).join(', ')
    : null;
  return (
    <li className="catalog-item" data-hidden={hidden ? 'true' : undefined}>
      <button type="button" className="catalog-item__select" aria-pressed={selected} onClick={onSelect}>
        <span className="catalog-item__head">
          <span className="catalog-item__name">{item.name || item.uri}</span>
          {title && <span className="catalog-item__title">{title}</span>}
        </span>
        {sub && <span className="catalog-item__sub">{sub}</span>}
        {args && <span className="catalog-item__sub">arguments: {args}</span>}
        {(badges.length > 0 || item.mimeType || item.description) && (
          <span className="catalog-item__badges">
            {item.mimeType && <Badge kind="type">{item.mimeType}</Badge>}
            {badges.map((b) => <Badge key={b.key} kind={b.key}>{b.text}</Badge>)}
            <TextBadges value={item.description} />
          </span>
        )}
        {item.description && (
          <span className="catalog-item__desc" data-expanded={expanded ? 'true' : 'false'}>{item.description}</span>
        )}
      </button>
      {long && (
        <button type="button" className="catalog-item__more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Less' : 'More'}
        </button>
      )}
    </li>
  );
}

function Empty({ state, children, onRetry }) {
  return (
    <div className="catalog-empty" data-state={state} role={state === 'error' ? 'alert' : 'status'}>
      <p className="catalog-empty__text">{children}</p>
      {onRetry && <button type="button" className="catalog-empty__retry" onClick={onRetry}>Retry</button>}
    </div>
  );
}

/**
 * Left column: tabs for tools, resources, templates and prompts, and the list for the active tab.
 * Every list has an empty state, an error state and a Not supported state.
 */
export default function CatalogPanel({
  tab, onTab, catalog, authed, loading, loadError, onRetry, selected, onSelect, knownHidden,
}) {
  const spec = CATALOG_TABS.find((t) => t.key === tab) || CATALOG_TABS[0];
  const lists = catalog?.lists || {};
  const list = lists[spec.listKey];
  const items = catalog?.[spec.listKey] || [];
  const hidden = list?.hidden || [];
  const countOf = (t) => (catalog ? (catalog[t.listKey] || []).length : null);

  let body;
  if (!authed) {
    body = <Empty state="idle">Sign in to list {spec.many}.</Empty>;
  } else if (loadError) {
    body = <Empty state="error" onRetry={onRetry}>Could not load the catalog: {loadError}</Empty>;
  } else if (!catalog) {
    body = <Empty state="loading">{loading ? `Loading ${spec.many}...` : `Nothing loaded yet. Use Refresh to load ${spec.many}.`}</Empty>;
  } else if (list && list.supported === false) {
    body = <Empty state="unsupported">Not supported by this server. It did not offer {spec.many}.</Empty>;
  } else if (list?.error) {
    body = <Empty state="error" onRetry={onRetry}>Could not list {spec.many}: {list.error}</Empty>;
  } else if (items.length === 0 && hidden.length === 0) {
    body = <Empty state="empty">This server has no {spec.many}.</Empty>;
  } else {
    body = (
      <>
        {items.length === 0 && <Empty state="empty">Policy hides every {spec.one} on this door.</Empty>}
        <ul className="catalog-list">
          {items.map((item) => {
            const id = itemId(tab, item);
            const hiddenOnPrivilege = knownHidden?.[tab]?.has(id) || false;
            return (
              <Row
                key={id}
                tab={tab}
                item={item}
                selected={selected?.kind === tab && selected.id === id && !selected.hidden}
                badges={tab === 'tools' ? toolBadges(item, { hiddenOnPrivilege }) : (hiddenOnPrivilege ? [{ key: 'hidden', text: 'hidden on Privilege door' }] : [])}
                onSelect={() => onSelect({ kind: tab, id, hidden: false })}
              />
            );
          })}
        </ul>
        {hidden.length > 0 && (
          <>
            <h3 className="catalog-group">Hidden by policy ({hidden.length})</h3>
            <ul className="catalog-list">
              {hidden.map((item) => {
                const id = itemId(tab, item);
                return (
                  <Row
                    key={`hidden:${id}`}
                    tab={tab}
                    item={item}
                    hidden
                    selected={selected?.kind === tab && selected.id === id && selected.hidden}
                    badges={[{ key: 'hidden', text: 'hidden by policy' }]}
                    onSelect={() => onSelect({ kind: tab, id, hidden: true })}
                  />
                );
              })}
            </ul>
          </>
        )}
        {list?.pages > 0 && <p className="catalog-note">{pageNote(spec.one, spec.many, items.length, list.pages)}</p>}
      </>
    );
  }

  return (
    <div className="catalog-panel">
      <div className="catalog-tabs" role="tablist" aria-label="What the server offers">
        {CATALOG_TABS.map((t) => {
          const n = countOf(t);
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              className="catalog-tabs__tab"
              aria-selected={tab === t.key}
              onClick={() => onTab(t.key)}
            >
              {t.label}{authed && n !== null ? ` ${n}` : ''}
            </button>
          );
        })}
      </div>
      <div className="catalog-panel__body" role="tabpanel">{body}</div>
    </div>
  );
}
