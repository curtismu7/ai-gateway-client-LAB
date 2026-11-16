// "What Privilege did" (rule 25): the shared GatewayTrace, fed by GET /api/gateway/trace (the newest action's exchanges, redacted
// on the server when they were recorded). The panel is vendored byte for byte in ../gateway-trace; only this glue is the lab's.
import React, { useEffect, useState } from 'react';
import GatewayTrace from '../gateway-trace/GatewayTrace';
import { api } from '../lib/api';

// The panel's default sentence says every request went to the Privilege gateway. On the Direct door that is not true, so say so.
export function basisNoteFor(exchanges) {
  if (exchanges.length > 0 && exchanges.every((ex) => ex.door === 'direct')) {
    return 'These calls used the Direct door: they went straight to the MCP server with no Privilege gateway in the path, so there is no Privilege decision to read. They are shown so you can compare them with the same call through the Privilege door.';
  }
  return undefined;
}

export default function TracePanel({ source, refreshKey }) {
  const [data, setData] = useState({ action: null, exchanges: [] });
  useEffect(() => {
    let live = true;
    api.get('/api/gateway/trace').then(({ ok, data: next }) => { if (live && ok && next) setData(next); });
    return () => { live = false; };
  }, [refreshKey]);
  return (
    <div data-testid="trace-panel">
      {data.action && <p className="tool-output__timing">Latest action: {data.action.label}, {data.action.at}. Each step is one request the lab sent through the door.</p>}
      <GatewayTrace exchanges={data.exchanges} source={source} basisNote={basisNoteFor(data.exchanges)} />
    </div>
  );
}
