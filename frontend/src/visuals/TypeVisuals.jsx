import React from 'react';
import { Bar, Empty, Stat } from '../components/common.jsx';
import { Gantt, QueryGallery, VersusRow, queryByTitle, rowsOf } from './shared.jsx';

export function TypesVisual({ result }) {
  if (!result) return <Empty>Run it to compare number types, time zones, uuidv7 and generated columns.</Empty>;
  const m = rowsOf(queryByTitle(result, 'numeric vs float'))[0] || {};
  const tz = rowsOf(queryByTitle(result, 'timestamptz, AT TIME ZONE'))[0] || {};
  const tickets = rowsOf(queryByTitle(result, 'Rows sorted by uuidv7'));
  const sizes = rowsOf(queryByTitle(result, 'How big is each type?'))[0] || {};
  const drift = rowsOf(queryByTitle(result, 'WRONG: timestamp without time zone'))[0];
  const maxSize = Math.max(1, ...Object.values(sizes).map(Number));
  return (
    <div>
      <h4>0.1 + 0.2 = 0.3 ?</h4>
      <VersusRow
        wrong={<><code>float8</code><div className="big-number bad">{String(m.float_sum)}</div><div className="muted">= 0.3 → {String(m.float_equals)}</div></>}
        right={<><code>numeric</code><div className="big-number ok">{String(m.numeric_sum)}</div><div className="muted">= 0.3 → {String(m.numeric_equals)}</div></>}
      />
      <h4>Across the DST change in Berlin (29 March 2026)</h4>
      <div className="stat-row">
        <Stat label="start (Europe/Berlin)" value={String(tz.start_berlin).replace('T', ' ').slice(0, 16)} />
        <Stat label="+ interval '1 day'" value={String(tz.plus_1_day).replace('T', ' ').slice(0, 16)} tone="ok" hint="same wall-clock time" />
        <Stat label="+ interval '24 hours'" value={String(tz.plus_24h).replace('T', ' ').slice(0, 16)} tone="warn" hint="exactly 24 h later" />
      </div>
      {drift && (
        <>
          <h4>Written in New York, read in Tokyo</h4>
          <VersusRow
            wrong={<><code>timestamp</code><div className="mono">{String(drift.at)}</div><div className="bad">off by {String(drift.error)}</div></>}
            right={<><code>timestamptz</code><div className="mono">{String(drift.at_tz)}</div><div className="ok">the real instant</div></>}
          />
        </>
      )}
      <h4>uuidv7(): the first 48 bits are a timestamp, so ids sort in creation order</h4>
      <div className="uuid-list">
        {tickets.map((t, i) => (
          <div key={t.id} className="uuid-row pop-in" style={{ animationDelay: `${i * 90}ms` }}>
            <span className="uuid-n">#{t.n}</span>
            <code><mark>{t.id.slice(0, 13)}</mark>{t.id.slice(13)}</code>
            <span className="muted">total {t.total} · stored {t.total_tax}</span>
          </div>
        ))}
      </div>
      <h4>Bytes per value (pg_column_size)</h4>
      {Object.entries(sizes).map(([k, v]) => <Bar key={k} label={k.replace('_bytes', '')} value={Number(v)} max={maxSize} text={`${v} B`} tone="store" />)}
      <QueryGallery result={result} />
    </div>
  );
}

export function JsonbVisual({ result }) {
  if (!result) return <Empty>Pick a colour and run: @&gt; finds the products whose attrs contain it.</Empty>;
  const hits = rowsOf(queryByTitle(result, '@> containment'));
  const gin = queryByTitle(result, 'EXPLAIN: @> uses');
  const noGin = queryByTitle(result, 'EXPLAIN: ->>');
  const color = result.data.color;
  return (
    <div>
      <h4>attrs @&gt; {`'{"color": "${color}"}'`}: {hits.length} products</h4>
      <div className="tiles">
        {hits.map((h, i) => (
          <div key={h.name} className="tile pop-in" style={{ animationDelay: `${i * 80}ms` }}>
            <div className="tile-value">{h.name}</div>
            <code className="json-small">
              {'{'}{Object.entries(h.attrs).map(([k, v], j) => (
                <span key={k} className={k === 'color' ? 'json-changed' : ''}>{j ? ', ' : ''}"{k}": {JSON.stringify(v)}</span>
              ))}{'}'}
            </code>
          </div>
        ))}
      </div>
      {gin && noGin && (
        <VersusRow
          wrong={<><code>attrs -&gt;&gt; 'color' = 'white'</code><pre className="plan-mini">{noGin.rows.map((r) => r[0]).join('\n')}</pre></>}
          right={<><code>{`attrs @> '{"color": "white"}'`}</code><pre className="plan-mini">{gin.rows.map((r) => r[0]).join('\n')}</pre></>}
        />
      )}
      <QueryGallery result={result} />
    </div>
  );
}

export function RangesVisual({ result }) {
  if (!result) return <Empty>Run it to book rooms with an exclusion constraint and watch the overlapping booking get rejected.</Empty>;
  const bookings = result.data.bookings || [];
  const rejected = result.data.rejected;
  const t0 = Date.parse('2026-11-01T00:00:00Z');
  const h = (iso) => (Date.parse(iso) - t0) / 3600000;
  const items = [
    ...bookings.map((b) => ({ lane: `room ${b.room}`, start: h(b.check_in), end: h(b.check_out), label: b.guest, tone: 'ok' })),
    { lane: `room ${rejected.room}`, start: h(rejected.check_in), end: h(rejected.check_out), label: `${rejected.guest} ✗ rejected`, tone: 'bad' },
  ];
  return (
    <div>
      <h4>Bookings, November 2026 (hours since 1 Nov)</h4>
      <Gantt lanes={['room 101', 'room 102']} items={items} total={6 * 24} unit="h" />
      <div className="gantt-overlay-note muted">The red bar overlaps Ada and Grace in room 101: EXCLUDE USING gist (room WITH =, during WITH &&) rejected it.</div>
      <QueryGallery result={result} />
    </div>
  );
}

function Headline({ text }) {
  const parts = String(text || '').split(/(«[^»]*»)/g);
  return <span>{parts.map((p, i) => (p.startsWith('«') ? <mark key={i}>{p.slice(1, -1)}</mark> : p))}</span>;
}

export function FulltextVisual({ result }) {
  if (!result) return <Empty>Type a search and run it. Try: vacuum bloat · "streaming replication" · locks -deadlock · running</Empty>;
  const hits = result.data.hits || [];
  const max = Math.max(0.0001, ...hits.map((h) => Number(h.rank)));
  return (
    <div>
      <div className="stat-row">
        <Stat label={`full-text hits for “${result.data.q}”`} value={hits.length} tone="accent" />
        <Stat label="ILIKE on the first word" value={result.data.likeCount} />
      </div>
      <ol className="hits">
        {hits.map((h, i) => (
          <li key={h.id} className="hit pop-in" style={{ animationDelay: `${i * 90}ms` }}>
            <div className="hit-head"><b>{h.title}</b><span className="pill">rank {Number(h.rank).toFixed(3)}</span></div>
            <div className="hit-bar"><div style={{ width: `${(Number(h.rank) / max) * 100}%` }} /></div>
            <div className="hit-text"><Headline text={h.headline} /></div>
          </li>
        ))}
        {!hits.length && <li className="muted">No article matches. Try “index”, “replication” or “transactions”.</li>}
      </ol>
      <QueryGallery result={result} />
    </div>
  );
}
