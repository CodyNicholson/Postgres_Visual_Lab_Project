import React, { useState } from 'react';
import { Bar, Empty, Stat, formatNumber, useStepper } from '../components/common.jsx';
import { QueryGallery, VersusRow, queryByTitle, rowsOf } from './shared.jsx';

const money = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });

export function SelectVisual({ result }) {
  if (!result) return <Empty>Press “Run the queries” to run ten SELECTs against the sample shop. Each one appears below with its SQL, an explanation and its rows.</Empty>;
  const eq = rowsOf(queryByTitle(result, 'WRONG: = NULL'))[0]?.n;
  const is = rowsOf(queryByTitle(result, 'RIGHT: IS NULL'))[0]?.n;
  const byCountry = queryByTitle(result, 'WHERE with a bound parameter');
  const perCat = rowsOf(queryByTitle(result, 'DISTINCT ON'));
  return (
    <div>
      <div className="stat-row">
        <Stat label={`customers WHERE country = '${result.data.country}'`} value={byCountry?.rowCount ?? 0} tone="accent" />
        <Stat label="queries run" value={result.data.queries.length} />
      </div>
      <h4>The NULL trap</h4>
      <VersusRow
        wrong={<><code>WHERE referred_by = NULL</code><div className="big-number bad">{eq}</div><div className="muted">rows: never matches</div></>}
        right={<><code>WHERE referred_by IS NULL</code><div className="big-number ok">{is}</div><div className="muted">rows</div></>}
      />
      <h4>DISTINCT ON (category): the most expensive product per category</h4>
      <div className="tiles">
        {perCat.map((r, i) => (
          <div key={r.category} className="tile pop-in" style={{ animationDelay: `${i * 90}ms` }}>
            <code className="tile-key">{r.category}</code>
            <div className="tile-value">{r.name}</div>
            <div className="muted">{money(r.price)}</div>
          </div>
        ))}
      </div>
      <QueryGallery result={result} />
    </div>
  );
}

export function DmlVisual({ result }) {
  if (!result) return <Empty>Run it to INSERT, UPDATE and DELETE rows in a private inventory table and see what RETURNING hands back.</Empty>;
  if (result.data.mode === 'mistake') {
    const changed = queryByTitle(result, 'WRONG')?.rowCount;
    return (
      <div>
        <VersusRow
          wrong={<><code>UPDATE inventory SET price = 0.01</code><div className="big-number bad">{changed}</div><div className="muted">rows changed: all of them</div></>}
          right={<><code>ROLLBACK</code><div className="big-number ok">0</div><div className="muted">rows left at 0.01: the transaction saved us</div></>}
        />
        <QueryGallery result={result} />
      </div>
    );
  }
  const cuts = rowsOf(queryByTitle(result, 'UPDATE … RETURNING old/new'));
  const final = rowsOf(queryByTitle(result, 'Final table'));
  const max = Math.max(1, ...cuts.map((c) => Number(c.old_price)));
  return (
    <div>
      <h4>UPDATE … RETURNING old.price, new.price (Postgres 18)</h4>
      {cuts.map((c) => (
        <div key={c.sku} className="price-cut">
          <Bar label={c.sku} value={Number(c.old_price)} max={max} tone="warn" text={`was ${money(c.old_price)}`} />
          <Bar label="" value={Number(c.new_price)} max={max} tone="ok" text={`now ${money(c.new_price)}`} />
        </div>
      ))}
      <h4>Final inventory ({final.length} rows)</h4>
      <div className="chip-cloud">
        {final.map((r, i) => (
          <span key={r.sku} className={`chip pop-in ${r.stock > 50 ? 'chip-hit' : 'chip-soft'}`} style={{ animationDelay: `${i * 60}ms` }}>
            {r.sku} · stock {r.stock}
          </span>
        ))}
      </div>
      <QueryGallery result={result} />
    </div>
  );
}

export function UpsertVisual({ result }) {
  if (!result) return <Empty>Run it to upsert into a stock table and then MERGE a delivery file into it.</Empty>;
  if (result.data.mode === 'mistake') return <QueryGallery result={result} title="The upsert errors, for real" />;
  const before = [{ sku: 'apple', qty: 10 }, { sku: 'pear', qty: 5 }]; // what the demo inserts first
  const ups = rowsOf(queryByTitle(result, 'ON CONFLICT DO UPDATE'));
  const merged = rowsOf(queryByTitle(result, 'MERGE'));
  const after = rowsOf(queryByTitle(result, 'Stock after MERGE'));
  return (
    <div>
      <div className="flow-row">
        <div className="mini-table"><h4>Start</h4>{before.map((r) => <div key={r.sku} className="mini-row">{r.sku} <b>{r.qty}</b></div>)}</div>
        <div className="flow-arrow">→ upsert →</div>
        <div className="mini-table"><h4>ON CONFLICT DO UPDATE</h4>{ups.map((r, i) => (
          <div key={r.sku} className="mini-row pop-in" style={{ animationDelay: `${i * 150}ms` }}>{r.sku} <b>{r.qty}</b> <span className={`chip ${r.inserted ? 'chip-hit' : 'chip-miss'}`}>{r.inserted ? 'inserted' : 'updated'}</span></div>
        ))}</div>
        <div className="flow-arrow">→ MERGE →</div>
        <div className="mini-table"><h4>merge_action()</h4>{merged.map((r, i) => (
          <div key={r.sku} className="mini-row pop-in" style={{ animationDelay: `${300 + i * 150}ms` }}>{r.sku} <span className={`chip action-${r.action}`}>{r.action}</span></div>
        ))}</div>
        <div className="flow-arrow">→</div>
        <div className="mini-table"><h4>Final stock</h4>{after.map((r, i) => (
          <div key={r.sku} className="mini-row pop-in" style={{ animationDelay: `${600 + i * 120}ms` }}>{r.sku} <b>{r.qty}</b></div>
        ))}</div>
      </div>
      <QueryGallery result={result} />
    </div>
  );
}

function Venn({ left, right, both, mode, leftLabel, rightLabel }) {
  const keep = {
    INNER: { l: false, b: true, r: false },
    LEFT: { l: true, b: true, r: false },
    RIGHT: { l: false, b: true, r: true },
    FULL: { l: true, b: true, r: true },
  }[mode];
  return (
    <svg viewBox="0 0 360 200" className="venn" role="img" aria-label={`${mode} JOIN Venn diagram`}>
      <defs>
        <clipPath id="clip-left"><circle cx="140" cy="100" r="80" /></clipPath>
      </defs>
      <circle cx="140" cy="100" r="80" className={`venn-set ${keep.l ? 'venn-on' : ''}`} />
      <circle cx="220" cy="100" r="80" className={`venn-set ${keep.r ? 'venn-on' : ''}`} />
      <circle cx="220" cy="100" r="80" clipPath="url(#clip-left)" className={`venn-both ${keep.b ? 'venn-on' : ''}`} />
      <text x="105" y="105" className="venn-num">{left}</text>
      <text x="180" y="105" className="venn-num">{both}</text>
      <text x="255" y="105" className="venn-num">{right}</text>
      <text x="90" y="192" className="venn-label">{leftLabel}</text>
      <text x="215" y="192" className="venn-label">{rightLabel}</text>
    </svg>
  );
}

export function JoinsVisual({ result }) {
  const [mode, setMode] = useState('LEFT');
  if (!result) return <Empty>Run every join between 40 customers and a list of 8 country → region pairs, and see which rows each join keeps.</Empty>;
  const venn = result.data.venn;
  const c = venn[mode];
  const rows = c.both + (['LEFT', 'FULL'].includes(mode) ? c.leftOnly : 0) + (['RIGHT', 'FULL'].includes(mode) ? c.rightOnly : 0);
  return (
    <div>
      <div className="gallery-tabs">
        {['INNER', 'LEFT', 'RIGHT', 'FULL'].map((m) => (
          <button key={m} type="button" className={`gallery-tab ${mode === m ? 'gallery-tab-on' : ''}`} onClick={() => setMode(m)}>{m} JOIN</button>
        ))}
      </div>
      <div className="venn-wrap">
        <Venn key={mode} mode={mode} left={venn.FULL.leftOnly} both={venn.FULL.both} right={venn.FULL.rightOnly} leftLabel="customers" rightLabel="regions" />
        <div>
          <div className="big-number">{rows}</div>
          <div className="muted">rows returned by {mode} JOIN</div>
          <ul className="legend-list">
            <li><b>{venn.FULL.both}</b> customers whose country is in the region list</li>
            <li><b>{venn.FULL.leftOnly}</b> customers from countries not in the list (AT, CH, DE, HU, NO…)</li>
            <li><b>{venn.FULL.rightOnly}</b> regions with no customers (BR, IN)</li>
          </ul>
        </div>
      </div>
      <QueryGallery result={result} filter={(q) => !q.title.endsWith('JOIN') || q.title.startsWith(mode) || q.title.startsWith('CROSS')} />
    </div>
  );
}

export function AggregatesVisual({ result }) {
  if (!result) return <Empty>Run the GROUP BY queries: revenue per category, HAVING, FILTER, ROLLUP and more.</Empty>;
  const cats = rowsOf(queryByTitle(result, 'GROUP BY with'));
  const filter = rowsOf(queryByTitle(result, 'FILTER'))[0] || {};
  const having = queryByTitle(result, 'HAVING');
  const max = Math.max(1, ...cats.map((c) => Number(c.revenue)));
  return (
    <div>
      <h4>sum(qty × unit_price) GROUP BY category</h4>
      {cats.map((c) => <Bar key={c.category} label={c.category} value={Number(c.revenue)} max={max} text={money(c.revenue)} />)}
      <h4>count(*) FILTER (WHERE status = …): one pass, several counts</h4>
      <div className="stat-row">
        {['paid', 'shipped', 'cancelled', 'distinct_customers'].map((k, i) => (
          <Stat key={k} label={k.replace('_', ' ')} value={formatNumber(filter[k])} tone={['ok', 'accent', 'bad', 'store'][i]} />
        ))}
      </div>
      <div className="stat-row">
        <Stat label={`customers with revenue ≥ ${result.data.minRevenue} (HAVING)`} value={having?.rowCount ?? 0} tone="warn" />
      </div>
      <QueryGallery result={result} />
    </div>
  );
}

export function SubqueriesVisual({ result }) {
  const [op, setOp] = useState('INTERSECT');
  if (!result) return <Empty>Run the subqueries and the four set operations on “countries that bought Books” vs “countries that bought Garden items”.</Empty>;
  const s = result.data.sets;
  const books = new Set(s.books);
  const garden = new Set(s.garden);
  const all = [...new Set([...s.books, ...s.garden])].sort();
  const inResult = new Set(s[op]);
  const zone = (c) => (books.has(c) && garden.has(c) ? 'both' : books.has(c) ? 'left' : 'right');
  return (
    <div>
      <div className="gallery-tabs">
        {['UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT'].map((o) => (
          <button key={o} type="button" className={`gallery-tab ${op === o ? 'gallery-tab-on' : ''}`} onClick={() => setOp(o)}>{o}</button>
        ))}
      </div>
      <div className="set-zones">
        {['left', 'both', 'right'].map((z) => (
          <div key={z} className={`set-zone set-${z}`}>
            <div className="muted">{z === 'left' ? 'Books only' : z === 'both' ? 'Both' : 'Garden only'}</div>
            {all.filter((c) => zone(c) === z).map((c) => (
              <span key={`${op}-${c}`} className={`chip pop-in ${inResult.has(c) ? 'chip-hit' : 'chip-off'}`}>{c}</span>
            ))}
          </div>
        ))}
      </div>
      <p className="muted">{op} returned <b>{s[op].length}</b> rows{op === 'UNION ALL' ? ' (duplicates kept: countries in both sets appear twice)' : ''}.</p>
      <QueryGallery result={result} />
    </div>
  );
}

export function CtesVisual({ result }) {
  const tree = result?.data?.tree || [];
  const maxDepth = Math.max(0, ...tree.map((t) => t.depth));
  const level = useStepper(maxDepth, result?.receivedAt, 600);
  if (!result) return <Empty>Run WITH RECURSIVE to build the org chart level by level.</Empty>;
  return (
    <div>
      <h4>WITH RECURSIVE: level {Math.min(level, maxDepth)} of {maxDepth}</h4>
      <div className="org">
        {tree.filter((t) => t.depth <= Math.max(level, 1)).map((t) => (
          <div key={t.id} className="org-node pop-in" style={{ marginLeft: `${(t.depth - 1) * 26}px` }}>
            <span className="org-depth">L{t.depth}</span>
            <b>{t.name}</b> <span className="muted">{t.title}</span>
          </div>
        ))}
      </div>
      <QueryGallery result={result} />
    </div>
  );
}

export function WindowsVisual({ result }) {
  if (!result) return <Empty>Run the window functions to chart monthly revenue with a running total and a moving average.</Empty>;
  const rows = rowsOf(queryByTitle(result, 'Running total'));
  const W = 640, H = 230, pad = 40;
  const maxRun = Math.max(1, ...rows.map((r) => Number(r.running_total)));
  const maxRev = Math.max(1, ...rows.map((r) => Number(r.revenue)));
  const x = (i) => pad + (i + 0.5) * ((W - pad * 2) / rows.length);
  const bw = ((W - pad * 2) / rows.length) * 0.55;
  const yRev = (v) => H - 30 - (v / maxRev) * (H - 60) * 0.55;
  const yRun = (v) => H - 30 - (v / maxRun) * (H - 60);
  const line = (fn, key) => rows.map((r, i) => `${i ? 'L' : 'M'} ${x(i)} ${fn(Number(r[key]))}`).join(' ');
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Monthly revenue with running total">
        <line x1={pad} x2={W - pad} y1={H - 30} y2={H - 30} className="grid-line" />
        {rows.map((r, i) => (
          <g key={r.month}>
            <rect x={x(i) - bw / 2} width={bw} y={yRev(Number(r.revenue))} height={H - 30 - yRev(Number(r.revenue))} className="chart-bar rise" style={{ animationDelay: `${i * 80}ms` }} />
            <text x={x(i)} y={H - 12} className="axis-text" textAnchor="middle">{r.month.slice(5, 7)}/{r.month.slice(2, 4)}</text>
          </g>
        ))}
        <path d={line(yRun, 'running_total')} className="chart-line draw-line" pathLength="1" />
        <path d={line(yRev, 'moving_avg_3m')} className="chart-line2 draw-line" pathLength="1" />
        {rows.map((r, i) => <circle key={i} cx={x(i)} cy={yRun(Number(r.running_total))} r="3.5" className="chart-dot" />)}
      </svg>
      <div className="legend">
        <span><span className="swatch" style={{ background: 'var(--accent)' }} />monthly revenue (bars)</span>
        <span><span className="swatch" style={{ background: 'var(--ok)' }} />sum() OVER (ORDER BY month): running total</span>
        <span><span className="swatch" style={{ background: 'var(--warn)' }} />avg() OVER (ROWS BETWEEN 2 PRECEDING …)</span>
      </div>
      <QueryGallery result={result} />
    </div>
  );
}
