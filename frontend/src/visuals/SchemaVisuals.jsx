import React from 'react';
import { Bar, Empty, Stat, useStepper } from '../components/common.jsx';
import { QueryGallery, queryByTitle, rowsOf } from './shared.jsx';

const CONSTRAINTS = [
  ['pk', 'PRIMARY KEY', 'INSERT INTO authors VALUES (1, …)'],
  ['unique', 'UNIQUE', "INSERT … 'ada@x.io' again"],
  ['notnull', 'NOT NULL', 'INSERT … title = NULL'],
  ['check', 'CHECK (pages > 0)', 'INSERT … pages = 0'],
  ['fk', 'FOREIGN KEY', 'INSERT … author_id = 99'],
];

export function ConstraintsVisual({ result }) {
  const shown = useStepper(CONSTRAINTS.length, result?.receivedAt, 380);
  if (!result) return <Empty>Press “Try every violation”: one bad INSERT per constraint, each rejected by Postgres with its real error.</Empty>;
  const results = result.data.results || {};
  return (
    <div>
      <div className="constraint-grid">
        {CONSTRAINTS.slice(0, shown).map(([key, name, attempt]) => (
          <div key={key} className="constraint-card pop-in">
            <div className="constraint-head"><span className="shield">⛔</span><b>{name}</b></div>
            <code className="muted">{attempt}</code>
            <pre className="pitfall-symptom">{results[key]}</pre>
          </div>
        ))}
      </div>
      <QueryGallery result={result} />
    </div>
  );
}

export function ViewsVisual({ result }) {
  const step = useStepper(3, result?.receivedAt, 900);
  if (!result) return <Empty>Run it: a sale of 5,000 arrives; the view sees it at once, the materialized view only after REFRESH.</Empty>;
  const t = result.data.totals;
  const stages = [
    { label: 'Before the sale', table: t.before.table, view: t.before.view, mat: t.before.matview },
    { label: 'After INSERT (+5,000)', table: t.after.table, view: t.after.view, mat: t.after.matview },
    { label: 'After REFRESH … CONCURRENTLY', table: t.after.table, view: t.after.view, mat: t.refreshed },
  ];
  const s = stages[Math.min(step, 2)];
  const fmt = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const stale = Number(s.mat) !== Number(s.table);
  return (
    <div>
      <div className="stage-steps">
        {stages.map((st, i) => <span key={st.label} className={`chip ${i === Math.min(step, 2) ? '' : 'chip-soft'}`}>{i + 1}. {st.label}</span>)}
      </div>
      <div className="stat-row">
        <Stat label="sales table: sum(amount)" value={fmt(s.table)} tone="store" />
        <Stat label="VIEW revenue_by_status" value={fmt(s.view)} tone="ok" hint="re-runs the query each time" />
        <Stat label="MATERIALIZED VIEW" value={fmt(s.mat)} tone={stale ? 'bad' : 'ok'} hint={stale ? 'stale: stored result' : 'refreshed'} />
      </div>
      <QueryGallery result={result} />
    </div>
  );
}

export function FunctionsVisual({ result }) {
  if (!result) return <Empty>Run the functions: SQL, PL/pgSQL with RAISE NOTICE, a set-returning function and a procedure that commits.</Empty>;
  const top = result.data.top || [];
  const max = Math.max(1, ...top.map((t) => Number(t.revenue)));
  return (
    <div>
      <div className="stat-row">
        <Stat label={`fib(${result.data.n})`} value={String(result.data.fib)} tone="accent" />
        <Stat label="NOTICE messages" value={result.data.notices.length} />
      </div>
      <h4>Messages the server sent during the calls (RAISE NOTICE)</h4>
      <pre className="terminal">
        {result.data.notices.map((n, i) => (
          <div key={i} className="terminal-line" style={{ animationDelay: `${i * 120}ms` }}><span className="prompt">NOTICE</span> {n}</div>
        ))}
      </pre>
      <h4>SELECT * FROM top_customers(3)</h4>
      {top.map((t) => <Bar key={t.name} label={t.name} value={Number(t.revenue)} max={max} text={Number(t.revenue).toLocaleString()} />)}
      <QueryGallery result={result} />
    </div>
  );
}

export function TriggersVisual({ result }) {
  const log = rowsOf(queryByTitle(result, 'The audit log'));
  const shown = useStepper(log.length, result?.receivedAt, 350);
  if (!result) return <Empty>Run it: every INSERT, UPDATE and DELETE on accounts writes an audit row through a trigger.</Empty>;
  const blocked = queryByTitle(result, 'UPDATE that would overdraw');
  return (
    <div>
      <h4>audit_log, written by the AFTER trigger</h4>
      <div className="feed">
        {log.slice(0, shown).map((r) => (
          <div key={r.id} className={`feed-row pop-in op-${r.op}`}>
            <span className={`chip action-${r.op}`}>{r.op}</span>
            <span>account {r.row_id}</span>
            <span className="muted">balance {r.old_balance ?? '∅'} → {r.new_balance ?? '∅'}</span>
          </div>
        ))}
      </div>
      {blocked?.error && <><h4>BEFORE trigger rejected:</h4><pre className="pitfall-symptom">{blocked.error}</pre></>}
      <div className="muted">Statement trigger: {(result.data.notices || []).join(' · ')}</div>
      <QueryGallery result={result} />
    </div>
  );
}

export function PartitioningVisual({ result }) {
  if (!result) return <Empty>Run it to route 50,000 rows into monthly partitions and watch the planner prune them.</Empty>;
  const parts = result.data.partitions || [];
  const scanned = new Set(result.data.scanned || []);
  const max = Math.max(1, ...parts.map((p) => p.rows));
  return (
    <div>
      <h4>Rows per partition · <span className="ok">scanned</span> by WHERE created_at in March · <span className="muted">pruned</span></h4>
      <div className="buckets">
        {parts.map((p, i) => {
          const name = String(p.partition);
          const short = name.replace(/^.*measurements_/, '').replace('2026_', '');
          const dropped = short === '01';
          return (
            <div key={name} className={`bucket ${scanned.has(name.replace(/^.*\./, '')) ? 'bucket-scan' : 'bucket-pruned'} ${dropped ? 'bucket-dropped' : ''}`}>
              <div className="bucket-fill rise" style={{ height: `${Math.max(4, (p.rows / max) * 100)}%`, animationDelay: `${i * 70}ms` }} />
              <div className="bucket-label">{short === 'default' ? 'DEFAULT' : `month ${short}`}</div>
              <div className="bucket-count">{p.rows.toLocaleString()}</div>
              {dropped && <div className="bucket-x" title="DETACH + DROP">dropped</div>}
            </div>
          );
        })}
      </div>
      <pre className="plan-mini">{result.data.plan}</pre>
      <QueryGallery result={result} />
    </div>
  );
}
