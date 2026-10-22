import React from 'react';
import { Bar, Empty, Stat, formatBytes, formatMs, useStepper } from '../components/common.jsx';
import { Gantt, QueryGallery, ResultTable, VersusRow, Sql } from './shared.jsx';

// ---- Operations ---------------------------------------------------------------------------

const pidColor = (pid) => `hsl(${(pid * 47) % 360} 70% 60%)`;

export function PoolingVisual({ result }) {
  if (!result) return <Empty>Open fresh connections, then borrow from the pool, and compare.</Empty>;
  const d = result.data;
  const avg = (xs) => xs.reduce((s, x) => s + x.connectMs, 0) / xs.length;
  return (
    <div>
      <div className="stat-row">
        <Stat label="avg connect (fresh)" value={formatMs(avg(d.fresh))} tone="bad" />
        <Stat label="avg borrow (pool)" value={formatMs(avg(d.pooled))} tone="ok" />
        <Stat label="max_connections" value={d.limits.max_connections} />
        <Stat label="client backends now" value={d.limits.client_backends} />
      </div>
      <h4>Server process (PID) behind each request: one colour per process</h4>
      <div className="pid-row"><span className="muted">fresh</span>{d.fresh.map((f, i) => <span key={i} className="pid pop-in" title={`pid ${f.pid}, ${f.connectMs} ms`} style={{ background: pidColor(f.pid), animationDelay: `${i * 40}ms` }} />)}</div>
      <div className="pid-row"><span className="muted">pooled</span>{d.pooled.map((f, i) => <span key={i} className="pid pop-in" title={`pid ${f.pid}, ${f.connectMs} ms`} style={{ background: pidColor(f.pid), animationDelay: `${300 + i * 40}ms` }} />)}</div>
      {d.limitError && <><h4>Connection 3 with CONNECTION LIMIT 2:</h4><pre className="pitfall-symptom">{d.limitError}</pre></>}
      <QueryGallery result={result} />
    </div>
  );
}

export function MonitoringVisual({ result }) {
  if (!result) return <Empty>Find a slow query, cancel it, and trace who blocks whom.</Empty>;
  const d = result.data;
  const holder = d.blocking.find((r) => r.application_name.endsWith('holder'));
  const waiter = d.blocking.find((r) => r.application_name.endsWith('waiter'));
  const maxSize = Math.max(1, ...d.sizes.map((s) => s.total_bytes));
  return (
    <div>
      <div className="stat-row">
        <Stat label="database size" value={d.health.database_size} tone="store" />
        <Stat label="cache hit ratio" value={`${d.health.cache_hit_pct}%`} tone="ok" />
        <Stat label="deadlocks so far" value={d.health.deadlocks} tone="warn" />
        <Stat label="B waited for A" value={formatMs(d.waitedMs)} tone="bad" />
      </div>
      {holder && waiter && (
        <div className="block-chain">
          <div className="block-node block-holder pop-in"><b>A · pid {holder.pid}</b><div>{holder.state}</div><code>{holder.query}</code></div>
          <div className="block-arrow">◀ blocks ◀</div>
          <div className="block-node block-waiter pop-in"><b>B · pid {waiter.pid}</b><div>waiting: {waiter.wait_event_type} / {waiter.wait_event}</div><div>blocked_by = {JSON.stringify(waiter.blocked_by)}</div><code>{waiter.query}</code></div>
        </div>
      )}
      <h4>Biggest tables (heap + indexes)</h4>
      {d.sizes.map((s) => <Bar key={s.table} label={s.table} value={s.total_bytes} max={maxSize} tone="store" text={formatBytes(s.total_bytes)} />)}
      <QueryGallery result={result} />
    </div>
  );
}

export function MigrationsVisual({ result }) {
  if (!result) return <Empty>Run the migration with and without lock_timeout and watch the lock queue.</Empty>;
  const d = result.data;
  const total = Math.max(...d.lanes.map((l) => l.end || 0), 1);
  const items = d.lanes.map((l) => ({ lane: l.who, start: l.start, end: l.end || total, label: l.state, tone: l.error ? 'bad' : l.who.startsWith('C') ? 'wait' : 'accent' }));
  return (
    <div>
      <p className="muted">lock_timeout = <code>{d.lockTimeout}</code></p>
      <Gantt lanes={['A report', 'B migration', 'C app']} items={items} total={total} />
      <h4>pg_locks while B waited</h4>
      <ResultTable columns={['application', 'mode', 'granted', 'blocked_by']} rows={d.queue.map((q) => [q.application_name, q.mode, q.granted, JSON.stringify(q.blocked_by)])} />
      <h4>Rewrite or not? pg_relation_filenode</h4>
      <div className="stat-row">
        <Stat label="before" value={d.filenodes[0]} />
        <Stat label="ADD COLUMN DEFAULT 'free'" value={d.filenodes[1]} tone="ok" hint="same file: instant" />
        <Stat label="ADD COLUMN DEFAULT random()" value={d.filenodes[2]} tone="bad" hint="new file: rewritten" />
      </div>
      <QueryGallery result={result} />
    </div>
  );
}

export function BackupVisual({ result }) {
  const step = useStepper(4, result?.receivedAt, 700);
  if (!result) return <Empty>Dump a schema with pg_dump, destroy it, and bring it back with pg_restore.</Empty>;
  const d = result.data;
  const stages = [
    ['pg_dump (plain)', formatBytes(d.sqlBytes)],
    ['pg_dump -Fc', formatBytes(d.dumpBytes)],
    ['DROP SCHEMA … CASCADE', 'gone'],
    ['pg_restore', `${d.after.customers} + ${d.after.orders} rows`],
  ];
  return (
    <div>
      <div className="pipeline">
        {stages.map(([name, value], i) => (
          <div key={name} className={`pipe-stage ${i < step ? 'pipe-done' : ''} ${i === 2 ? 'pipe-danger' : ''}`}>
            <b>{name}</b><span>{i < step ? value : '…'}</span>
          </div>
        ))}
      </div>
      <p className="muted">{d.version}</p>
      <div className="two-col">
        <div><h4>What the plain dump contains</h4><pre className="terminal">{d.excerpt.join('\n')}</pre></div>
        <div><h4>pg_restore --list (custom format)</h4><pre className="terminal">{d.toc.join('\n')}</pre></div>
      </div>
      {d.restoreError && <><h4>pg_restore on the plain dump:</h4><pre className="pitfall-symptom">{d.restoreError}</pre></>}
      <QueryGallery result={result} />
    </div>
  );
}

export function ReplicationVisual({ result }) {
  if (!result) return <Empty>Write heartbeats on the primary and watch them arrive on the replica.</Empty>;
  const d = result.data;
  const max = Math.max(...d.lags.map((l) => l.lagMs), 1);
  return (
    <div>
      <div className="repl">
        <div className="db-cyl"><b>primary</b><span>read-write</span></div>
        <div className="repl-wire">
          {d.lags.map((l, i) => <span key={i} className="wal-packet" style={{ animationDelay: `${i * 0.35}s` }}>WAL</span>)}
        </div>
        <div className="db-cyl db-replica"><b>replica</b><span>hot standby · read-only</span></div>
      </div>
      {d.stat && (
        <div className="stat-row">
          <Stat label="state" value={d.stat.state} tone="ok" />
          <Stat label="sync_state" value={d.stat.sync_state} />
          <Stat label="replay gap" value={`${d.stat.replay_gap_bytes} B`} />
          <Stat label="replay_lag" value={d.stat.replay_lag || '0'} />
        </div>
      )}
      <h4>Time until each heartbeat was readable on the replica</h4>
      {d.lags.map((l) => <Bar key={l.id} label={`heartbeat ${l.id}`} value={l.lagMs} max={max} tone="accent" text={formatMs(l.lagMs)} />)}
      <p className="muted">Read immediately after the first write, the replica {d.immediateRead ? 'already had' : 'did not have'} the row yet: replication is asynchronous.</p>
      <QueryGallery result={result} />
    </div>
  );
}

// ---- Common mistakes ------------------------------------------------------------------------

export function NPlusOneVisual({ result }) {
  if (!result) return <Empty>Compare N+1 queries with a batched query and a single JOIN.</Empty>;
  const rs = result.data.results;
  const max = Math.max(...rs.map((r) => r.ms));
  return (
    <div>
      {rs.map((r, i) => (
        <div key={r.method} className="nplus pop-in" style={{ animationDelay: `${i * 150}ms` }}>
          <div className="nplus-head"><b>{r.method}</b><span className="pill">{r.queries} queries</span></div>
          <div className="dots">{Array.from({ length: Math.min(r.queries, 151) }, (_, j) => <span key={j} className={`dot ${i === 0 ? 'dot-bad' : 'dot-ok'}`} style={{ animationDelay: `${j * 8}ms` }} />)}</div>
          <Bar label="total time" value={r.ms} max={max} tone={i === 0 ? 'bad' : 'ok'} text={formatMs(r.ms)} />
        </div>
      ))}
      <QueryGallery result={result} />
    </div>
  );
}

export function NotInVisual({ result }) {
  if (!result) return <Empty>Ask “who never referred anyone?” with NOT IN and with NOT EXISTS.</Empty>;
  const d = result.data;
  return (
    <div>
      <VersusRow
        wrong={<><code>id NOT IN (SELECT referred_by …)</code><div className="big-number bad">{d.wrong}</div><div className="muted">rows, because the subquery returned {d.nulls} NULLs</div></>}
        right={<><code>NOT EXISTS (SELECT 1 … WHERE r.referred_by = c.id)</code><div className="big-number ok">{d.right}</div><div className="muted">customers</div></>}
      />
      <div className="logic">
        <code>7 NOT IN (5, NULL)</code> = <code>7 &lt;&gt; 5 AND 7 &lt;&gt; NULL</code> = <code>true AND unknown</code> = <b className="warn-text">unknown</b> → row dropped
      </div>
      <QueryGallery result={result} />
    </div>
  );
}

export function PaginationVisual({ result }) {
  if (!result) return <Empty>Page deeper and deeper with OFFSET and with keyset pagination.</Empty>;
  const pts = result.data.points;
  const W = 640, H = 220, pad = 46;
  const maxMs = Math.max(...pts.map((p) => p.offsetMs), 0.01);
  const maxOff = Math.max(...pts.map((p) => p.offset), 1);
  const x = (o) => pad + (o / maxOff) * (W - pad * 2);
  const y = (ms) => H - 30 - (ms / maxMs) * (H - 60);
  const path = (k) => pts.map((p, i) => `${i ? 'L' : 'M'} ${x(p.offset)} ${y(p[k])}`).join(' ');
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="OFFSET vs keyset time by depth">
        <line x1={pad} x2={W - pad} y1={H - 30} y2={H - 30} className="grid-line" />
        <path d={path('offsetMs')} className="chart-line-bad draw-line" pathLength="1" />
        <path d={path('keysetMs')} className="chart-line draw-line" pathLength="1" />
        {pts.map((p) => (
          <g key={p.offset}>
            <circle cx={x(p.offset)} cy={y(p.offsetMs)} r="4" className="dot-bad-svg" />
            <text x={x(p.offset)} y={y(p.offsetMs) - 8} textAnchor="middle" className="axis-text">{formatMs(p.offsetMs)}</text>
            <circle cx={x(p.offset)} cy={y(p.keysetMs)} r="4" className="chart-dot" />
            <text x={x(p.offset)} y={H - 12} textAnchor="middle" className="axis-text">{p.offset >= 1000 ? `${p.offset / 1000}k` : p.offset}</text>
          </g>
        ))}
      </svg>
      <div className="legend">
        <span><span className="swatch" style={{ background: 'var(--bad)' }} />LIMIT {result.data.pageSize} OFFSET n</span>
        <span><span className="swatch" style={{ background: 'var(--ok)' }} />WHERE id &gt; last ORDER BY id LIMIT {result.data.pageSize}</span>
      </div>
      <p className="muted">At OFFSET {pts[pts.length - 1].offset.toLocaleString()}: OFFSET read {pts[pts.length - 1].offsetRowsRead.toLocaleString()} rows, keyset read {pts[pts.length - 1].keysetRowsRead}.</p>
      <h4>A new post arrives between page 1 and page 2</h4>
      <div className="feed-pages">
        <div><b>Page 1</b>{result.data.page1.map((r) => <div key={r.id} className="feed-item">{r.title}</div>)}</div>
        <div><b className="bad">Page 2 (OFFSET)</b>{result.data.page2.map((r) => <div key={r.id} className={`feed-item ${result.data.page1.some((p) => p.id === r.id) ? 'feed-dup' : ''}`}>{r.title}</div>)}</div>
        <div><b className="ok">Page 2 (keyset)</b>{result.data.page2Keyset.map((r) => <div key={r.id} className="feed-item">{r.title}</div>)}</div>
      </div>
      <QueryGallery result={result} />
    </div>
  );
}

export function IndexNotUsedVisual({ result }) {
  if (!result) return <Empty>Compare the plans of four predicates written two ways.</Empty>;
  return (
    <div>
      {result.data.cases.map((c, i) => (
        <div key={c.key} className="sarg pop-in" style={{ animationDelay: `${i * 140}ms` }}>
          <h4>{c.title}</h4>
          <VersusRow
            wrong={<><Sql sql={c.wrong} compact /><div className="chip chip-miss">{c.wrongPlan}</div><div className="bad">{formatMs(c.wrongMs)}</div></>}
            right={<><Sql sql={c.right} compact /><div className="chip chip-hit">{c.rightPlan}</div><div className="ok">{formatMs(c.rightMs)}</div></>}
          />
          <p className="muted">{c.why}</p>
        </div>
      ))}
    </div>
  );
}
