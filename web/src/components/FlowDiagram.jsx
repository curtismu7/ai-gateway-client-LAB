import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, BaseEdge, MarkerType, Position, useNodesState } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowNoLabel, EdgeLabels, FitOpen, Passport, PassportActions } from '../diagram-kit/DiagramKit.jsx';
import { boxPassport, sidePoint } from '../diagram-kit/diagramKit.js';
import '../diagram-kit/diagram-kit.css';
import './FlowDiagram.css';
import { api } from '../lib/api';
import { routeEdges, polylinePath } from '../lib/edgeRouting';
import { boundsOf, createFitTracker, debounce, fitViewport, legibleZoom, MAX_ZOOM, revealViewport, shouldRefit } from '../lib/viewFit';

// Playback pause between steps, by speed setting.
const SPEED_MS = { slow: 2600, normal: 1500, fast: 800 };
const COLOR_CLASS = new Set(['red', 'dark', 'grey', 'blue', 'green', 'amber']);
// The view never zooms out past the point where box text drops under the legibility floor. Past it the user pans.
const MIN_ZOOM = legibleZoom();
// A resize settles this long before the view is refitted.
const REFIT_DEBOUNCE_MS = 150;

/** Builds ReactFlow nodes and edges from diagram-studio/1 data. Nothing is hand-drawn here. */
export function buildNodes(diagram) {
  return diagram.nodes.map((n) => {
    const color = COLOR_CLASS.has(diagram.groups?.[n.group]?.color) ? diagram.groups[n.group].color : 'dark';
    return {
      id: n.id,
      position: { x: Number(n.x) || 0, y: Number(n.y) || 0 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      className: `flow-node flow-node--${color}`,
      data: {
        label: (
          <div className="flow-node__body">
            <div className="flow-node__title">{n.label}</div>
            {(n.sub || []).map((line, i) => <div key={i} className="flow-node__sub">{line}</div>)}
          </div>
        ),
      },
    };
  });
}

/** Boxes as plain rectangles in flow units. A box that is not measured yet gets the size the CSS gives it. */
export function nodeRects(nodes) {
  return nodes.map((n) => ({
    id: n.id,
    x: n.position.x,
    y: n.position.y,
    w: n.measured?.width ?? 200,
    h: n.measured?.height ?? 64,
  }));
}

// The path comes from routeEdges (own lane per edge). The label text is drawn by the diagram kit's EdgeLabels.
function LaneEdge({ id, data, markerEnd, style }) {
  return <BaseEdge id={id} path={data.d} markerEnd={markerEnd} style={style} />;
}
const EDGE_TYPES = { lane: LaneEdge };

export function buildEdges(diagram, lit, routes) {
  return diagram.edges.map((e, i) => {
    const on = lit.has(i);
    return {
      id: `e${i}`,
      type: 'lane',
      source: e.source,
      target: e.target,
      data: { d: polylinePath(routes[i]?.points || []) },
      className: on ? 'flow-edge flow-edge--on' : 'flow-edge',
      animated: on,
      style: e.dashed ? { strokeDasharray: '6 4' } : undefined,
      markerEnd: { type: MarkerType.ArrowClosed },
    };
  });
}

// One label item per arrow, for the kit's EdgeLabels layer (above the boxes, never overlapping).
export function toLabelItems(diagram, lit) {
  return diagram.edges.map((e, i) => ({
    id: `e${i}`,
    text: e.label || '',
    source: e.source,
    target: e.target,
    active: lit.has(i),
    dim: lit.size > 0 && !lit.has(i),
  }));
}

// The facing sides of the two boxes: out on the right, in on the left; an arrow that points back to the left is swapped.
export function labelSides(diagram) {
  const at = Object.fromEntries(diagram.nodes.map((n) => [n.id, { x: Number(n.x) || 0, y: Number(n.y) || 0 }]));
  return diagram.edges.map((e) => (at[e.target].x >= at[e.source].x ? ['r', 'l'] : ['l', 'r']));
}

export default function FlowDiagram({ name }) {
  const [diagram, setDiagram] = useState(null);
  const [error, setError] = useState(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [step, setStep] = useState(-1); // -1 = not started
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState('normal');
  const [open, setOpen] = useState(null); // the id of the expanded box, or null
  const flowRef = useRef(null);
  const canvasRef = useRef(null);
  const [ready, setReady] = useState(false);
  const tracker = useRef(createFitTracker()).current;
  const pendingFit = useRef(true);
  const lastSize = useRef(null);
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { ok, data } = await api.get(`/api/gateway/diagrams/${name}`);
      if (cancelled) return;
      if (!ok) { setError('This diagram could not be loaded.'); return; }
      setDiagram(data);
      setNodes(buildNodes(data));
    })();
    return () => { cancelled = true; };
  }, [name, setNodes]);

  const stepCount = diagram?.steps?.length || 0;
  const currentStep = step >= 0 && step < stepCount ? diagram.steps[step] : null;
  const lit = useMemo(() => new Set(currentStep?.edges || []), [currentStep]);
  const rects = useMemo(() => nodeRects(nodes), [nodes]);
  const routes = useMemo(() => (diagram ? routeEdges(rects, diagram.edges) : []), [diagram, rects]);
  const edges = useMemo(() => (diagram ? buildEdges(diagram, lit, routes) : []), [diagram, lit, routes]);
  const items = useMemo(() => (diagram ? toLabelItems(diagram, lit) : []), [diagram, lit]);
  const sides = useMemo(() => (diagram ? labelSides(diagram) : []), [diagram]);
  const graph = useMemo(() => (diagram ? {
    nodes: diagram.nodes.map((n) => ({ id: n.id, label: n.label, sub: n.sub || [], group: n.group })),
    edges: diagram.edges.map((e) => ({ source: e.source, target: e.target, label: e.label || '' })),
    groups: diagram.groups,
  } : null), [diagram]);
  const withPassport = useMemo(() => nodes.map((n) => ({
    ...n,
    zIndex: n.id === open ? 10 : undefined,
    className: `${n.className ?? ''}${n.id === open ? ' dk-open' : ''}`,
    data: { ...n.data, passport: n.id === open && graph ? boxPassport(graph, n.id) : null },
  })), [nodes, open, graph]);
  const actions = useMemo(() => ({
    open: (id) => setOpen(id),
    close: () => setOpen(null),
    link: (id) => { const u = new URL(window.location.href); u.searchParams.set('box', id); return u.toString(); },
  }), []);

  // Simulate walks the steps in order, then stops on the last one.
  useEffect(() => {
    if (!playing) return undefined;
    const timer = setTimeout(() => {
      if (step + 1 < stepCount) setStep(step + 1);
      else setPlaying(false);
    }, step < 0 ? 0 : SPEED_MS[speed]);
    return () => clearTimeout(timer);
  }, [playing, step, speed, stepCount]);

  const simulate = useCallback(() => {
    if (playing) { setPlaying(false); return; }
    if (step < 0 || step >= stepCount - 1) setStep(-1);
    setPlaying(true);
  }, [playing, step, stepCount]);

  // Fit shows every box at the largest zoom that keeps box text legible (viewFit.js). It runs on Fit, on Reset, once
  // the boxes are measured, and when the canvas is resized and the user has not moved the view since the last fit.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const fit = useCallback(() => {
    const rf = flowRef.current;
    const el = canvasRef.current;
    if (!rf || !el) return false;
    const size = { w: el.clientWidth, h: el.clientHeight };
    const view = fitViewport({ bounds: boundsOf(nodeRects(nodesRef.current)), size, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM });
    if (!view) return false;
    rf.setViewport({ x: view.x, y: view.y, zoom: view.zoom });
    lastSize.current = size;
    setClipped(view.clipped);
    tracker.fitted();
    return true;
  }, [tracker]);

  // Simulate follows the step: when the boxes it names are not all on the canvas (a narrow panel at the legibility
  // floor), pan the smallest distance that shows them. The zoom stays where it is.
  useEffect(() => {
    const rf = flowRef.current;
    const el = canvasRef.current;
    if (!currentStep || !diagram || !rf || !el) return;
    const named = new Set();
    for (const i of currentStep.edges || []) {
      const e = diagram.edges[i];
      if (e) { named.add(e.source); named.add(e.target); }
    }
    const target = boundsOf(nodeRects(nodesRef.current).filter((r) => named.has(r.id)));
    const view = revealViewport({ view: rf.getViewport(), target, size: { w: el.clientWidth, h: el.clientHeight } });
    if (view) rf.setViewport(view);
  }, [currentStep]); // eslint-disable-line react-hooks/exhaustive-deps

  // First fit, and the fit after Reset, wait until every box has been measured so the bounds are real.
  useEffect(() => {
    if (!pendingFit.current || !ready || nodes.length === 0 || !nodes.every((n) => n.measured)) return;
    if (fit()) pendingFit.current = false;
  });

  // Resize: refit after the size settles, unless the user has moved or zoomed the view.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const settle = debounce(() => {
      const next = { w: el.clientWidth, h: el.clientHeight };
      if (shouldRefit({ moved: tracker.moved, prev: lastSize.current, next })) fit();
    }, REFIT_DEBOUNCE_MS);
    const ro = new ResizeObserver(settle);
    ro.observe(el);
    return () => { ro.disconnect(); settle.cancel(); };
  }, [diagram, fit, tracker]);

  // Reset stops the walkthrough, clears the highlight, and puts every box back where the data places it.
  // The boxes keep their measured size, so the refit has real bounds straight away.
  const reset = useCallback(() => {
    setPlaying(false);
    setStep(-1);
    setOpen(null);
    if (diagram) {
      setNodes((prev) => {
        const size = new Map(prev.map((n) => [n.id, n.measured]));
        return buildNodes(diagram).map((n) => ({ ...n, measured: size.get(n.id) }));
      });
    }
    pendingFit.current = true;
  }, [diagram, setNodes]);

  // A zoom button that actually changes the zoom counts as the user moving the view.
  const zoomBy = useCallback((dir) => {
    const rf = flowRef.current;
    if (!rf) return;
    const before = rf.getZoom();
    if (dir > 0) rf.zoomIn(); else rf.zoomOut();
    if (rf.getZoom() !== before) tracker.userMoved();
  }, [tracker]);

  const fitClick = useCallback(() => { pendingFit.current = false; fit(); }, [fit]);

  if (error) return <div className="flow-panel__msg">{error}</div>;
  if (!diagram) return <div className="flow-panel__msg">Loading diagram…</div>;

  return (
    <div className="flow-panel">
      <div className="flow-panel__head">
        <h2 className="flow-panel__title">{diagram.title}</h2>
        {diagram.lede && <p className="flow-panel__lede">{diagram.lede}</p>}
      </div>
      <div className="flow-panel__controls">
        <button type="button" className="btn" onClick={simulate}>{playing ? 'Pause' : 'Simulate'}</button>
        <button type="button" className="btn" onClick={reset}>Reset</button>
        <label className="flow-panel__speed">
          <span>Speed</span>
          <select value={speed} onChange={(e) => setSpeed(e.target.value)}>
            <option value="slow">Slow</option>
            <option value="normal">Normal</option>
            <option value="fast">Fast</option>
          </select>
        </label>
        <span className="flow-panel__zoom">
          <button type="button" className="btn" aria-label="Zoom in" onClick={() => zoomBy(1)}>+</button>
          <button type="button" className="btn" aria-label="Zoom out" onClick={() => zoomBy(-1)}>-</button>
          <button type="button" className="btn" aria-label="Fit the diagram" onClick={fitClick}>Fit</button>
        </span>
        <span className="flow-panel__count">{step >= 0 ? `Step ${step + 1} of ${stepCount}` : `${stepCount} steps`}</span>
      </div>
      <div className="flow-canvas" ref={canvasRef}>
        <PassportActions.Provider value={actions}>
          <ReactFlow
            nodes={withPassport}
            edges={edges}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onNodeClick={(_, n) => setOpen((o) => (o === n.id ? null : n.id))}
            onPaneClick={() => setOpen(null)}
            onInit={(rf) => { flowRef.current = rf; setReady(true); }}
            onMoveStart={(event) => { if (event) tracker.userMoved(); }}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            nodesConnectable={false}
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} />
            <EdgeLabels items={items} pointFor={(box, handle) => sidePoint(box, String(handle))} fallback={{ w: 160, h: 96 }} />
            <FitOpen open={open} closePadding={0.08} />
          </ReactFlow>
        </PassportActions.Provider>
      </div>
      {clipped && <p className="flow-panel__hint">This panel is narrower than the diagram at a readable size. Drag the diagram to pan, or press Fit. Simulate pans to each step.</p>}
      {currentStep && (
        <div className="flow-step" aria-live="polite">
          <strong>{currentStep.title}</strong>
          <p>{currentStep.what}</p>
          {currentStep.why && <p className="flow-step__why">{currentStep.why}</p>}
        </div>
      )}
    </div>
  );
}
