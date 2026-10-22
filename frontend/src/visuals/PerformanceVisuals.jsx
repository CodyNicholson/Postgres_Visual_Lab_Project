import React from 'react';
import { Bar, Empty, Stat, formatBytes, formatMs } from '../components/common.jsx';
import { PlanTree, QueryGallery, Sql } from './shared.jsx';

export function ExplainVisual({ result }) {
  if (!result) return <Empty>Pick a query and press “EXPLAIN ANALYZE it” to draw its real plan tree.</Empty>;
  const d = result.data;
  return (
    <div>
      <Sql sql={d.sql} />
      <div className="stat-row">
        <Stat label="execution time" value={formatMs(d.executionMs)} tone="accent" />
        <Stat label="planning time" value={formatMs(d.planningMs)} />
        <Stat label="rows returned" value={(d.plan.rows ?? 0).toLocaleString()} />
      </div>
      <div className="legend">
        <span><span className="swatch" style={{ background: 'var(--ok)' }} />index access</span>
        <span><span className="swatch" style={{ background: 'var(--bad)' }} />full table scan</span>
        <span><span className="swatch" style={{ background: 'var(--warn)' }} />estimate off by &gt;10×</span>
      </div>
      <PlanTree plan={d.plan} />
      <QueryGallery result={result} title="EXPLAIN output" />
    </div>
  );
}

export function IndexesVisual({ result }) {
  if (!result) return <Empty>Press “Measure every index type”: each query is timed without an index, the index is built, and the query is timed again.</Empty>;
  const rows = result.data.results || [];
  const maxMs = Math.max(0.001, ...rows.map((r) => r.beforeMs));
  const maxSize = Math.max(1, ...rows.map((r) => r.sizeBytes));
  return (
    <div>
      <div className="stat-row">
        <Stat label="rows in the table" value={result.data.rows.toLocaleString()} />
        <Stat label="table size" value={formatBytes(result.data.tableBytes)} tone="store" />
      </div>
      <div className="index-grid">
        {rows.map((r, i) => (
          <div key={r.key} className="index-card pop-in" style={{ animationDelay: `${i * 90}ms` }}>
            <div className="index-head"><b>{r.name}</b><span className="pill pill-ok">{r.afterMs > 0 ? `${(r.beforeMs / r.afterMs).toFixed(0)}× faster` : '—'}</span></div>
            <code className="index-ddl">{r.ddl}</code>
            <code className="muted index-sql">{r.sql}</code>
            <Bar label="no index" value={r.beforeMs} max={maxMs} tone="bad" text={formatMs(r.beforeMs)} />
            <Bar label="with index" value={r.afterMs} max={maxMs} tone="ok" text={formatMs(r.afterMs)} />
            <Bar label="index size" value={r.sizeBytes} max={maxSize} tone="store" text={formatBytes(r.sizeBytes)} />
            <div className="plan-chips">
              <span className="chip chip-miss">{r.beforePlan.join(' → ')}</span>
              <span className="chip chip-hit">{r.afterPlan.join(' → ')}</span>
            </div>
            <p className="muted">{r.note}</p>
          </div>
        ))}
      </div>
      <QueryGallery result={result} />
    </div>
  );
}

export function StatisticsVisual({ result }) {
  if (!result) return <Empty>Run it to compare the planner’s row estimates with reality, before and after ANALYZE.</Empty>;
  const e = result.data.estimates;
  const cases = [
    ['Bulk load, stale stats', e.stale, 'bad'],
    ['After ANALYZE', e.fresh, 'ok'],
    ['Correlated columns', e.independent, 'bad'],
    ['With CREATE STATISTICS', e.extended, 'ok'],
  ];
  const max = Math.max(1, ...cases.flatMap(([, v]) => v));
  const mcv = (result.data.mcv || []).find((r) => r.attname === 'kind');
  const kinds = mcv ? mcv.most_common_vals.replace(/[{}]/g, '').split(',') : [];
  const actual = Object.fromEntries((result.data.actual || []).map((a) => [a.kind, a.actual_freq]));
  return (
    <div>
      <h4>Estimated vs actual rows (EXPLAIN ANALYZE)</h4>
      {cases.map(([label, [est, act], tone]) => (
        <div key={label} className="est-pair">
          <Bar label={`${label}: estimate`} value={est} max={max} tone={tone} text={Math.round(est).toLocaleString()} />
          <Bar label="actual" value={act} max={max} tone="store" text={Math.round(act).toLocaleString()} />
        </div>
      ))}
      {mcv && (
        <>
          <h4>pg_stats for events.kind: what ANALYZE sampled vs the truth</h4>
          {kinds.map((k, i) => (
            <div key={k} className="est-pair">
              <Bar label={`${k} (pg_stats)`} value={mcv.most_common_freqs[i]} max={0.7} tone="accent" text={`${(mcv.most_common_freqs[i] * 100).toFixed(1)}%`} />
              <Bar label="actual" value={Number(actual[k] || 0)} max={0.7} tone="store" text={`${(Number(actual[k] || 0) * 100).toFixed(1)}%`} />
            </div>
          ))}
        </>
      )}
      <QueryGallery result={result} />
    </div>
  );
}

export function PgssVisual({ result }) {
  if (!result) return <Empty>Run a small workload and read back what pg_stat_statements recorded.</Empty>;
  const top = result.data.top || [];
  const max = Math.max(0.001, ...top.map((t) => Number(t.total_ms)));
  return (
    <div>
      <h4>Total execution time per normalized query (biggest first)</h4>
      {top.map((t, i) => (
        <div key={i} className="pgss-row pop-in" style={{ animationDelay: `${i * 100}ms` }}>
          <Sql sql={t.query} compact />
          <Bar label={`${t.calls} calls · mean ${formatMs(Number(t.mean_ms))}`} value={Number(t.total_ms)} max={max} tone={i === 0 ? 'bad' : 'accent'} text={formatMs(Number(t.total_ms))} />
          <div className="muted">rows {Number(t.rows).toLocaleString()} · buffers hit {Number(t.shared_blks_hit).toLocaleString()} · read {Number(t.shared_blks_read).toLocaleString()}</div>
        </div>
      ))}
      <QueryGallery result={result} />
    </div>
  );
}
