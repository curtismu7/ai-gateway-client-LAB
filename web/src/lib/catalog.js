// Pure helpers for the catalog panels (tools, resources, templates, prompts).
// No React and no DOM, so the server test suite can import and test them.

// Characters that cannot be seen or that reorder text: zero-width, bidi controls,
// word joiners, the byte order mark, soft hyphen and the tag block.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD\u{E0000}-\u{E007F}]/gu;
// Anything that looks like an HTML tag or comment.
const HTML_LIKE = /<\/?[a-z][^>]*>|<!--/i;

const label = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * Looks at untrusted text (a tool description, a resource body) without changing what is shown.
 * Returns the invisible characters found, whether it holds HTML-looking text, and a copy of
 * the text where each invisible character is replaced by a visible marker such as [U+200B].
 */
export function inspectText(value) {
  const text = typeof value === 'string' ? value : '';
  const invisible = [];
  const marked = text.replace(INVISIBLE, (ch, index) => {
    const name = label(ch.codePointAt(0));
    invisible.push({ index, name });
    return `[${name}]`;
  });
  const counts = {};
  for (const item of invisible) counts[item.name] = (counts[item.name] || 0) + 1;
  return {
    text,
    marked,
    invisible,
    invisibleSummary: Object.entries(counts).map(([name, n]) => (n > 1 ? `${name} x${n}` : name)).join(', '),
    htmlLike: HTML_LIKE.test(text),
  };
}

/**
 * JSON.stringify for display. Characters you cannot see (or that reorder the line) are written
 * as escapes, so a hostile string cannot hide in or scramble the response pane.
 */
export function safeJson(value, space = 2) {
  const text = JSON.stringify(value, null, space);
  if (text === undefined) return '';
  return text.replace(INVISIBLE, (ch) => {
    const cp = ch.codePointAt(0);
    return cp > 0xffff ? `\\u{${cp.toString(16).toUpperCase()}}` : `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  });
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Turns the /catalog response into the numbers the counts line needs. */
export function summarise(catalog) {
  const lists = catalog?.lists || {};
  const count = (name) => (Array.isArray(catalog?.[name]) ? catalog[name].length : 0);
  const hidden = (name) => (lists[name]?.hidden || []).length;
  const unsupported = Object.entries(lists).filter(([, l]) => l && l.supported === false).map(([name]) => name);
  return {
    tools: count('tools'),
    resources: count('resources'),
    templates: count('resourceTemplates'),
    prompts: count('prompts'),
    hiddenTools: hidden('tools'),
    hiddenResources: hidden('resources'),
    hiddenPrompts: hidden('prompts'),
    unsupported,
  };
}

/** The mock API reports per-door counts in the same shape as summarise(). */
export function fromDoorCounts(counts) {
  return {
    tools: counts.tools,
    resources: counts.resources,
    templates: counts.templates,
    prompts: counts.prompts,
    hiddenTools: counts.hiddenTools,
    hiddenResources: counts.hiddenResources,
    hiddenPrompts: counts.hiddenPrompts,
    unsupported: [],
  };
}

/** For example: "Privilege: 5 tools, 3 resources, 1 prompt (9 tools hidden by policy)". */
export function countsLine(doorLabel, s) {
  const parts = [];
  parts.push(s.unsupported.includes('tools') ? 'tools not supported' : plural(s.tools, 'tool'));
  parts.push(s.unsupported.includes('resources') ? 'resources not supported' : plural(s.resources, 'resource'));
  parts.push(s.unsupported.includes('prompts') ? 'prompts not supported' : plural(s.prompts, 'prompt'));
  let line = `${doorLabel}: ${parts.join(', ')}`;
  const hidden = [];
  if (s.hiddenTools) hidden.push(plural(s.hiddenTools, 'tool'));
  if (s.hiddenResources) hidden.push(plural(s.hiddenResources, 'resource'));
  if (s.hiddenPrompts) hidden.push(plural(s.hiddenPrompts, 'prompt'));
  if (hidden.length) line += ` (${hidden.join(', ')} hidden by policy)`;
  return line;
}

/** For example: "Loaded 40 tools in 4 pages". */
export function pageNote(kindOne, kindMany, count, pages) {
  return `Loaded ${plural(count, kindOne, kindMany)} in ${plural(pages, 'page')}`;
}

/** Content for the reader: JSON is pretty-printed, everything else is shown as received. Never HTML. */
export function formatContent(text, mimeType) {
  const type = String(mimeType || '').toLowerCase();
  if (type.includes('json')) {
    try {
      return { format: 'json', text: JSON.stringify(JSON.parse(text), null, 2) };
    } catch {
      return { format: 'text', text, note: 'Declared as JSON but it does not parse. Shown as received.' };
    }
  }
  return { format: type.includes('markdown') ? 'markdown' : 'text', text };
}

/** Variable names in a URI template such as docs://pages/{slug}. */
export function templateVariables(uriTemplate) {
  return [...String(uriTemplate || '').matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
}

export function fillTemplate(uriTemplate, values) {
  return String(uriTemplate || '').replace(/\{([A-Za-z0-9_]+)\}/g, (_m, name) => encodeURIComponent(values[name] ?? ''));
}

/** Badges for one tool. Words, not just colour. */
export function toolBadges(tool, { hiddenOnPrivilege = false, hiddenHere = false } = {}) {
  const a = tool?.annotations || {};
  const badges = [];
  if (a.readOnlyHint === true) badges.push({ key: 'read-only', text: 'read-only' });
  if (a.destructiveHint === true) badges.push({ key: 'destructive', text: 'destructive' });
  if (a.idempotentHint === true && a.readOnlyHint !== true) badges.push({ key: 'idempotent', text: 'idempotent' });
  if (hiddenHere) badges.push({ key: 'hidden', text: 'hidden by policy' });
  else if (hiddenOnPrivilege) badges.push({ key: 'hidden', text: 'hidden on Privilege door' });
  return badges;
}

/** True when a description is long enough that the list shows only its first line. */
export function isLong(text, limit = 70) {
  return typeof text === 'string' && text.length > limit;
}
