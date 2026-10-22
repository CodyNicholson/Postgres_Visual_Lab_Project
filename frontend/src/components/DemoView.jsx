import React, { useState } from 'react';
import FlowDiagram from './FlowDiagram.jsx';
import ResultPanel from './ResultPanel.jsx';
import CodeBlock from './CodeBlock.jsx';
import { PitfallCard } from './PitfallsPage.jsx';
import { runAction } from '../api.js';
import { VISUALS } from '../visuals/index.js';

export function defaultInputs(demo) {
  return Object.fromEntries((demo.inputs || []).map((input) => [input.name, input.default]));
}

function Input({ input, value, onChange }) {
  const id = `input-${input.name}`;
  let control;
  if (input.type === 'select') {
    control = (
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {input.options.map((o) => <option key={String(o)} value={o}>{String(o)}</option>)}
      </select>
    );
  } else if (input.type === 'textarea') {
    control = <textarea id={id} rows={input.rows || 4} value={value} onChange={(e) => onChange(e.target.value)} />;
  } else if (input.type === 'checkbox') {
    control = <input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />;
  } else {
    control = (
      <input id={id} type={input.type} value={value} min={input.min} max={input.max} step={input.step}
        onChange={(e) => onChange(e.target.value)} />
    );
  }
  return (
    <label className={`input ${input.type === 'textarea' ? 'input-wide' : ''}`} htmlFor={id}>
      <span>{input.label}</span>
      {control}
    </label>
  );
}

/**
 * One demo: what it teaches, an animated request flow, its buttons, a live visual of the data,
 * the code behind it, its common mistakes, and the exact commands and checks from the last run. Demo state lives in
 * App so it survives switching between demos.
 */
export default function DemoView({ demo, state, update }) {
  const inputs = state.inputs;
  const [flow, setFlow] = useState({ steps: demo.flow, key: 0 });
  const [busy, setBusy] = useState(null);
  const Visual = VISUALS[demo.visual];

  const play = (steps) => setFlow((prev) => ({ steps, key: prev.key + 1 }));

  const run = async (actionId, overrides = {}) => {
    const action = demo.actions.find((a) => a.id === actionId);
    const merged = { ...inputs, ...overrides };
    if (Object.keys(overrides).length) update({ inputs: merged });
    if (!action.flowFor) play(action.flow ? action.flow(merged) : demo.flow);
    setBusy(actionId);
    update({ error: null });
    try {
      const result = await runAction(action, merged);
      if (action.flowFor) play(action.flowFor(result, merged));
      update((prev) => ({
        last: { ...result, actionId, actionLabel: action.label, receivedAt: Date.now() },
        history: [...(prev.history || []), { ...result, actionId }].slice(-30),
      }));
    } catch (error) {
      update({ error: error.message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="demo" aria-labelledby={`title-${demo.id}`}>
      <header className="demo-head">
        <span className="chip">{demo.category}</span>
        <h2 id={`title-${demo.id}`}>{demo.title}</h2>
        <p className="tagline">{demo.tagline}</p>
      </header>

      <div className="demo-intro">
        <section className="card explain">
          <h3>How it works</h3>
          {demo.description.map((p, i) => <p key={i}>{p}</p>)}
          {demo.keyApis?.length > 0 && (
            <div className="use-cases">
              <span className="muted">Key APIs</span>
              {demo.keyApis.map((a) => <code key={a} className="chip chip-code">{a}</code>)}
            </div>
          )}
          {demo.useCases?.length > 0 && (
            <div className="use-cases">
              <span className="muted">Used for</span>
              {demo.useCases.map((u) => <span key={u} className="chip chip-soft">{u}</span>)}
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-title-row">
            <h3>Request flow</h3>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => play(flow.steps)}>↻ Replay</button>
          </div>
          <FlowDiagram steps={flow.steps} runKey={flow.key} />
        </section>
      </div>

      <section className="card controls">
        {demo.inputs?.length > 0 && (
          <div className="inputs">
            {demo.inputs.map((input) => (
              <Input key={input.name} input={input} value={inputs[input.name] ?? ''}
                onChange={(value) => update({ inputs: { ...inputs, [input.name]: value } })} />
            ))}
          </div>
        )}
        <div className="actions">
          {demo.actions.map((action) => (
            <button key={action.id} type="button" disabled={busy !== null}
              className={`btn btn-${action.tone || 'default'} ${busy === action.id ? 'btn-busy' : ''}`}
              onClick={() => run(action.id)}>
              {busy === action.id && <span className="spinner" aria-hidden="true" />}
              {action.label}
            </button>
          ))}
        </div>
        {state.error && <div className="error" role="alert">⚠ {state.error}</div>}
      </section>

      <section className="card visual">
        {Visual && <Visual demo={demo} result={state.last} history={state.history || []} inputs={inputs} run={run} busy={busy} />}
      </section>

      {demo.snippet && (
        <section className="card">
          <h3>The code</h3>
          <CodeBlock code={demo.snippet.code} lang={demo.snippet.lang} name={demo.snippet.name} />
        </section>
      )}

      {demo.pitfalls?.length > 0 && (
        <section className="card">
          <h3>Common mistakes and how to fix them</h3>
          <ul className="pitfall-list">
            {demo.pitfalls.map((pitfall, i) => (
              <PitfallCard key={pitfall.mistake} pitfall={pitfall} index={i}
                onReproduce={pitfall.reproduce && busy === null ? () => run(pitfall.reproduce) : undefined} />
            ))}
          </ul>
        </section>
      )}

      <ResultPanel result={state.last} actionLabel={state.last?.actionLabel} />
    </article>
  );
}
