import React, { useState } from 'react';
import { api } from '../lib/api';
import { fillTemplate, formatContent, inspectText, safeJson, templateVariables, toolBadges } from '../lib/catalog';
import { Badge, PlainText } from './CatalogParts';
import './Catalog.css';

function failureText(data, fallback) {
  if (data?.rpcError?.code === -32002) return `Not found: ${data.rpcError.data?.uri || data.rpcError.message}`;
  const message = data?.error || fallback;
  return /\b403\b/.test(message) ? `Denied by gateway policy. ${message}` : message;
}

/** Shown for anything the gateway reported as hidden by policy on this door. */
export function HiddenNotice({ kind, item, onUseDirect, canUseDirect }) {
  return (
    <div className="item-detail">
      <h2 className="item-detail__title">{item.name || item.uri}</h2>
      <p className="item-detail__badges"><Badge kind="hidden">hidden by policy</Badge></p>
      {item.title && item.title !== item.name && <p className="item-detail__subtitle">{item.title}</p>}
      {item.description ? <PlainText value={item.description} /> : <p className="catalog-text">The gateway did not send a description for this {kind}.</p>}
      <p className="item-detail__reason"><strong>Why:</strong> {item.deniedReason || 'Filtered by gateway policy.'}</p>
      <p className="catalog-text">This {kind} is not offered on this door, so it cannot be used here. The gateway refuses it with 403 if you try.</p>
      {canUseDirect && <button type="button" className="item-detail__action" onClick={onUseDirect}>Open the Direct door to compare</button>}
    </div>
  );
}

/** Full description, badges, and the raw schema and annotations of a tool. Goes above the argument form. */
export function ToolDetails({ tool, hiddenOnPrivilege }) {
  const badges = toolBadges(tool, { hiddenOnPrivilege });
  const title = tool.title && tool.title !== tool.name ? tool.title : null;
  return (
    <div className="item-detail__tool">
      {title && <p className="item-detail__subtitle">{title}</p>}
      {badges.length > 0 && <p className="item-detail__badges">{badges.map((b) => <Badge key={b.key} kind={b.key}>{b.text}</Badge>)}</p>}
      {tool.description && <PlainText value={tool.description} />}
    </div>
  );
}

export function ToolSchema({ tool }) {
  const schema = tool.inputSchema || {};
  const annotations = tool.annotations;
  const properties = Object.entries(schema.properties || {});
  return (
    <details className="item-detail__schema">
      <summary>Input schema and annotations</summary>
      {properties.length > 0 && (
        <ul className="item-detail__props">
          {properties.map(([key, p]) => (
            <li key={key} className="item-detail__prop">
              <span className="item-detail__prop-name">{key}</span>
              <span className="item-detail__prop-type">{p.type}{p.enum ? ` (${p.enum.join(', ')})` : ''}{(schema.required || []).includes(key) ? ', required' : ''}</span>
              {p.description && <span className="item-detail__prop-desc">{p.description}</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="item-detail__label">Annotations</p>
      <pre className="item-detail__json">{annotations ? safeJson(annotations) : 'None sent by the server.'}</pre>
      <p className="item-detail__label">inputSchema</p>
      <pre className="item-detail__json">{safeJson(schema)}</pre>
    </details>
  );
}

function Contents({ result }) {
  if (!result) return null;
  if (result.status === 'loading') return <p className="catalog-note" role="status">Reading...</p>;
  if (result.status === 'error') return <p className="item-detail__error" role="alert">{result.message}</p>;
  return (
    <div className="item-detail__contents" aria-label="Content">
      {result.contents.length === 0 && <p className="catalog-note">The server returned no content.</p>}
      {result.contents.map((c, i) => {
        if (typeof c.text !== 'string') {
          return <p key={i} className="catalog-note">Binary content ({c.mimeType || 'unknown type'}) is not shown here.</p>;
        }
        const shown = formatContent(c.text, c.mimeType);
        const info = inspectText(c.text);
        return (
          <div key={i} className="item-detail__content">
            <p className="item-detail__label">{c.uri} <span className="item-detail__format">{c.mimeType || 'no type'}, shown as {shown.format === 'json' ? 'pretty-printed JSON' : 'text'}</span></p>
            <pre className="item-detail__body" data-format={shown.format}>{inspectText(shown.text).marked}</pre>
            {shown.note && <p className="catalog-note">{shown.note}</p>}
            {(info.invisible.length > 0 || info.htmlLike) && (
              <p className="catalog-note">
                {info.htmlLike && 'Contains HTML-looking text, shown as text. '}
                {info.invisible.length > 0 && `Contains ${info.invisible.length} invisible character(s): ${info.invisibleSummary}. They are shown above as [U+XXXX] markers.`}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

async function readUri(uri, onResponse) {
  const t0 = Date.now();
  const { data, ok } = await api.post('/api/gateway/request', { method: 'resources/read', params: { uri } });
  onResponse?.(data, ok, Date.now() - t0);
  if (!ok) return { status: 'error', message: failureText(data, 'Read failed.') };
  return { status: 'ok', contents: data?.result?.contents || [] };
}

export function ResourceDetail({ resource, onResponse }) {
  const [result, setResult] = useState(null);
  const read = async () => {
    setResult({ status: 'loading' });
    setResult(await readUri(resource.uri, onResponse));
  };
  return (
    <div className="item-detail">
      <h2 className="item-detail__title">{resource.name}</h2>
      {resource.title && resource.title !== resource.name && <p className="item-detail__subtitle">{resource.title}</p>}
      <dl className="item-detail__facts">
        <dt>URI</dt><dd className="item-detail__mono">{resource.uri}</dd>
        <dt>Type</dt><dd>{resource.mimeType || 'not stated'}</dd>
        {typeof resource.size === 'number' && (<><dt>Size</dt><dd>{resource.size} bytes</dd></>)}
      </dl>
      {resource.description && <PlainText value={resource.description} />}
      <button type="button" className="item-detail__action" onClick={read} disabled={result?.status === 'loading'}>Read</button>
      <Contents result={result} />
    </div>
  );
}

export function TemplateDetail({ template, onResponse }) {
  const names = templateVariables(template.uriTemplate);
  const [values, setValues] = useState({});
  const [result, setResult] = useState(null);
  const uri = fillTemplate(template.uriTemplate, values);
  const ready = names.every((n) => String(values[n] ?? '').trim());
  const read = async () => {
    setResult({ status: 'loading' });
    setResult(await readUri(uri, onResponse));
  };
  return (
    <div className="item-detail">
      <h2 className="item-detail__title">{template.name}</h2>
      {template.title && template.title !== template.name && <p className="item-detail__subtitle">{template.title}</p>}
      <dl className="item-detail__facts">
        <dt>Template</dt><dd className="item-detail__mono">{template.uriTemplate}</dd>
        <dt>Type</dt><dd>{template.mimeType || 'not stated'}</dd>
      </dl>
      {template.description && <PlainText value={template.description} />}
      {names.map((n) => (
        <label key={n} className="tool-form__field">
          <span>{n} *</span>
          <input value={values[n] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))} />
        </label>
      ))}
      <p className="catalog-note">URI: <span className="item-detail__mono">{uri}</span></p>
      <button type="button" className="item-detail__action" onClick={read} disabled={!ready || result?.status === 'loading'}>Read</button>
      <Contents result={result} />
    </div>
  );
}

export function PromptDetail({ prompt, onResponse }) {
  const args = Array.isArray(prompt.arguments) ? prompt.arguments : [];
  const [values, setValues] = useState({});
  const [result, setResult] = useState(null);
  const ready = args.filter((a) => a.required).every((a) => String(values[a.name] ?? '').trim());
  const get = async () => {
    setResult({ status: 'loading' });
    const given = Object.fromEntries(Object.entries(values).filter(([, v]) => String(v).trim() !== ''));
    const t0 = Date.now();
    const { data, ok } = await api.post('/api/gateway/request', { method: 'prompts/get', params: { name: prompt.name, arguments: given } });
    onResponse?.(data, ok, Date.now() - t0);
    setResult(ok ? { status: 'ok', messages: data?.result?.messages || [], description: data?.result?.description } : { status: 'error', message: failureText(data, 'Get prompt failed.') });
  };
  return (
    <div className="item-detail">
      <h2 className="item-detail__title">{prompt.name}</h2>
      {prompt.title && prompt.title !== prompt.name && <p className="item-detail__subtitle">{prompt.title}</p>}
      {prompt.description && <PlainText value={prompt.description} />}
      {args.length === 0 && <p className="catalog-note">This prompt takes no arguments.</p>}
      {args.map((a) => (
        <label key={a.name} className="tool-form__field">
          <span>{a.name}{a.required ? ' *' : ' (optional)'}</span>
          <input value={values[a.name] ?? ''} placeholder={a.description || ''} onChange={(e) => setValues((v) => ({ ...v, [a.name]: e.target.value }))} />
        </label>
      ))}
      <button type="button" className="item-detail__action" onClick={get} disabled={!ready || result?.status === 'loading'}>Get prompt</button>
      {result?.status === 'loading' && <p className="catalog-note" role="status">Getting prompt...</p>}
      {result?.status === 'error' && <p className="item-detail__error" role="alert">{result.message}</p>}
      {result?.status === 'ok' && (
        <div className="item-detail__contents" aria-label="Prompt messages">
          {result.messages.length === 0 && <p className="catalog-note">The prompt returned no messages.</p>}
          {result.messages.map((m, i) => (
            <div key={i} className="item-detail__content">
              <p className="item-detail__label">{m.role}</p>
              <pre className="item-detail__body">{m.content?.type === 'text' ? inspectText(m.content.text).marked : safeJson(m.content)}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
