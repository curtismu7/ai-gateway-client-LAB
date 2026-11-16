// "What Privilege did" in the page (rule 25): the Trace tab shows the shared GatewayTrace for what the server recorded, after a run,
// in Mock and in Real, and says honestly when a call never went through a gateway (the Direct door). The fixtures are built with the
// shared server builder, so the panel is fed the exact shape the server sends.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockTrace, realTrace } from '../../../server/src/gatewayTrace.js';
import { setJsonView } from '../components/JsonPane.jsx';

const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 3, method, params });
const mockEx = (door = 'privilege') => ({
  step: 1,
  title: door === 'direct' ? 'Direct door (no gateway): tools/list' : 'Gateway: tools/list',
  status: 200,
  door,
  trace: mockTrace({
    url: 'https://mock-gateway.invalid/opensearch/mcp', authorization: 'Bearer <token, 120 characters, kept on the server>', rpc: rpc('tools/list'), status: 200,
    body: { jsonrpc: '2.0', id: 3, result: { tools: [{ name: 'search' }] } },
    decisions: [{ id: 'authenticated', label: 'Access token', outcome: 'pass', evidence: 'the bearer token is signed by the mock sign-in server' }],
  }),
});
const realEx = () => ({
  step: 1, title: 'Gateway: tools/list', status: 200, door: 'privilege',
  trace: realTrace({
    url: 'https://gateway.example.invalid/aggregate/mcp', authorization: 'Bearer <token, 40 characters, kept on the server>', rpc: rpc('tools/list'), status: 200,
    body: { jsonrpc: '2.0', id: 3, result: { tools: [{ name: 'search' }] } }, credential: 'workload-token',
  }),
});

let traceReply = { action: null, exchanges: [] };
const apiGet = vi.fn(async (path) => {
  if (path === '/api/gateway/trace') return { ok: true, status: 200, data: traceReply };
  if (path === '/api/gateway/state') {
    return { ok: true, status: 200, data: {
      mode: { current: globalThis.__mode || 'mock' }, config: { mcpUrl: 'https://mock-gateway.invalid/opensearch/mcp' }, gatewayMode: 'privilege', gatewayConfigs: {},
      oauth: { authenticated: true }, presets: [], tools: [], policy: {}, mcp: {}, mockSample: null, doorDiscovery: {},
    } };
  }
  if (path === '/api/gateway/catalog') return { ok: true, status: 200, data: { tools: [], prompts: [], resources: [], resourceTemplates: [], lists: {}, protocol: {}, errors: [] } };
  return { ok: false, status: 404, data: null };
});
const apiPost = vi.fn(async () => ({ ok: true, status: 200, data: { result: { tools: [] } } }));
vi.mock('../lib/api', () => ({ api: { get: (...a) => apiGet(...a), post: (...a) => apiPost(...a), put: vi.fn(), del: vi.fn() } }));

// The talk track reads ../docs by ?raw, outside the web root; this test is about the Trace tab, so it is left out.
vi.mock('../components/TalkTrackPanel', () => ({ default: () => null }));

const { default: TracePanel, basisNoteFor } = await import('../components/TracePanel.jsx');
const { default: App } = await import('../App.jsx');

beforeEach(() => {
  setJsonView('raw');
  traceReply = { action: null, exchanges: [] };
  globalThis.__mode = 'mock';
  apiGet.mockClear();
  globalThis.EventSource = class { addEventListener() {} close() {} };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
});
afterEach(() => { delete globalThis.__mode; });

describe('TracePanel', () => {
  it('Mock: shows the shared panel with the step, the checked decision and the exact request and response', async () => {
    traceReply = { action: { id: 1, label: 'tools/list', at: '2026-11-16T10:00:00Z' }, exchanges: [mockEx()] };
    render(<TracePanel source="mock" refreshKey={0} />);
    expect(await screen.findByTestId('gateway-trace')).toBeInTheDocument();
    expect(screen.getByTestId('gateway-trace-basis')).toHaveTextContent(/Simulated/);
    const step = screen.getByTestId('trace-1');
    expect(step).toHaveTextContent('Gateway: tools/list');
    expect(within(screen.getByTestId('trace-1-decisions')).getByText(/signed by the mock sign-in server/)).toBeInTheDocument();
    expect(within(screen.getByTestId('trace-1-decisions')).queryByText('inferred from the outcome')).toBeNull();
    expect(screen.getByTestId('trace-1-request-head')).toHaveTextContent('POST https://mock-gateway.invalid/opensearch/mcp');
    expect(screen.getByTestId('trace-1-request-head')).toHaveTextContent('Bearer <token, 120 characters, kept on the server>');
    expect(screen.getByTestId('trace-1-request-body')).toHaveTextContent('"method": "tools/list"');
    expect(screen.getByTestId('trace-1-response-body')).toHaveTextContent('"search"');
    expect(screen.getByTestId('trace-panel')).toHaveTextContent('Latest action: tools/list');
  });

  it('Real: says the gateway reports no per-check breakdown, and labels the decisions inferred', async () => {
    traceReply = { action: { id: 1, label: 'tools/list', at: '2026-11-16T10:00:00Z' }, exchanges: [realEx()] };
    render(<TracePanel source="real" refreshKey={0} />);
    expect(await screen.findByTestId('trace-1')).toBeInTheDocument();
    expect(screen.getByTestId('gateway-trace-basis')).toHaveTextContent(/Real gateway/);
    expect(within(screen.getByTestId('trace-1-decisions')).getAllByText('inferred from the outcome').length).toBeGreaterThan(0);
  });

  it('the Direct door says there is no gateway in the path instead of claiming a Privilege decision', async () => {
    traceReply = { action: { id: 1, label: 'tools/list', at: 'now' }, exchanges: [mockEx('direct')] };
    render(<TracePanel source="mock" refreshKey={0} />);
    expect(await screen.findByTestId('trace-1')).toHaveTextContent('Direct door (no gateway)');
    expect(screen.getByTestId('gateway-trace-basis')).toHaveTextContent(/no Privilege gateway in the path/);
    expect(basisNoteFor([mockEx('direct'), mockEx('privilege')])).toBeUndefined();
    expect(basisNoteFor([])).toBeUndefined();
  });

  it('before any run it tells the visitor what to do, and reloads when the refresh key changes', async () => {
    const view = render(<TracePanel source="mock" refreshKey={0} />);
    expect(await screen.findByTestId('gateway-trace-empty')).toBeInTheDocument();
    traceReply = { action: { id: 2, label: 'rpc', at: 'now' }, exchanges: [mockEx()] };
    view.rerender(<TracePanel source="mock" refreshKey={1} />);
    expect(await screen.findByTestId('trace-1')).toBeInTheDocument();
  });
});

describe('the page', () => {
  it('after a raw request, the Trace tab shows the gateway trace', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Send' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/gateway/request', expect.objectContaining({ method: 'resources/list' })));
    traceReply = { action: { id: 1, label: 'request', at: 'now' }, exchanges: [mockEx()] };
    await user.click(screen.getByRole('button', { name: 'Trace' }));
    expect(await screen.findByTestId('gateway-trace')).toBeInTheDocument();
    expect(await screen.findByTestId('trace-1')).toHaveTextContent('Gateway: tools/list');
  });

  it('in Real mode the page passes source real to the panel', async () => {
    globalThis.__mode = 'live';
    traceReply = { action: { id: 1, label: 'request', at: 'now' }, exchanges: [realEx()] };
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Trace' }));
    expect(await screen.findByTestId('trace-1')).toBeInTheDocument();
    expect(screen.getByTestId('gateway-trace-basis')).toHaveTextContent(/Real gateway/);
  });
});
