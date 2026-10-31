import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import InspectorShell from './components/shared/InspectorShell';
import InspectorTabs from './components/shared/InspectorTabs';
import ModeToggle from './components/ModeToggle';
import FlowDiagram from './components/FlowDiagram';
import CatalogPanel, { CATALOG_TABS, itemId } from './components/CatalogPanel';
import CatalogBar from './components/CatalogBar';
import { HiddenNotice, PromptDetail, ResourceDetail, TemplateDetail, ToolDetails, ToolSchema } from './components/ItemDetail';
import { fromDoorCounts, safeJson, summarise } from './lib/catalog';
import { api } from './lib/api';

const OUTPUT_TABS = [
  { key: 'response', label: 'Response' },
  { key: 'request', label: 'Request' },
  { key: 'log', label: 'Relay log' },
  { key: 'flow', label: 'Flow' },
];

const SIMULATED_BANNER = 'Mock mode. Sign-in, the MCP gateway, its tool list and every tool result run inside this app process. No sign-in, gateway or tool traffic leaves this machine (the page only fetches its fonts from Google Fonts). Tokens and client ids shown are mock-issued and labelled as mock.';
const LIVE_BANNER = 'Requests go to the gateway URL you enter and to the sign-in server that gateway advertises. Sign-in and tool calls are real.';

function coerceParam(raw, type) {
  if (raw === '') return undefined;
  if (type === 'number' || type === 'integer') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (type === 'boolean') return raw === 'true' || raw === '1';
  if (type === 'object' || type === 'array') {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

function readAndClearAuthResult() {
  const params = new URLSearchParams(window.location.search);
  const auth = params.get('auth');
  const reason = params.get('reason');
  if (!auth) return null;
  window.history.replaceState({}, '', window.location.pathname);
  return { auth, reason };
}

export default function App() {
  const [state, setState] = useState(null);
  const [banner, setBanner] = useState(null);
  const [doorUrlInput, setDoorUrlInput] = useState('');
  const [events, setEvents] = useState([]);
  const [showConsoleForm, setShowConsoleForm] = useState(false);
  const [consoleToken, setConsoleToken] = useState('');
  const [probeResults, setProbeResults] = useState(null);
  const [modeConfirm, setModeConfirm] = useState(false);

  // What the server offers on the active door, loaded from /catalog.
  const [catalog, setCatalog] = useState(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState(null);
  const [tab, setTab] = useState('tools');
  const [selected, setSelected] = useState(null);
  // Mock samples (mock mode only) and what each door was last seen to serve (for the comparison).
  const [mockSamples, setMockSamples] = useState(null);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [doorSummaries, setDoorSummaries] = useState({});
  const [hiddenSeen, setHiddenSeen] = useState({ tools: [], resources: [], prompts: [] });
  const [paramValues, setParamValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [lastInvoke, setLastInvoke] = useState(null);
  const [lastTiming, setLastTiming] = useState(null);
  const [outputTab, setOutputTab] = useState('response');

  const [rawMethod, setRawMethod] = useState('resources/list');
  const [rawParams, setRawParams] = useState('{}');

  const loadState = useCallback(async () => {
    const { data } = await api.get('/api/gateway/state');
    setState(data);
    setDoorUrlInput(data?.config?.mcpUrl || '');
    if (data?.mockSample) {
      const samples = await api.get('/api/gateway/mock/sample');
      setMockSamples(samples.ok ? samples.data.samples : null);
    } else {
      setMockSamples(null);
    }
    return data;
  }, []);

  const clearCatalog = useCallback(() => {
    setCatalog(null);
    setCatalogError(null);
    setSelected(null);
    setLastInvoke(null);
  }, []);

  // Loads tools, resources, templates and prompts for the door the caller says is active.
  const loadCatalog = useCallback(async (door) => {
    setCatalogLoading(true);
    setCatalogError(null);
    const { data, ok } = await api.get('/api/gateway/catalog');
    setCatalogLoading(false);
    if (!ok) {
      setCatalog(null);
      setCatalogError(data?.error || 'Failed to load.');
      return;
    }
    setCatalog(data);
    setDoorSummaries((prev) => ({ ...prev, [door]: summarise(data) }));
    if (door === 'privilege') {
      const names = (key) => (data.lists?.[key]?.hidden || []).map((h) => h.name || h.uri);
      setHiddenSeen({ tools: names('tools'), resources: names('resources'), prompts: names('prompts') });
    }
  }, []);

  useEffect(() => {
    (async () => {
      const result = readAndClearAuthResult();
      const data = await loadState();
      if (result?.auth === 'success') {
        setBanner(null);
        if (data?.oauth?.authenticated) loadCatalog(data.gatewayMode);
      } else if (result?.auth === 'error') {
        setBanner({ message: `Sign-in failed: ${result.reason || 'unknown error'}` });
      } else if (data?.oauth?.authenticated) {
        loadCatalog(data.gatewayMode);
      }
    })();
  }, [loadState, loadCatalog]);

  useEffect(() => {
    const es = new EventSource('/api/gateway/events');
    es.onmessage = () => {};
    ['oauth', 'relay', 'mcp', 'config', 'subscription', 'error'].forEach((type) => {
      es.addEventListener(type, (e) => {
        let payload = {};
        try { payload = JSON.parse(e.data); } catch { /* ignore */ }
        setEvents((prev) => [...prev.slice(-199), { type, ...payload }]);
      });
    });
    return () => es.close();
  }, []);

  const switchMode = useCallback(async (mode, url) => {
    const { data } = await api.post('/api/gateway/config', { gatewayMode: mode, mcpUrl: url });
    setState((prev) => ({ ...prev, gatewayMode: data.gatewayMode, config: data.config, gatewayConfigs: data.gatewayConfigs, oauth: { ...prev.oauth, authenticated: data.oauth.authenticated } }));
    setDoorUrlInput(data.config.mcpUrl || '');
    clearCatalog();
    if (data.oauth.authenticated) loadCatalog(data.gatewayMode);
  }, [loadCatalog, clearCatalog]);

  const signIn = useCallback(async () => {
    if (doorUrlInput !== state?.config?.mcpUrl) {
      await api.post('/api/gateway/config', { gatewayMode: state.gatewayMode, mcpUrl: doorUrlInput });
    }
    const { data, ok } = await api.post('/api/gateway/auth/start', { returnTo: '/' });
    if (!ok) { setBanner({ message: data?.error || 'Failed to start sign-in.' }); return; }
    window.location.href = data.authUrl;
  }, [doorUrlInput, state]);

  const signOut = useCallback(async () => {
    await api.post('/api/gateway/auth/logout');
    await loadState();
    clearCatalog();
  }, [loadState, clearCatalog]);

  // The catalog item the user picked, and the tool the existing argument form is built from.
  const selectedItem = useMemo(() => {
    if (!selected || !catalog) return null;
    const spec = CATALOG_TABS.find((t) => t.key === selected.kind);
    const pool = selected.hidden ? (catalog.lists?.[spec.listKey]?.hidden || []) : (catalog[spec.listKey] || []);
    return pool.find((item) => itemId(selected.kind, item) === selected.id) || null;
  }, [selected, catalog]);
  const selectedTool = selected?.kind === 'tools' && !selected.hidden ? selectedItem : null;

  const selectItem = useCallback((next) => {
    // On a phone the columns stack, so bring the detail into view.
    if (window.matchMedia('(max-width: 768px)').matches) {
      setTimeout(() => document.querySelector('.inspector-shell-col-middle')?.scrollIntoView({ block: 'start' }), 0);
    }
    setSelected(next);
    setParamValues({});
    setLastInvoke(null);
    setLastTiming(null);
  }, []);

  const recordResponse = useCallback((data, ok, ms) => {
    setLastInvoke(data);
    setLastTiming({ ms, error: !ok });
    setOutputTab('response');
  }, []);

  const changeSample = useCallback(async (id) => {
    setSampleBusy(true);
    const { ok, data } = await api.put('/api/gateway/mock/sample', { sample: id });
    setSampleBusy(false);
    if (!ok) { setBanner({ message: data?.message || 'Could not switch sample.' }); return; }
    clearCatalog();
    setDoorSummaries({});
    setHiddenSeen({ tools: [], resources: [], prompts: [] });
    const fresh = await loadState();
    if (fresh?.oauth?.authenticated) loadCatalog(fresh.gatewayMode);
  }, [clearCatalog, loadState, loadCatalog]);

  const schemaProps = useMemo(() => selectedTool?.inputSchema?.properties || {}, [selectedTool]);
  const requiredParams = useMemo(() => new Set(selectedTool?.inputSchema?.required || []), [selectedTool]);

  const handleExecute = useCallback(async () => {
    if (!selectedTool) return;
    const missing = [...requiredParams].filter((k) => !String(paramValues[k] ?? '').trim());
    if (missing.length) { setBanner({ message: `Required: ${missing.join(', ')}` }); return; }
    const params = {};
    for (const [key, schema] of Object.entries(schemaProps)) {
      const coerced = coerceParam(paramValues[key] ?? '', schema?.type);
      if (coerced !== undefined) params[key] = coerced;
    }
    setBusy(true);
    const t0 = Date.now();
    const { data, ok } = await api.post('/api/gateway/tools/call', { name: selectedTool.name, arguments: params });
    setBusy(false);
    setLastInvoke(data);
    setLastTiming({ ms: Date.now() - t0, error: !ok });
    setOutputTab('response');
    if (!ok) setBanner({ message: data?.error || 'Tool call failed.' });
  }, [selectedTool, paramValues, schemaProps, requiredParams]);

  const sendRaw = useCallback(async () => {
    let params;
    try { params = JSON.parse(rawParams || '{}'); } catch { setBanner({ message: 'Params must be valid JSON.' }); return; }
    setBusy(true);
    const t0 = Date.now();
    const { data, ok } = await api.post('/api/gateway/request', { method: rawMethod, params });
    setBusy(false);
    setLastInvoke(data);
    setLastTiming({ ms: Date.now() - t0, error: !ok });
    setOutputTab('response');
    if (!ok) setBanner({ message: data?.error || 'Request failed.' });
  }, [rawMethod, rawParams]);

  const runProbe = useCallback(async () => {
    const urls = (state?.presets || []).map((p) => p.url).filter((u) => u && u !== state?.config?.mcpUrl);
    if (urls.length === 0) return;
    const { data } = await api.post('/api/gateway/doors/probe', { urls });
    setProbeResults(data?.results || []);
  }, [state]);

  const changeMode = useCallback(async (next, confirm = false) => {
    const { ok, data } = await api.put('/api/gateway/mode', { mode: next, confirm });
    if (!ok) {
      if (data?.error === 'confirm_required') { setModeConfirm(true); return; }
      setBanner({ message: data?.message || 'Mode change refused.' });
      return;
    }
    setModeConfirm(false);
    setEvents([]);
    setLastInvoke(null);
    clearCatalog();
    setDoorSummaries({});
    setHiddenSeen({ tools: [], resources: [], prompts: [] });
    await loadState();
  }, [loadState, clearCatalog]);

  const connectConsole = useCallback(async () => {
    const { data, ok } = await api.post('/api/gateway/console/connect', { authToken: consoleToken });
    if (!ok) { setBanner({ message: data?.error || 'Console connect failed.' }); return; }
    setShowConsoleForm(false);
    setConsoleToken('');
    await loadState();
  }, [consoleToken, loadState]);

  const outputValue = useMemo(() => {
    if (outputTab === 'log') return null;
    if (outputTab === 'response') return lastInvoke ?? null;
    if (outputTab === 'request') {
      if (selectedTool) return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: selectedTool.name, arguments: paramValues } };
      if (selectedItem && !selected.hidden && selected.kind === 'resources') return { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: selectedItem.uri } };
      if (selectedItem && !selected.hidden && selected.kind === 'prompts') return { jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: selectedItem.name } };
      let params = {};
      try { params = JSON.parse(rawParams || '{}'); } catch { /* shown as empty until the JSON is valid */ }
      return { jsonrpc: '2.0', id: 1, method: rawMethod, params };
    }
    return null;
  }, [outputTab, lastInvoke, selectedTool, selectedItem, selected, paramValues, rawMethod, rawParams]);

  // Items the Privilege door hides, so the Direct door can mark them. In mock mode the sample says
  // which they are; in live mode it is what a Privilege load reported earlier in this session.
  const knownHidden = useMemo(() => {
    const active = mockSamples?.find((smp) => smp.id === state?.mockSample);
    const source = active ? active.hidden : hiddenSeen;
    return {
      tools: new Set(source?.tools || []),
      resources: new Set(source?.resources || []),
      prompts: new Set(source?.prompts || []),
    };
  }, [mockSamples, state, hiddenSeen]);

  if (!state) return <div style={{ padding: 20 }}>Loading…</div>;

  const isMock = state.mode?.current !== 'live';
  const doorLabel = state.gatewayMode === 'privilege' ? 'Privilege — straight at the Agent Privilege' : 'Direct — no Privilege in the path';

  const gatewayMode = state.gatewayMode;
  const doorName = gatewayMode === 'privilege' ? 'Privilege' : 'Direct';
  const otherMode = gatewayMode === 'privilege' ? 'direct' : 'privilege';
  const otherName = otherMode === 'privilege' ? 'Privilege' : 'Direct';
  const summary = catalog ? summarise(catalog) : null;
  let otherSummary = null;
  const activeSample = mockSamples?.find((smp) => smp.id === state.mockSample);
  if (activeSample) {
    const hiddenAnywhere = activeSample.counts.privilege.hiddenTools + activeSample.counts.privilege.hiddenResources + activeSample.counts.privilege.hiddenPrompts > 0;
    if (hiddenAnywhere) otherSummary = fromDoorCounts(activeSample.counts[otherMode]);
  } else if (doorSummaries[otherMode] && summary && JSON.stringify(doorSummaries[otherMode]) !== JSON.stringify(summary)) {
    otherSummary = doorSummaries[otherMode];
  }
  const directPreset = (state.presets || []).find((p) => p.mode === 'direct');

  const left = (
    <CatalogPanel
      tab={tab}
      onTab={setTab}
      catalog={catalog}
      authed={state.oauth.authenticated}
      loading={catalogLoading}
      loadError={catalogError}
      onRetry={() => loadCatalog(gatewayMode)}
      selected={selected}
      onSelect={selectItem}
      knownHidden={knownHidden}
    />
  );

  const rawForm = (
    <>
      <h2>Raw MCP request</h2>
      <p className="tool-form__desc">For anything that isn't tools/call, such as completion or tasks. Pick an item on the left to use it directly.</p>
      <label className="tool-form__field">
        <span>method</span>
        <input value={rawMethod} onChange={(e) => setRawMethod(e.target.value)} placeholder="resources/list" />
      </label>
      <label className="tool-form__field">
        <span>params (JSON)</span>
        <textarea rows={5} value={rawParams} onChange={(e) => setRawParams(e.target.value)} />
      </label>
      <button type="button" className="btn btn--primary" onClick={sendRaw} disabled={busy || !state.oauth.authenticated}>{busy ? 'Sending…' : 'Send'}</button>
    </>
  );

  let detail = null;
  if (selected && selectedItem) {
    const kindWord = { tools: 'tool', resources: 'resource', templates: 'template', prompts: 'prompt' }[selected.kind];
    if (selected.hidden) {
      detail = (
        <HiddenNotice
          key={`hidden:${selected.id}`}
          kind={kindWord}
          item={selectedItem}
          canUseDirect={gatewayMode === 'privilege' && Boolean(directPreset)}
          onUseDirect={() => switchMode('direct', directPreset.url)}
        />
      );
    } else if (selected.kind === 'tools') {
      detail = (
        <div key={`tool:${selected.id}`} className="item-detail">
          <h2 className="item-detail__title">{selectedItem.name}</h2>
          <ToolDetails tool={selectedItem} hiddenOnPrivilege={knownHidden.tools.has(selectedItem.name)} />
          {Object.entries(schemaProps).map(([key, schema]) => (
            <label key={key} className="tool-form__field">
              <span>{key}{requiredParams.has(key) ? ' *' : ''}{schema?.type ? ` (${schema.type})` : ''}</span>
              <input value={paramValues[key] ?? ''} placeholder={schema?.description || ''} onChange={(e) => setParamValues((p) => ({ ...p, [key]: e.target.value }))} />
            </label>
          ))}
          <button type="button" className="btn btn--primary" onClick={handleExecute} disabled={busy}>{busy ? 'Running…' : 'Execute'}</button>
          <ToolSchema tool={selectedItem} />
        </div>
      );
    } else if (selected.kind === 'resources') {
      detail = <ResourceDetail key={`resource:${selected.id}`} resource={selectedItem} onResponse={recordResponse} />;
    } else if (selected.kind === 'templates') {
      detail = <TemplateDetail key={`template:${selected.id}`} template={selectedItem} onResponse={recordResponse} />;
    } else if (selected.kind === 'prompts') {
      detail = <PromptDetail key={`prompt:${selected.id}`} prompt={selectedItem} onResponse={recordResponse} />;
    }
  }

  const middle = (
    <div className="tool-form">
      {detail ? (
        <>
          <button type="button" className="item-detail__close" onClick={() => setSelected(null)}>Back to raw request</button>
          {detail}
        </>
      ) : rawForm}
    </div>
  );

  const right = (
    <div className="tool-output">
      <InspectorTabs tabs={OUTPUT_TABS} activeKey={outputTab} onChange={setOutputTab} />
      {outputTab === 'flow' ? (
        <FlowDiagram name="auth-code-pkce" />
      ) : outputTab === 'log' ? (
        <div className="relay-log">
          {events.length === 0 && <div className="tool-tree__empty">No relay activity yet.</div>}
          {events.slice().reverse().map((ev, i) => (
            <div key={i} className={`relay-log__row relay-log__row--${ev.type}`}>
              <span className="relay-log__type">{ev.type}{ev.phase ? `:${ev.phase}` : ''}</span>
              <pre>{safeJson(ev)}</pre>
            </div>
          ))}
        </div>
      ) : (
        <pre className="tool-output__json">{outputValue === null || outputValue === undefined ? '—' : safeJson(outputValue)}</pre>
      )}
      {lastTiming && (outputTab === 'response' || outputTab === 'request') && (
        <div className={lastTiming.error ? 'tool-output__timing tool-output__timing--error' : 'tool-output__timing'}>
          {lastTiming.error ? 'Failed' : 'OK'} in {lastTiming.ms}ms
        </div>
      )}
    </div>
  );

  return (
    <InspectorShell
      title="Agent Privilege Client"
      statusOn={state.oauth.authenticated}
      statusText={doorLabel}
      actions={<ModeToggle mode={state.mode?.current || 'mock'} onChange={(m) => changeMode(m)} />}
      left={left}
      middle={middle}
      right={right}
      banner={
        <>
          <p className={isMock ? 'banner banner--simulated' : 'banner banner--live'} role="status">
            <strong>{isMock ? 'Simulated: ' : 'Live: '}</strong>{isMock ? SIMULATED_BANNER : LIVE_BANNER}
          </p>
          {modeConfirm && (
            <div className="page-banner">
              Switch to Live? It contacts the gateway URL you enter and the sign-in server it advertises, with real sign-in.
              <button type="button" className="btn btn--primary" onClick={() => changeMode('live', true)}>Switch to live</button>
              <button type="button" className="btn" onClick={() => setModeConfirm(false)}>Stay in mock</button>
            </div>
          )}
          <div className="source-bar">
            <select
              value={`${state.gatewayMode}::${state.config.mcpUrl || ''}`}
              onChange={(e) => {
                const [mode, url] = e.target.value.split('::');
                switchMode(mode, url);
              }}
            >
              {(state.presets || []).map((p) => (
                <option key={`${p.mode}::${p.url}`} value={`${p.mode}::${p.url}`}>{p.label}</option>
              ))}
              {!(state.presets || []).some((p) => p.url === doorUrlInput) && doorUrlInput && (
                <option value={`${state.gatewayMode}::${doorUrlInput}`}>Custom — {doorUrlInput}</option>
              )}
            </select>
            <input className="wide" value={doorUrlInput} onChange={(e) => setDoorUrlInput(e.target.value)} placeholder="MCP server URL" />
            {doorUrlInput !== state.config.mcpUrl && (
              <button type="button" className="btn" onClick={() => switchMode(state.gatewayMode, doorUrlInput)}>Use this URL</button>
            )}
            {state.oauth.authenticated ? (
              <button type="button" className="btn btn--danger" onClick={signOut}>Sign out</button>
            ) : (
              <button type="button" className="btn btn--primary" onClick={signIn}>Sign in</button>
            )}
            <button type="button" className="btn" onClick={() => loadCatalog(gatewayMode)} disabled={!state.oauth.authenticated || catalogLoading}>Refresh</button>
            <button type="button" className="btn" onClick={runProbe} disabled={!state.oauth.authenticated}>Probe other doors</button>
            {!isMock && <button type="button" className="btn" onClick={() => setShowConsoleForm((v) => !v)}>Connect Privilege console</button>}
          </div>
          <CatalogBar
            mockSamples={mockSamples}
            activeSample={state.mockSample}
            onSample={changeSample}
            busy={sampleBusy}
            doorLabel={doorName}
            summary={summary}
            otherLabel={otherName}
            otherSummary={otherSummary}
          />
          {showConsoleForm && (
            <div className="add-server-form">
              <input className="wide" type="password" placeholder="Paste the console's auth_token cookie value" value={consoleToken} onChange={(e) => setConsoleToken(e.target.value)} />
              <button type="button" className="btn btn--primary" onClick={connectConsole}>Connect</button>
              <button type="button" className="btn" onClick={() => setShowConsoleForm(false)}>Cancel</button>
            </div>
          )}
          {probeResults && (
            <div className="page-banner">
              Probe: {probeResults.map((r) => `${new URL(r.url).pathname.split('/')[1]} → ${r.ok ? `${r.tools} tools` : `denied (${r.status})`}`).join(' · ')}
              <button type="button" className="btn" onClick={() => setProbeResults(null)}>Dismiss</button>
            </div>
          )}
          {banner && (
            <div className="page-banner">
              {banner.message}
              <button type="button" className="btn" onClick={() => setBanner(null)}>Dismiss</button>
            </div>
          )}
        </>
      }
    />
  );
}
