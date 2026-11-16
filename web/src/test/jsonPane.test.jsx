// Rule 24: every JSON pane in this lab is the shared JsonPane (vendored byte-for-byte, pinned), with a Form | JSON
// toggle, the important keys stood out, the full view (no cap), and hostile text shown as text.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setJsonView } from '../components/JsonPane.jsx';

vi.mock('../lib/api', () => ({
  api: {
    post: vi.fn(async () => ({
      ok: true,
      data: { result: { contents: [{ uri: 'docs://x', mimeType: 'application/json', text: '{"isError":false,"note":"<img src=x onerror=alert(1)>","nested":{"hint":"a‮b"}}' }] } },
    })),
  },
}));
const { ResourceDetail, ToolSchema } = await import('../components/ItemDetail.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const here = path.dirname(fileURLToPath(import.meta.url));
let host; let root;
const mount = async (el) => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(el)); return host; };
const click = async (el) => act(async () => el.click());
beforeEach(() => { setJsonView('raw'); });
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });

const TOOL = {
  name: 'delete_record',
  annotations: { readOnlyHint: false, destructiveHint: true, title: '<b>bold</b>' },
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

describe('JsonPane vendoring', () => {
  it('the vendored files match their pins', () => {
    for (const [file, pin] of [['JsonPane.jsx', 'JsonPane.sha256'], ['JsonPane.css', 'JsonPane.css.sha256']]) {
      const dir = path.join(here, '..', 'components');
      const want = fs.readFileSync(path.join(dir, pin), 'utf8').trim().split(/\s+/)[0];
      const got = createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex');
      expect(got, file).toBe(want);
    }
  });
});

describe('tool schema and annotations', () => {
  it('opens on the Form view, stands out the tool hints, keeps markup inert, and switches every pane to the JSON text', async () => {
    setJsonView('form');
    const page = await mount(<ToolSchema tool={TOOL} />);
    const ann = page.querySelector('[data-testid="tool-annotations"]');
    const schema = page.querySelector('[data-testid="tool-schema"]');
    expect(ann.tagName).toBe('DIV'); // the Form view: a label and a value per field
    expect(ann.textContent).toContain('destructiveHint');
    expect(ann.textContent).not.toContain('"destructiveHint"');
    expect(ann.querySelectorAll('[data-hot="true"]').length).toBe(2); // readOnlyHint and destructiveHint
    expect(schema.querySelector('[data-hot="true"]')).not.toBeNull(); // required
    expect(ann.textContent).toContain('<b>bold</b>');
    expect(page.querySelector('b')).toBeNull();
    const jsonButtons = [...page.querySelectorAll('button')].filter((b) => b.textContent === 'JSON');
    expect(jsonButtons).toHaveLength(2); // one toggle per pane
    await click(jsonButtons[0]);
    expect(page.querySelector('[data-testid="tool-annotations"]').tagName).toBe('PRE'); // one choice for the page
    expect(page.querySelector('[data-testid="tool-schema"]').tagName).toBe('PRE');
    expect(page.querySelector('[data-testid="tool-annotations"]').textContent).toContain('"destructiveHint": true');
    expect(page.querySelector('[data-testid="tool-schema"]').textContent).toContain('"required": [');
  });

  it('says so when the server sent no annotations', async () => {
    const page = await mount(<ToolSchema tool={{ ...TOOL, annotations: undefined }} />);
    expect(page.textContent).toContain('None sent by the server.');
    expect(page.querySelector('[data-testid="tool-annotations"]')).toBeNull();
  });
});

describe('resource content', () => {
  it('JSON content is a JsonPane: the pretty-printed text, hostile text as text, bidi characters as escapes', async () => {
    const page = await mount(<ResourceDetail resource={{ name: 'x', uri: 'docs://x', mimeType: 'application/json' }} />);
    await click([...page.querySelectorAll('button')].find((b) => b.textContent === 'Read'));
    const pane = page.querySelector('[data-testid="resource-content"]');
    expect(pane.tagName).toBe('PRE');
    expect(pane.textContent).toContain('"isError": false');
    expect(pane.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(pane.textContent).toContain('\\u202e');
    expect(page.querySelector('img')).toBeNull();
    expect(pane.querySelector('[data-hot="true"]')).toBeNull(); // no lab keys marked here; the defaults do not occur
    await click([...page.querySelectorAll('button')].find((b) => b.textContent === 'Form'));
    expect(page.querySelector('[data-testid="resource-content"]').tagName).toBe('DIV');
    expect(page.querySelector('[data-testid="resource-content"]').querySelector('[data-alert="true"]')).not.toBeNull(); // note is an alert key
  });
});
