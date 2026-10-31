import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, BaseEdge, MarkerType, Position, useNodesState, useStore, useViewport } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './FlowDiagram.css';
import { api } from '../lib/api';
import { routeEdges, polylinePath } from '../lib/edgeRouting';
import { placeLabels } from '../lib/labelPlacement';
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

// The path comes from routeEdges (own lane per edge). The text is not drawn here: LabelLayer places it.
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

const LABEL_FONT_PX = 11;
const BADGE_PX = 20;
const LABEL_H = 22;

function useLabelWidths(texts, fontTick) {
  return useMemo(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
    ctx.font = `600 ${LABEL_FONT_PX}px ${family}`;
    return texts.map((t) => Math.ceil(ctx.measureText(t).width * 1.05) + 18);
    // fontTick re-measures once the web font has loaded.
  }, [texts, fontTick]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Edge labels, drawn in screen space so their text stays at LABEL_FONT_PX at any zoom. Each label gets its own
 * spot along its own edge (placeLabels). Too tight for text: a numbered badge, and the text goes to the legend.
 * Runs again on every box move and every pan or zoom, so a label follows its edge.
 */
function LabelLayer({ labels, routes, rects, lit, onModes }) {
  const { x, y, zoom } = useViewport();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const [fontTick, setFontTick] = useState(0);
  useEffect(() => { document.fonts?.ready.then(() => setFontTick((n) => n + 1)); }, []);
  const widths = useLabelWidths(labels, fontTick);

  const placed = useMemo(() => {
    if (!width || !height) return [];
    const toScreen = (p) => ({ x: p.x * zoom + x, y: p.y * zoom + y });
    const items = labels.map((text, i) => ({
      id: i,
      points: (routes[i]?.points || []).map(toScreen),
      text: { w: widths[i], h: LABEL_H },
      badge: { w: BADGE_PX, h: BADGE_PX },
      badgeOnly: (routes[i]?.lanes || 1) > 1,
    })).filter((it) => labels[it.id] && it.points.length > 1);
    const obstacles = rects.map((r) => ({ x: r.x * zoom + x, y: r.y * zoom + y, w: r.w * zoom, h: r.h * zoom }));
    return placeLabels({ items, obstacles, bounds: { x: 0, y: 0, w: width, h: height }, pad: 4 });
  }, [labels, routes, rects, x, y, zoom, width, height, widths]);

  const key = placed.map((p) => `${p.id}:${p.mode}`).join(',');
  useEffect(() => { onModes(placed); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flow-labels">
      <svg className="flow-labels__leaders" width={width} height={height} aria-hidden="true">
        {placed.filter((p) => p.leader && p.mode !== 'listed').map((p) => (
          <line key={p.id} x1={p.anchor.x} y1={p.anchor.y} x2={p.box.x + p.box.w / 2} y2={p.box.y + p.box.h / 2} />
        ))}
      </svg>
      {placed.filter((p) => p.mode !== 'listed').map((p) => (
        <div
          key={p.id}
          className={`react-flow__edge-label flow-label${p.mode === 'badge' ? ' flow-label--badge' : ''}`}
          data-state={lit.has(p.id) ? 'on' : undefined}
          style={{ left: p.box.x, top: p.box.y, width: p.box.w, height: p.box.h }}
          title={labels[p.id]}
          aria-label={p.mode === 'badge' ? `${p.id + 1}: ${labels[p.id]}` : undefined}
        >
          {p.mode === 'badge' ? p.id + 1 : labels[p.id]}
        </div>
      ))}
    </div>
  );
}

export default function FlowDiagram({ name }) {
  const [diagram, setDiagram] = useState(null);
  const [error, setError] = useState(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [step, setStep] = useState(-1); // -1 = not started
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState('normal');
  const [placed, setPlaced] = useState([]);
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
  const labels = useMemo(() => (diagram ? diagram.edges.map((e) => e.label || '') : []), [diagram]);
  const nodeName = useMemo(() => new Map((diagram?.nodes || []).map((n) => [n.id, n.label])), [diagram]);
  const onModes = useCallback((next) => setPlaced((prev) => (
    prev.length === next.length && prev.every((p, i) => p.mode === next[i].mode) ? prev : next
  )), []);
  const legend = placed.filter((p) => p.mode !== 'text').map((p) => p.id);

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
        <button type="button" className="btn btn--primary" onClick={simulate}>{playing ? 'Pause' : 'Simulate'}</button>
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
        <ReactFlow
          nodes={nodes}
          edges={edges}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onInit={(rf) => { flowRef.current = rf; setReady(true); }}
          onMoveStart={(event) => { if (event) tracker.userMoved(); }}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          nodesConnectable={false}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} />
          <LabelLayer labels={labels} routes={routes} rects={rects} lit={lit} onModes={onModes} />
        </ReactFlow>
      </div>
      {clipped && <p className="flow-panel__hint">This panel is narrower than the diagram at a readable size. Drag the diagram to pan, or press Fit. Simulate pans to each step.</p>}
      {legend.length > 0 && (
        <ol className="flow-legend" aria-label="Arrow labels">
          {legend.map((i) => (
            <li key={i} className="flow-legend__item" data-state={lit.has(i) ? 'on' : undefined}>
              <span className="flow-legend__num">{i + 1}</span>
              <span>
                <strong>{nodeName.get(diagram.edges[i].source)} to {nodeName.get(diagram.edges[i].target)}</strong>
                {': '}{labels[i]}
              </span>
            </li>
          ))}
        </ol>
      )}
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
