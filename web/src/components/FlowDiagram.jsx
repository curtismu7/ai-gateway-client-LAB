import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, MarkerType, Position, useNodesState } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './FlowDiagram.css';
import { api } from '../lib/api';

// Playback pause between steps, by speed setting.
const SPEED_MS = { slow: 2600, normal: 1500, fast: 800 };
const COLOR_CLASS = new Set(['red', 'dark', 'grey', 'blue', 'green', 'amber']);

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

export function buildEdges(diagram, lit) {
  return diagram.edges.map((e, i) => {
    const on = lit.has(i);
    return {
      id: `e${i}`,
      type: 'smoothstep',
      source: e.source,
      target: e.target,
      label: e.label || undefined,
      className: on ? 'flow-edge flow-edge--on' : 'flow-edge',
      animated: on,
      style: e.dashed ? { strokeDasharray: '6 4' } : undefined,
      markerEnd: { type: MarkerType.ArrowClosed },
    };
  });
}

export default function FlowDiagram({ name }) {
  const [diagram, setDiagram] = useState(null);
  const [error, setError] = useState(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [step, setStep] = useState(-1); // -1 = not started
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState('normal');

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
  const edges = useMemo(() => (diagram ? buildEdges(diagram, lit) : []), [diagram, lit]);

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

  // Reset stops the walkthrough, clears the highlight, and puts every box back where the data places it.
  const reset = useCallback(() => {
    setPlaying(false);
    setStep(-1);
    if (diagram) setNodes(buildNodes(diagram));
  }, [diagram, setNodes]);

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
        <span className="flow-panel__count">{step >= 0 ? `Step ${step + 1} of ${stepCount}` : `${stepCount} steps`}</span>
      </div>
      <div className="flow-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          fitView
          fitViewOptions={{ padding: 0.08 }}
          minZoom={0.4}
          maxZoom={1.5}
          nodesConnectable={false}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} />
        </ReactFlow>
      </div>
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
