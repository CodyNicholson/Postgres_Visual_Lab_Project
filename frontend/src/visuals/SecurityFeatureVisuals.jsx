import React from 'react';
import { Bar, Empty, Stat, formatMs } from '../components/common.jsx';
import { QueryGallery, ResultTable, Sql, VersusRow, queryByTitle, rowsOf } from './shared.jsx';

// ---- Security ---------------------------------------------------------------------------

export function RolesVisual({ result }) {
  if (!result) return <Empty>Try every privilege: each cell runs a real statement after SET ROLE.</Empty>;
  const m = result.data.matrix;
  return (
    <div>
      <div className="table-wrap">
        <table className="matrix">
          <thead><tr><th>Role</th><th>Action</th><th>Result</th></tr></thead>
          <tbody>
            {m.map((c, i) => (
              <tr key={i} className="row-in" style={{ animationDelay: `${i * 70}ms` }}>
                <td><code>{c.role}</code></td>
                <td>{c.action}<div className="muted mono">{c.sql}</div></td>
                <td className={c.allowed ? 'ok' : 'bad'}>{c.allowed ? '✓ allowed' : <>✗ <span className="mono small">{(c.error || '').replace('ERROR:  ', '')}</span></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <QueryGallery result={result} />
    </div>
  );
}

const TENANT_COLORS = { 1: 'var(--session)', 2: 'var(--session2)', 3: 'var(--planner)' };

export function RlsVisual({ result }) {
  if (!result) return <Empty>Pick a tenant and query as the application role: the policy filters the rows, no WHERE needed.</Empty>;
  const visible = new Set(result.data.visible);
  const owner = rowsOf(queryByTitle(result, 'WRONG: the app connects as the table owner'))[0];
  return (
    <div>
      <h4>invoices as seen by tenant {result.data.tenant} (faded rows are filtered out by the policy)</h4>
      <div className="rls-rows">
        {result.data.rows.map((r, i) => (
          <div key={r.id} className={`rls-row pop-in ${visible.has(r.id) ? 'rls-visible' : 'rls-hidden'}`}
            style={{ borderLeftColor: TENANT_COLORS[r.tenant_id], animationDelay: `${i * 70}ms` }}>
            <span>#{r.id}</span><span>tenant {r.tenant_id}</span><span>{r.customer}</span><span>{Number(r.amount)}</span>
            <span>{visible.has(r.id) ? '👁' : '🔒'}</span>
          </div>
        ))}
      </div>
      {owner && (
        <VersusRow
          wrong={<><b>As the table owner</b><div className="big-number bad">{owner.n}</div><div className="muted">rows: policies bypassed</div></>}
          right={<><b>FORCE ROW LEVEL SECURITY</b><div className="big-number ok">{rowsOf(queryByTitle(result, 'The owner is now filtered'))[0]?.n}</div><div className="muted">rows</div></>}
        />
      )}
      <QueryGallery result={result} />
    </div>
  );
}

export function InjectionVisual({ result }) {
  if (!result) return <Empty>Send a prepared payload both ways and compare what reaches the database.</Empty>;
  const d = result.data;
  const toTable = (rows) => ({ columns: ['owner', 'body'], rows: rows.map((r) => [r.owner, r.body]) });
  const unsafe = toTable(d.unsafe);
  const safe = toTable(d.safe);
  return (
    <div>
      <p className="muted">Payload: <code>{d.payload}</code></p>
      <VersusRow
        wrong={<><b>String concatenation</b><Sql sql={d.unsafeSql} /><div className={d.unsafe.length > 1 ? 'bad' : 'muted'}>{d.unsafe.length} rows returned</div><ResultTable {...unsafe} /></>}
        right={<><b>Bound parameter</b><Sql sql={'SELECT owner, body FROM notes WHERE owner = $1'} /><div className="muted">$1 = <code>{JSON.stringify(d.payload)}</code></div><div className="ok">{d.safe.length} rows returned</div><ResultTable {...safe} /></>}
      />
      <QueryGallery result={result} />
    </div>
  );
}

// ---- Features & extensions ----------------------------------------------------------------

export function NotifyVisual({ result }) {
  if (!result) return <Empty>Publish & listen: watch when notifications are (and aren’t) delivered.</Empty>;
  const d = result.data;
  return (
    <div>
      <div className="stat-row">
        <Stat label="notifications received" value={d.received.length} tone="accent" />
        <Stat label="delivered after COMMIT" value={d.latencyMs != null ? `${d.latencyMs} ms` : '–'} tone="ok" />
        <Stat label="channel" value={d.channel} />
      </div>
      <div className="msg-lanes">
        <div className="msg-head">sender</div><div className="msg-head">listener</div>
        {d.timeline.map((e, i) => (
          <div key={i} className={`msg pop-in ${e.who === 'listener' ? 'msg-right' : 'msg-left'} ${/received/.test(e.what) ? 'msg-received' : ''}`}
            style={{ animationDelay: `${i * 110}ms`, gridColumn: e.who === 'listener' ? 2 : 1 }}>
            <span className="msg-at">{e.at} ms</span> <code>{e.what}</code>
          </div>
        ))}
      </div>
      <QueryGallery result={result} />
    </div>
  );
}

export function CopyVisual({ result }) {
  if (!result) return <Empty>Race the load methods: the same rows, five ways.</Empty>;
  const rs = result.data.results;
  const max = Math.max(...rs.map((r) => r.rowsPerSec));
  const logw = (v) => (Math.log10(Math.max(v, 1)) / Math.log10(max)) * max;
  return (
    <div>
      <h4>Rows per second (log scale)</h4>
      {rs.map((r, i) => (
        <div key={r.method} className="copy-row">
          <Bar label={`${r.method} (${r.rows.toLocaleString()} rows, ${formatMs(r.ms)})`} value={logw(r.rowsPerSec)} max={max}
            tone={i === rs.length - 1 ? 'ok' : i === 0 ? 'bad' : 'accent'} text={`${r.rowsPerSec.toLocaleString()}/s`} />
          <div className="muted copy-note">{r.note}</div>
        </div>
      ))}
      <h4>COPY (…) TO STDOUT WITH (FORMAT csv, HEADER)</h4>
      <pre className="terminal">{result.data.csv}</pre>
      <QueryGallery result={result} />
    </div>
  );
}

export function TrigramVisual({ result }) {
  if (!result) return <Empty>Search with typos: trigram similarity still finds the right product.</Empty>;
  const d = result.data;
  const trgm = rowsOf(queryByTitle(result, 'show_trgm'))[0]?.trigrams || [];
  return (
    <div>
      <h4>show_trgm('keyboard')</h4>
      <div className="chip-cloud">{trgm.map((t, i) => <span key={t} className="chip pop-in" style={{ animationDelay: `${i * 40}ms` }}>{t}</span>)}</div>
      <h4>“{d.q}”: ranked by word_similarity · ILIKE found {d.ilike}</h4>
      {d.hits.map((h) => <Bar key={h.name} label={h.name} value={Number(h.word_similarity)} max={1} tone={Number(h.word_similarity) > 0.3 ? 'ok' : 'accent'} text={Number(h.word_similarity).toFixed(3)} />)}
      <h4>LIKE '%c4ca42%' over 50,000 codes ({d.matches} match)</h4>
      <Bar label="no index (Seq Scan)" value={d.beforeMs} max={Math.max(d.beforeMs, d.afterMs)} tone="bad" text={formatMs(d.beforeMs)} />
      <Bar label="GIN gin_trgm_ops" value={d.afterMs} max={Math.max(d.beforeMs, d.afterMs)} tone="ok" text={formatMs(d.afterMs)} />
      <QueryGallery result={result} />
    </div>
  );
}

export function VectorVisual({ result }) {
  if (!result) return <Empty>Describe a craving with the sliders and find the nearest foods.</Empty>;
  const d = result.data;
  const W = 420, H = 300, pad = 34;
  const x = (v) => pad + v[0] * (W - pad * 2);
  const y = (v) => H - pad - v[1] * (H - pad * 2);
  const near = new Map(d.nearest.map((n, i) => [n.name, i]));
  return (
    <div className="vector-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="scatter" role="img" aria-label="Foods by sweet and savory">
        <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} className="grid-line" />
        <line x1={pad} y1={pad} x2={pad} y2={H - pad} className="grid-line" />
        <text x={W / 2} y={H - 8} textAnchor="middle" className="axis-text">sweet →</text>
        <text x={12} y={H / 2} textAnchor="middle" className="axis-text" transform={`rotate(-90 12 ${H / 2})`}>savory →</text>
        {d.nearest.map((n, i) => (
          <line key={n.name} x1={x(d.query)} y1={y(d.query)} x2={x(n.v)} y2={y(n.v)} className="nn-line draw-line" pathLength="1" style={{ animationDelay: `${i * 150}ms` }} />
        ))}
        {d.foods.map((f) => (
          <g key={f.name} className={near.has(f.name) ? 'food-near' : 'food'}>
            <circle cx={x(f.v)} cy={y(f.v)} r={4 + f.v[2] * 7} />
            <text x={x(f.v) + 9} y={y(f.v) + 4} className="food-label">{f.name}</text>
          </g>
        ))}
        <circle cx={x(d.query)} cy={y(d.query)} r={7 + d.query[2] * 6} className="query-point pop-in" />
      </svg>
      <ol className="hits">
        {d.nearest.map((n, i) => (
          <li key={n.name} className="hit pop-in" style={{ animationDelay: `${i * 120}ms` }}>
            <div className="hit-head"><b>{i + 1}. {n.name}</b><span className="pill">{d.metric === 'l2' ? '<->' : '<=>'} {n.distance.toFixed(3)}</span></div>
            <code className="muted">[{n.v.join(', ')}]</code>
          </li>
        ))}
      </ol>
      <div className="vector-gallery"><QueryGallery result={result} /></div>
    </div>
  );
}
