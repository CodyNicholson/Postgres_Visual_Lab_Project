import React, { useEffect, useMemo, useState } from 'react';
import { formatMs, useStepper } from '../components/common.jsx';

// ---- SQL with keyword highlighting --------------------------------------------------------

const KEYWORDS = new Set(`SELECT FROM WHERE AND OR NOT IN IS NULL AS ON JOIN LEFT RIGHT FULL INNER OUTER CROSS LATERAL GROUP BY ORDER
HAVING LIMIT OFFSET FETCH FIRST ROWS ONLY WITH TIES DISTINCT UNION ALL INTERSECT EXCEPT INSERT INTO VALUES UPDATE SET DELETE
RETURNING CREATE TABLE INDEX VIEW MATERIALIZED REFRESH CONCURRENTLY DROP ALTER ADD COLUMN CONSTRAINT PRIMARY KEY FOREIGN
REFERENCES UNIQUE CHECK DEFAULT GENERATED ALWAYS IDENTITY STORED CASE WHEN THEN ELSE END EXISTS ANY BETWEEN LIKE ILIKE
BEGIN COMMIT ROLLBACK SAVEPOINT RELEASE TRANSACTION ISOLATION LEVEL READ COMMITTED REPEATABLE SERIALIZABLE FOR SHARE
NOWAIT SKIP LOCKED RECURSIVE OVER PARTITION WINDOW RANGE PRECEDING FOLLOWING CURRENT ROW CONFLICT DO NOTHING EXCLUDED
MERGE USING MATCHED EXPLAIN ANALYZE BUFFERS COSTS FORMAT VACUUM FULL VERBOSE GRANT REVOKE TO ROLE USAGE SCHEMA POLICY
ENABLE FORCE ROW LEVEL SECURITY FUNCTION PROCEDURE RETURNS LANGUAGE TRIGGER BEFORE AFTER EACH STATEMENT EXECUTE CALL
DECLARE IF LOOP RAISE NOTICE EXCEPTION RETURN NEW OLD TYPE ENUM DOMAIN EXTENSION LISTEN NOTIFY UNLISTEN COPY STDIN STDOUT
CYCLE TRUNCATE CASCADE NULLS LAST ASC DESC FILTER WITHIN ROLLUP CUBE GROUPING SETS ATTACH DETACH OF EXCLUDE OVERLAPS WITHOUT
TEMP TEMPORARY IMMUTABLE STABLE VOLATILE OWNER INCLUDE ONLY TRUE FALSE USING VALID VALIDATE DEFERRABLE INITIALLY DEFERRED
IMMEDIATE CONSTRAINTS STATISTICS COLUMNS PATH ORDINALITY JSON_TABLE LOCAL TIME ZONE INTERVAL AT`.split(/\s+/));

const TOKEN = /(--[^\n]*|'(?:[^']|'')*'|"[^"]*"|\$\d+|%s|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z_0-9]*\b|[^\sA-Za-z_0-9'"-]+|\s+|-)/g;

export function highlightSql(sql) {
  const parts = sql.match(TOKEN) || [sql];
  return parts.map((part, i) => {
    if (part.startsWith('--')) return <span key={i} className="sql-comment">{part}</span>;
    if (part.startsWith("'")) return <span key={i} className="sql-string">{part}</span>;
    if (part.startsWith('$') || part === '%s') return <span key={i} className="sql-param">{part}</span>;
    if (/^\d/.test(part)) return <span key={i} className="sql-number">{part}</span>;
    if (KEYWORDS.has(part.toUpperCase()) && part === part.toUpperCase()) return <span key={i} className="sql-keyword">{part}</span>;
    return part;
  });
}

export function Sql({ sql, compact = false }) {
  return <pre className={`sql ${compact ? 'sql-compact' : ''}`}>{highlightSql(sql)}</pre>;
}

// ---- Result rows ----------------------------------------------------------------------------

export function Cell({ value }) {
  if (value === null || value === undefined) return <span className="null">NULL</span>;
  if (typeof value === 'boolean') return <span className={value ? 'ok' : 'bad'}>{String(value)}</span>;
  if (typeof value === 'object') return <code className="cell-json">{JSON.stringify(value)}</code>;
  return String(value);
}

export function ResultTable({ columns, rows, highlight, max = 60 }) {
  if (!columns?.length) return null;
  return (
    <div className="table-wrap result-table">
      <table>
        <thead><tr>{columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.slice(0, max).map((row, r) => (
            <tr key={r} className={`row-in ${highlight?.(row, r) ? 'row-hot' : ''}`} style={{ animationDelay: `${Math.min(r, 20) * 35}ms` }}>
              {row.map((v, c) => <td key={c}><Cell value={v} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One executed statement: its SQL, why it is written that way, and what came back (or the real error). */
export function QueryCard({ q, highlight }) {
  const wrong = q.title?.startsWith('WRONG');
  const right = q.title?.startsWith('RIGHT') || q.title?.startsWith('ALSO RIGHT');
  return (
    <div className={`query-card ${wrong ? 'query-wrong' : ''} ${right ? 'query-right' : ''}`}>
      <div className="query-head">
        <b>{q.title}</b>
        <span className="pill">{q.error ? 'error' : q.rowCount < 0 ? q.status : `${q.rowCount ?? 0} row${q.rowCount === 1 ? '' : 's'}`}</span>
        <span className="pill">{formatMs(q.ms)}</span>
      </div>
      <Sql sql={q.sql} />
      {q.params && <div className="query-params">parameters: <code>{JSON.stringify(q.params)}</code></div>}
      {q.note && <p className="query-note">{q.note}</p>}
      {q.error ? <pre className="pitfall-symptom pop-in">{q.error}</pre> : (
        q.columns?.length === 1 && q.columns[0] === 'QUERY PLAN' ? <pre className="plan-mini">{q.rows.map((r) => r[0]).join('\n')}</pre> :
        q.columns?.length > 0 ? <ResultTable columns={q.columns} rows={q.rows} highlight={highlight} /> :
          <div className="muted query-status">{q.status || 'done'}</div>
      )}
      {q.truncated && <div className="muted">… first {q.rows.length} rows shown</div>}
    </div>
  );
}

/**
 * Every statement a demo ran, as tabs: pick one to see its SQL, the explanation and the result.
 * "Show all" stacks them so the whole lesson reads top to bottom.
 */
export function QueryGallery({ result, filter, title = 'Every query this demo ran', highlight }) {
  const queries = useMemo(() => (result?.data?.queries || []).filter(filter || (() => true)), [result, filter]);
  const [index, setIndex] = useState(0);
  const [all, setAll] = useState(false);
  useEffect(() => setIndex(0), [result]);
  if (!queries.length) return null;
  const q = queries[Math.min(index, queries.length - 1)];
  return (
    <div className="gallery">
      <div className="card-title-row">
        <h4>{title} <span className="muted">({queries.length})</span></h4>
        <button type="button" className="btn btn-ghost btn-small" onClick={() => setAll((v) => !v)}>{all ? 'One at a time' : 'Show all'}</button>
      </div>
      {!all && (
        <div className="gallery-tabs" role="tablist">
          {queries.map((item, i) => (
            <button key={i} type="button" role="tab" aria-selected={i === index}
              className={`gallery-tab ${i === index ? 'gallery-tab-on' : ''} ${item.error ? 'gallery-tab-error' : ''} ${item.title.startsWith('WRONG') ? 'gallery-tab-wrong' : ''}`}
              onClick={() => setIndex(i)}>
              <span className="gallery-num">{i + 1}</span>{item.title}
            </button>
          ))}
        </div>
      )}
      {all ? queries.map((item, i) => <QueryCard key={i} q={item} highlight={highlight} />) : <QueryCard key={`${index}-${result.receivedAt}`} q={q} highlight={highlight} />}
    </div>
  );
}

export const queryByTitle = (result, start) => (result?.data?.queries || []).find((q) => q.title.startsWith(start));

/** Rows of one gallery query as objects. */
export function rowsOf(q) {
  if (!q) return [];
  return q.rows.map((row) => Object.fromEntries(q.columns.map((c, i) => [c, row[i]])));
}

// ---- Two or more sessions, step by step ------------------------------------------------------

const SESSION_COLORS = ['var(--session)', 'var(--session2)', 'var(--planner)', 'var(--replica)', 'var(--wal)', 'var(--ui)'];

/**
 * A ladder diagram: one column per session, one row per statement in the order they ran.
 * Steps appear one by one; a step that waited shows how long, errors glow red.
 */
export function SessionLadder({ events, sessions, runKey, speed = 420 }) {
  const shown = useStepper(events.length, runKey, speed);
  const cols = sessions || [...new Set(events.map((e) => e.who))];
  return (
    <div className="ladder" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
      {cols.map((who, i) => (
        <div key={who} className="ladder-head" style={{ borderColor: SESSION_COLORS[i % SESSION_COLORS.length] }}>
          Session {who}
        </div>
      ))}
      {events.slice(0, Math.max(shown, 1)).map((e, i) => {
        const col = cols.indexOf(e.who);
        const waited = e.end - e.start;
        return (
          <div key={i} className={`ladder-step pop-in ${e.error ? 'ladder-error' : ''}`}
            style={{ gridColumn: col + 1, gridRow: i + 2, borderLeftColor: SESSION_COLORS[col % SESSION_COLORS.length] }}>
            <code>{e.sql}</code>
            {waited > 60 && <div className="ladder-wait">⏳ waited {Math.round(waited)} ms</div>}
            {e.result && !e.error && <div className="ladder-result">→ {e.result}</div>}
            {e.error && <div className="ladder-err">✗ {e.error.split('\n')[0].replace('ERROR:  ', '')}</div>}
            {e.note && <div className="ladder-note">{e.note}</div>}
          </div>
        );
      })}
    </div>
  );
}

// ---- Gantt timelines ------------------------------------------------------------------------

/** Bars on a shared time axis, one lane per worker. items: [{ lane, start, end, label, tone }] */
export function Gantt({ lanes, items, total, unit = 'ms' }) {
  const max = total || Math.max(1, ...items.map((i) => i.end));
  return (
    <div className="gantt">
      {lanes.map((lane) => (
        <div key={lane} className="gantt-lane">
          <div className="gantt-label">{lane}</div>
          <div className="gantt-track">
            {items.filter((i) => i.lane === lane).map((item, i) => (
              <div key={i} className={`gantt-bar gantt-${item.tone || 'accent'}`} title={`${item.label}: ${item.start}–${item.end} ${unit}`}
                style={{ left: `${(item.start / max) * 100}%`, width: `${Math.max(0.8, ((item.end - item.start) / max) * 100)}%`, animationDelay: `${Math.min(i, 30) * 30}ms` }}>
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="gantt-axis"><span>0</span><span>{Math.round(max)} {unit}</span></div>
    </div>
  );
}

// ---- Query plans ------------------------------------------------------------------------------

export function PlanNode({ node, depth = 0, maxMs }) {
  const scan = /Scan/.test(node.type);
  const seq = /Seq Scan/.test(node.type);
  return (
    <div className="plan-node pop-in" style={{ animationDelay: `${depth * 140}ms` }}>
      <div className={`plan-box ${seq ? 'plan-seq' : scan ? 'plan-index' : ''}`}>
        <div className="plan-title">
          <b>{node.type}</b>
          {node.strategy && <span className="muted"> {node.strategy}</span>}
          {node.relation && <span> on <code>{node.relation}</code></span>}
          {node.index && <span> using <code>{node.index}</code></span>}
        </div>
        {node.filter && <code className="plan-filter">{node.filter}</code>}
        <div className="plan-stats">
          <span>est. {node.planRows?.toLocaleString()} rows</span>
          {node.rows != null && <span className={Math.abs(Math.log10(((node.rows || 0) + 1) / ((node.planRows || 0) + 1))) > 1 ? 'warn-text' : ''}>
            actual {node.rows?.toLocaleString()}{node.loops > 1 ? ` × ${node.loops} loops` : ''}</span>}
          {node.removed != null && <span className="bad">removed by filter {node.removed.toLocaleString()}</span>}
          {node.hit != null && <span>buffers hit {node.hit}{node.read ? `, read ${node.read}` : ''}</span>}
          {node.workers != null && <span>workers {node.workers}</span>}
        </div>
        {node.ms != null && maxMs > 0 && (
          <div className="plan-bar"><div style={{ width: `${Math.max(2, (node.ms / maxMs) * 100)}%` }} /><span>{formatMs(node.ms)}</span></div>
        )}
      </div>
      {node.children?.length > 0 && (
        <div className="plan-children">
          {node.children.map((child, i) => <PlanNode key={i} node={child} depth={depth + 1} maxMs={maxMs} />)}
        </div>
      )}
    </div>
  );
}

export function PlanTree({ plan }) {
  if (!plan) return null;
  return <div className="plan-tree"><PlanNode node={plan} maxMs={plan.ms || 0} /></div>;
}

/** A "wrong vs right" pair of columns. */
export function VersusRow({ wrong, right }) {
  return (
    <div className="versus">
      <div className="versus-side versus-wrong"><div className="versus-label">✗ Wrong</div>{wrong}</div>
      <div className="versus-side versus-right"><div className="versus-label">✓ Right</div>{right}</div>
    </div>
  );
}
