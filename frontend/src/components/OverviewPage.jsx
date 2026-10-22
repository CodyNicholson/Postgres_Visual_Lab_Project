import React from 'react';
import Terminal from './Terminal.jsx';
import CodeBlock from './CodeBlock.jsx';
import { OVERVIEW } from '../demos/guide.js';
import { CATEGORIES, DEMOS } from '../demos/catalog.js';

function List({ title, items, tone }) {
  if (!items?.length) return null;
  return (
    <section className={`card list-card list-${tone}`}>
      <h3>{title}</h3>
      <ul>
        {items.map((item, i) => <li key={i} style={{ animationDelay: `${i * 70}ms` }}>{item}</li>)}
      </ul>
    </section>
  );
}

/** Landing page: what the tool is, how to start a project, pros and cons, how not to use it, and a map of every demo. */
export default function OverviewPage({ onOpen }) {
  return (
    <article className="demo">
      <header className="demo-head">
        <span className="chip">Start here</span>
        <h2>{OVERVIEW.title}</h2>
        <p className="tagline">{OVERVIEW.intro}</p>
      </header>

      {OVERVIEW.facts?.length > 0 && (
        <div className="stat-row">
          {OVERVIEW.facts.map(([label, value]) => (
            <div key={label} className="stat"><div className="stat-value stat-text">{value}</div><div className="stat-label">{label}</div></div>
          ))}
        </div>
      )}

      <section className="card">
        <h3>Create a project</h3>
        <ol className="guide-steps">
          {OVERVIEW.steps.map((step, i) => (
            <li key={step.title} style={{ animationDelay: `${i * 90}ms` }}>
              <h4>{i + 1}. {step.title}</h4>
              <p>{step.text}</p>
              {step.commands && <Terminal commands={step.commands} />}
              {step.file && <CodeBlock code={step.file.code} name={step.file.name} lang={step.file.lang} />}
            </li>
          ))}
        </ol>
      </section>

      {OVERVIEW.cheatsheet?.length > 0 && (
        <section className="card">
          <h3>Every kind of query, at a glance</h3>
          <p className="muted">Each row links to the demo that runs it against the real database, with the SQL, an explanation and the rows it returned.</p>
          <div className="table-wrap">
            <table className="cheatsheet">
              <thead><tr><th>Task</th><th>SQL</th><th>Demo</th></tr></thead>
              <tbody>
                {OVERVIEW.cheatsheet.map(([task, sql, id], i) => (
                  <tr key={`${task}-${i}`} className="row-in" style={{ animationDelay: `${Math.min(i, 20) * 30}ms` }}>
                    <td>{task}</td>
                    <td><code>{sql}</code></td>
                    <td><button type="button" className="link" onClick={() => onOpen(id)}>{DEMOS.find((d) => d.id === id)?.title || id} →</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="two-col">
        <List title="Pros" items={OVERVIEW.pros} tone="ok" />
        <List title="Cons" items={OVERVIEW.cons} tone="bad" />
        <List title="Use it when" items={OVERVIEW.whenToUse} tone="ok" />
        <List title="Pick something else when" items={OVERVIEW.whenNotToUse} tone="warn" />
      </div>

      {OVERVIEW.antiPatterns?.length > 0 && (
        <section className="card list-card list-bad">
          <div className="card-title-row">
            <h3>How not to use Postgres</h3>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => onOpen('pitfalls')}>All mistakes & fixes →</button>
          </div>
          <ul>
            {OVERVIEW.antiPatterns.map((a, i) => (
              <li key={a.dont} style={{ animationDelay: `${i * 70}ms` }}><b>{a.dont}</b>{a.instead && <span className="muted"> Instead: {a.instead}</span>}</li>
            ))}
          </ul>
        </section>
      )}

      {OVERVIEW.alternatives?.length > 0 && (
        <section className="card">
          <h3>Alternatives</h3>
          <table>
            <tbody>
              {OVERVIEW.alternatives.map(([name, diff]) => <tr key={name}><td><b>{name}</b></td><td>{diff}</td></tr>)}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h3>Every feature in this lab</h3>
        <div className="feature-map">
          {CATEGORIES.map((category) => (
            <div key={category} className="feature-group">
              <h4>{category}</h4>
              {DEMOS.filter((d) => d.category === category).map((d) => (
                <button key={d.id} type="button" className="feature-link" onClick={() => onOpen(d.id)}>
                  <b>{d.title}</b><span className="muted">{d.tagline}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </section>
    </article>
  );
}
