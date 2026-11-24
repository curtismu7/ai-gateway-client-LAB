// Rule 27: the shared run-observability panel for this lab, with the lab's own states around it. The panel shows ONE run: one
// user action (a tools/list, a tools/call, a catalog load, a raw request, a door probe). The action's answer carries the run id
// in the X-Obs-Run response header (and the trace route's action); this file reads the id passed from the App and never guesses it.
// Nothing is re-read on a timer and there is no re-read button: this lab reads no logs, so a re-read could find nothing new.
import React, { useEffect, useState } from 'react';
import RunObservability from '../run-observability/RunObservability';
import { api } from '../lib/api';

// Where this lab's run leaves logs and where they can stream (the README says the same).
export const LOG_STREAMS = [
  { product: 'Agent Privilege Client LAB (this lab\'s container)', lives: 'its stdout. Each decision of a run is one line: the time, a step, the layer, the actor, a result and a run id. A line never holds an access token, a client secret or a session id. Mock writes what the mock gateway decided (checked); Real writes what the lab read from your gateway\'s answers (inferred or observed)', streams: 'nowhere today: the family log collector\'s source list does not name this container, so it would need an entry first' },
  { product: 'PingOne Agent Privilege gateway (Real)', lives: 'its own log (a log volume for a local gateway; the SIEM index for the hosted one)', streams: 'the Privilege SIEM export. This lab does not read it: a Real record holds only what the lab received' },
];

const TITLE = 'What each layer logged for this run';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The record route's answer -> what to show. Pure and total: no shape of answer can throw here.
function shapeOf(r) {
  const d = r?.data;
  if (!r?.ok) return { problem: isObj(d) && typeof d.message === 'string' && d.message ? d.message : `The lab answered ${r?.status ?? 'nothing'} when asked for this run's record.` };
  if (isObj(d) && 'record' in d) {
    if (d.record === null) return { empty: typeof d.message === 'string' && d.message ? d.message : 'There is no record for this run.' };
    if (isObj(d.record)) return { record: d.record };
  }
  return { problem: "The lab's answer was not a run record." };
}

const Note = ({ id, role, children }) => (
  <section className="ro" data-testid={id} aria-label={TITLE}>
    <h2>{TITLE}</h2>
    <p className="ro-muted" role={role}>{children}</p>
  </section>
);

// The one line under the panel: what a row is in this lab, true for every action the page can make.
const NOTE = "Rows are the decisions of one action's gateway exchanges: in Mock what the mock gateway decided (checked); in Real what the lab read from your gateway's answers (inferred or observed — a real gateway reports no per-check detail). The access-token check and the grant check are the Authorize layer; a refused grant is a policy refusal, while a refused access-token check is a credential state and counts as information. The gateway's list filter (what it hid from this caller) is the Agent gateway layer, and the MCP server's JSON-RPC answer is the Resource server row: information, never a second decision. The Direct door has no gateway in the path, so its action says so instead of showing a Privilege decision.";

export default function RunObs({ runId, source = 'mock' }) {
  const key = runId ?? 'none';
  const [answer, setAnswer] = useState(null);
  useEffect(() => {
    if (!runId) return undefined;
    let live = true;
    const done = (a) => { if (live) setAnswer({ key, ...a }); };
    api.get(`/api/gateway/obs/run?runId=${encodeURIComponent(runId)}`).then((r) => done(shapeOf(r))).catch((e) => done({ problem: `Could not reach the lab (${String(e?.message || e).slice(0, 120)}).` }));
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- a new run asks again; nothing else does

  if (!runId) return <Note id="ro-empty">Nothing has run yet. Make a gateway call and its record appears here.</Note>;
  if (!answer || answer.key !== key) return <Note id="ro-loading">Collecting this run's logs…</Note>; // never the previous record
  if (answer.problem) return <Note id="ro-problem" role="alert">{answer.problem}</Note>;
  if (answer.empty) return <Note id="ro-gone">{answer.empty}</Note>;
  return (
    <div data-testid="ro-wrap">
      <RunObservability record={answer.record} source={source} streams={LOG_STREAMS} />
      <p className="ro-muted" data-testid="ro-lab-note">{NOTE}</p>
    </div>
  );
}
