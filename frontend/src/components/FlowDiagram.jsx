import React, { useEffect, useRef, useState } from 'react';
import { NODE_META, nodesFor } from '../demos/catalog.js';

const STEP_MS = 1100;
const WIDTH = 640;
const NODE_W = 124;
const NODE_H = 56;
const NODE_Y = 14;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function layout(nodes) {
  const pad = NODE_W / 2 + 8;
  const gap = nodes.length > 1 ? (WIDTH - pad * 2) / (nodes.length - 1) : 0;
  return Object.fromEntries(nodes.map((id, i) => [id, nodes.length > 1 ? pad + i * gap : WIDTH / 2]));
}

/** Requests curve below the nodes, replies curve a little deeper, so both directions stay readable. */
function edgePath(x1, x2, forward) {
  const y = NODE_Y + NODE_H;
  const depth = forward ? 58 : 84;
  return `M ${x1} ${y} C ${x1} ${y + depth}, ${x2} ${y + depth}, ${x2} ${y}`;
}

/** SMIL animations inserted after page load must be started by hand, or they jump to the end. */
function Packet({ path, color }) {
  const motion = useRef(null);
  useEffect(() => {
    motion.current?.beginElement?.();
  }, []);
  return (
    <g className="packet">
      <circle r="9" fill={color} opacity="0.25" />
      <circle r="5.5" fill={color} />
      <animateMotion ref={motion} dur="0.85s" begin="indefinite" fill="freeze" path={path} />
    </g>
  );
}

export default function FlowDiagram({ steps, runKey, compact = false }) {
  const [index, setIndex] = useState(-1);
  const reduced = prefersReducedMotion();

  useEffect(() => {
    if (!steps?.length) return undefined;
    setIndex(0);
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      setIndex(i);
      if (i >= steps.length) clearInterval(timer);
    }, STEP_MS);
    return () => clearInterval(timer);
  }, [runKey, steps]);

  if (!steps?.length) return null;
  const nodes = nodesFor(steps);
  const xs = layout(nodes);
  const current = index >= 0 && index < steps.length ? steps[index] : null;
  const height = NODE_Y + NODE_H + 100;
  const edges = [];
  const seen = new Set();
  steps.forEach(([from, to]) => {
    const key = `${from}>${to}`;
    if (from !== to && !seen.has(key)) {
      seen.add(key);
      edges.push([from, to]);
    }
  });

  return (
    <div className={`flow ${compact ? 'flow-compact' : ''}`}>
      <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label="Request flow diagram">
        <defs>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {edges.map(([from, to]) => {
          const active = current && current[0] === from && current[1] === to;
          return (
            <path
              key={`${from}>${to}`}
              d={edgePath(xs[from], xs[to], xs[from] < xs[to])}
              className={`edge ${active ? 'edge-active' : ''}`}
              style={active ? { stroke: NODE_META[from].color } : undefined}
            />
          );
        })}

        {nodes.map((id) => {
          const meta = NODE_META[id];
          const busy = current && (current[0] === id || current[1] === id);
          const working = current && current[0] === id && current[1] === id;
          return (
            <g key={id} transform={`translate(${xs[id] - NODE_W / 2}, ${NODE_Y})`} className={`node ${busy ? 'node-busy' : ''}`}>
              {working && !reduced && (
                <rect className="node-pulse" x="-4" y="-4" width={NODE_W + 8} height={NODE_H + 8} rx="14" style={{ stroke: meta.color }} />
              )}
              <rect width={NODE_W} height={NODE_H} rx="11" className="node-box" style={{ stroke: meta.color }} filter={busy ? 'url(#glow)' : undefined} />
              <circle cx="14" cy="16" r="4" fill={meta.color} />
              <text x="24" y="22" className="node-label">{meta.label}</text>
              <text x="14" y="43" className="node-sub">{meta.sub}</text>
            </g>
          );
        })}

        {current && current[0] !== current[1] && !reduced && (
          <Packet
            key={`${runKey}-${index}`}
            path={edgePath(xs[current[0]], xs[current[1]], xs[current[0]] < xs[current[1]])}
            color={NODE_META[current[0]].color}
          />
        )}
      </svg>

      <div className="flow-caption" aria-live="polite">
        {current ? (
          <span key={`${runKey}-${index}`} className="flow-caption-text">
            <b style={{ color: NODE_META[current[0]].color }}>{NODE_META[current[0]].label}</b>
            {current[0] !== current[1] && <> → <b style={{ color: NODE_META[current[1]].color }}>{NODE_META[current[1]].label}</b></>}
            : <code>{current[2]}</code>
          </span>
        ) : (
          <span className="muted">{index >= steps.length ? 'Done. Press Replay to watch again.' : ' '}</span>
        )}
      </div>

      {!compact && (
        <ol className="flow-steps">
          {steps.map(([from, to, label], i) => (
            <li key={i} className={i === index ? 'step-now' : i < index ? 'step-done' : ''}>
              <span className="step-dot" style={{ background: NODE_META[from].color }} />
              <span className="step-route">{NODE_META[from].label}{from !== to ? ` → ${NODE_META[to].label}` : ''}</span>
              <code>{label}</code>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
