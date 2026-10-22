import React, { useMemo, useState } from 'react';
import CodeBlock from './CodeBlock.jsx';
import { OVERVIEW } from '../demos/guide.js';
import { DEMOS } from '../demos/catalog.js';

/** One mistake: what people do, the error they see, why, how to fix it now and how to avoid it next time. */
export function PitfallCard({ pitfall, index = 0, onReproduce, onOpen, demoTitle }) {
  return (
    <li className="pitfall" style={{ animationDelay: `${index * 70}ms` }}>
      <div className="pitfall-head">
        <b>{pitfall.mistake}</b>
        {demoTitle && <button type="button" className="chip chip-soft chip-link" onClick={onOpen}>{demoTitle}</button>}
      </div>
      {pitfall.symptom && <pre className="pitfall-symptom">{pitfall.symptom}</pre>}
      <dl className="pitfall-grid">
        {pitfall.why && <><dt>Why</dt><dd>{pitfall.why}</dd></>}
        {pitfall.fix && <><dt className="ok">Fix it</dt><dd>{pitfall.fix}</dd></>}
        {pitfall.avoid && <><dt className="warn-text">Avoid it</dt><dd>{pitfall.avoid}</dd></>}
      </dl>
      {(pitfall.wrongCode || pitfall.rightCode) && (
        <div className="two-col pitfall-code">
          {pitfall.wrongCode && <div><span className="bad">✗ Don't</span><CodeBlock code={pitfall.wrongCode} lang={pitfall.lang} /></div>}
          {pitfall.rightCode && <div><span className="ok">✓ Do</span><CodeBlock code={pitfall.rightCode} lang={pitfall.lang} /></div>}
        </div>
      )}
      {onReproduce && (
        <button type="button" className="btn btn-ghost btn-small" onClick={onReproduce}>▶ Reproduce it for real</button>
      )}
    </li>
  );
}

const matches = (query, ...fields) => !query || fields.join(' ').toLowerCase().includes(query.toLowerCase());

/**
 * Every way people get Postgres wrong in one searchable page: how not to use it, the errors people
 * hit (paste an error message into the search box), and each feature's pitfalls with a link to its demo.
 */
export default function PitfallsPage({ onOpen }) {
  const [query, setQuery] = useState('');
  const antiPatterns = (OVERVIEW.antiPatterns || []).filter((a) => matches(query, a.dont, a.why, a.instead));
  const troubleshooting = (OVERVIEW.troubleshooting || []).filter((t) => matches(query, t.mistake, t.symptom, t.why, t.fix, t.avoid));
  const perDemo = useMemo(() => DEMOS.flatMap((demo) => (demo.pitfalls || []).map((pitfall) => ({ demo, pitfall }))), []);
  const demoPitfalls = perDemo.filter(({ demo, pitfall }) => matches(query, demo.title, pitfall.mistake, pitfall.symptom, pitfall.why, pitfall.fix, pitfall.avoid));

  return (
    <article className="demo">
      <header className="demo-head">
        <span className="chip">Pitfalls</span>
        <h2>Mistakes, errors and fixes</h2>
        <p className="tagline">How not to use Postgres, the errors people hit most, and how to avoid and resolve each one.</p>
      </header>

      <label className="input input-wide" htmlFor="pitfall-search">
        <span>Search (paste an error message)</span>
        <input id="pitfall-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. connection refused" />
      </label>

      {antiPatterns.length > 0 && (
        <section className="card list-card list-bad">
          <h3>How not to use Postgres</h3>
          <ul className="pitfall-list">
            {antiPatterns.map((a, i) => (
              <li key={a.dont} className="pitfall" style={{ animationDelay: `${i * 70}ms` }}>
                <div className="pitfall-head"><b className="bad">✗ {a.dont}</b></div>
                <dl className="pitfall-grid">
                  {a.why && <><dt>Why not</dt><dd>{a.why}</dd></>}
                  {a.instead && <><dt className="ok">Instead</dt><dd>{a.instead}</dd></>}
                </dl>
              </li>
            ))}
          </ul>
        </section>
      )}

      {troubleshooting.length > 0 && (
        <section className="card">
          <h3>Common errors (setup, connection, configuration, versions)</h3>
          <ul className="pitfall-list">
            {troubleshooting.map((t, i) => <PitfallCard key={t.mistake} pitfall={t} index={i} />)}
          </ul>
        </section>
      )}

      {demoPitfalls.length > 0 && (
        <section className="card">
          <h3>Feature by feature</h3>
          <ul className="pitfall-list">
            {demoPitfalls.map(({ demo, pitfall }, i) => (
              <PitfallCard key={`${demo.id}-${pitfall.mistake}`} pitfall={pitfall} index={i}
                demoTitle={demo.title} onOpen={() => onOpen(demo.id)} />
            ))}
          </ul>
        </section>
      )}

      {!antiPatterns.length && !troubleshooting.length && !demoPitfalls.length && (
        <p className="muted">Nothing matches “{query}”.</p>
      )}
    </article>
  );
}
