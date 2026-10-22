import React, { useEffect, useState } from 'react';
import { Bar, Empty, Stat, formatBytes } from '../components/common.jsx';
import { Gantt, QueryGallery, SessionLadder, VersusRow } from './shared.jsx';

export function TransactionsVisual({ result }) {
  if (!result) return <Empty>Run the transfers to watch two sessions: what each one sees, when the failed transfer rolls back, and how a savepoint rescues part of a transaction.</Empty>;
  const after = result.data.balances.afterCommit;
  return (
    <div>
      <div className="stat-row">
        {after.map((r) => <Stat key={r.name} label={`${r.name} after COMMIT`} value={Number(r.balance)} tone="accent" />)}
        <Stat label="total (always 150)" value={after.reduce((s, r) => s + Number(r.balance), 0)} tone="ok" />
      </div>
      <SessionLadder events={result.data.timeline} sessions={result.data.sessions} runKey={result.receivedAt} />
      <QueryGallery result={result} />
    </div>
  );
}

export function IsolationVisual({ result }) {
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [result]);
  if (!result) return <Empty>Run all four scenarios. Each tab replays two real sessions step by step.</Empty>;
  const scenarios = result.data.scenarios;
  const s = scenarios[index];
  return (
    <div>
      <div className="gallery-tabs">
        {scenarios.map((sc, i) => (
          <button key={sc.key} type="button" className={`gallery-tab ${i === index ? 'gallery-tab-on' : ''} ${sc.mistake ? 'gallery-tab-wrong' : ''}`} onClick={() => setIndex(i)}>
            <span className="gallery-num">{i + 1}</span>{sc.title}
          </button>
        ))}
      </div>
      <p className={`scenario-summary ${s.mistake ? 'bad' : ''}`}>{s.summary}</p>
      <SessionLadder key={`${s.key}-${result.receivedAt}`} events={s.events} sessions={['A', 'B']} runKey={`${s.key}-${result.receivedAt}`} speed={550} />
    </div>
  );
}

export function RowLocksVisual({ result }) {
  if (!result) return <Empty>Race the workers: three ways to increment one counter concurrently.</Empty>;
  const { races, workers, increments } = result.data;
  return (
    <div>
      <p className="muted">{workers} workers × {increments} increments each = <b>{workers * increments}</b> expected.</p>
      {races.map((r, i) => (
        <div key={r.strategy} className={`race pop-in ${r.final < r.expected ? 'race-bad' : 'race-ok'}`} style={{ animationDelay: `${i * 200}ms` }}>
          <div className="race-head"><b>{r.title}</b><span className="pill">{r.ms} ms</span></div>
          <code className="muted">{r.how.join('  ;  ')}</code>
          <Bar label={r.final < r.expected ? `lost ${r.expected - r.final}` : 'nothing lost'} value={r.final} max={r.expected} marker={r.expected}
            markerLabel="expected" tone={r.final < r.expected ? 'bad' : 'ok'} text={`${r.final} / ${r.expected}`} />
        </div>
      ))}
      <QueryGallery result={result} title="NOWAIT and SKIP LOCKED" />
    </div>
  );
}

export function SkipLockedVisual({ result }) {
  if (!result) return <Empty>Start the workers and watch them pull jobs from one table at the same time.</Empty>;
  const { log, workers, totalMs, duplicates } = result.data;
  const counts = {};
  log.forEach((e) => { counts[e.job] = (counts[e.job] || 0) + 1; });
  const items = log.map((e) => ({ lane: `worker ${e.worker}`, start: e.start, end: e.end, label: `#${e.job}`, tone: counts[e.job] > 1 ? 'bad' : `w${e.worker}` }));
  return (
    <div>
      <div className="stat-row">
        <Stat label="jobs run" value={log.length} tone="accent" />
        <Stat label="duplicate runs" value={duplicates} tone={duplicates ? 'bad' : 'ok'} />
        <Stat label="wall time" value={`${Math.round(totalMs)} ms`} />
      </div>
      <Gantt lanes={Array.from({ length: workers }, (_, i) => `worker ${i + 1}`)} items={items} total={totalMs} />
      <QueryGallery result={result} />
    </div>
  );
}

function DeadlockCycle({ victim }) {
  return (
    <svg viewBox="0 0 360 150" className="cycle" role="img" aria-label="Deadlock wait-for cycle">
      <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--bad)" /></marker></defs>
      <rect x="20" y="50" width="90" height="46" rx="10" className="cycle-node" /><text x="65" y="78" textAnchor="middle" className="node-label">Session A</text>
      <rect x="250" y="50" width="90" height="46" rx="10" className="cycle-node" /><text x="295" y="78" textAnchor="middle" className="node-label">Session B</text>
      <path d="M110 60 C 170 10, 190 10, 250 60" className="cycle-edge" markerEnd="url(#arrow)" />
      <path d="M250 88 C 190 140, 170 140, 110 88" className="cycle-edge" markerEnd="url(#arrow)" />
      <text x="180" y="22" textAnchor="middle" className="axis-text">A waits for row 2 (held by B)</text>
      <text x="180" y="142" textAnchor="middle" className="axis-text">B waits for row 1 (held by A)</text>
      {victim && <text x="180" y="80" textAnchor="middle" className="cycle-victim">✗ {victim} aborted</text>}
    </svg>
  );
}

export function DeadlocksVisual({ result }) {
  if (!result) return <Empty>Cause a real deadlock between two sessions, then run the same work with a consistent lock order.</Empty>;
  const victim = result.data.deadlock.find((e) => e.error)?.who;
  return (
    <div>
      <DeadlockCycle victim={victim ? `Session ${victim}` : null} />
      <VersusRow
        wrong={<><b>Opposite lock order</b><SessionLadder events={result.data.deadlock} sessions={['A', 'B']} runKey={result.receivedAt} /></>}
        right={<><b>Same lock order (id 1, then 2)</b><SessionLadder events={result.data.ordered} sessions={['A', 'B']} runKey={result.receivedAt} /></>}
      />
      <QueryGallery result={result} />
    </div>
  );
}

export function AdvisoryVisual({ result }) {
  if (!result) return <Empty>Start the workers: first they race for pg_try_advisory_lock, then they queue for pg_advisory_xact_lock.</Empty>;
  const { tries, queue, workers } = result.data;
  const lanes = Array.from({ length: workers }, (_, i) => `worker ${i + 1}`);
  const tryItems = tries.map((t) => ({ lane: `worker ${t.worker}`, start: t.start, end: t.got ? t.end : t.start + 8, label: t.got ? 'got the lock → runs' : 'false → skip', tone: t.got ? 'ok' : 'bad' }));
  const qItems = queue.flatMap((q) => [
    { lane: `worker ${q.worker}`, start: q.asked, end: q.start, label: 'waiting', tone: 'wait' },
    { lane: `worker ${q.worker}`, start: q.start, end: q.end, label: 'locked', tone: `w${q.worker}` },
  ]);
  return (
    <div>
      <h4>pg_try_advisory_lock({result.data.key}): one winner, nobody waits</h4>
      <Gantt lanes={lanes} items={tryItems} total={Math.max(...tries.map((t) => t.end), 1)} />
      <h4>pg_advisory_xact_lock: everyone waits their turn, released at COMMIT</h4>
      <Gantt lanes={lanes} items={qItems} total={Math.max(...queue.map((q) => q.end), 1)} />
      <QueryGallery result={result} />
    </div>
  );
}

export function MvccVisual({ result }) {
  if (!result) return <Empty>Run it to see row versions appear on a page, dead tuples pile up, and VACUUM clean them.</Empty>;
  const d = result.data;
  const [v1, v2] = d.versions;
  const [s0, s1, s2] = d.sizes;
  const maxSize = Math.max(s0, s1, s2);
  return (
    <div>
      <h4>Row 1 before and after two UPDATEs</h4>
      <div className="flow-row">
        <div className="mini-table"><div className="mini-row">ctid <b>{v1.ctid}</b></div><div className="mini-row">xmin <b>{v1.xmin}</b></div><div className="mini-row">qty <b>{v1.qty}</b></div></div>
        <div className="flow-arrow">→ UPDATE ×2 →</div>
        <div className="mini-table"><div className="mini-row">ctid <b className="ok">{v2.ctid}</b></div><div className="mini-row">xmin <b className="ok">{v2.xmin}</b></div><div className="mini-row">qty <b>{v2.qty}</b></div></div>
      </div>
      <h4>Page 0 of a small table, slot by slot (pageinspect)</h4>
      <div className="page-slots">
        {d.page.map((p, i) => {
          const dead = Number(p.xmax) !== 0 || p.pointer !== 'normal';
          return (
            <div key={p.slot} className={`slot pop-in ${dead ? 'slot-dead' : 'slot-live'}`} style={{ animationDelay: `${i * 70}ms` }}>
              <div className="slot-n">slot {p.slot}</div>
              <div>xmin {p.xmin}</div>
              <div>xmax {p.xmax || '0'}</div>
              <div className="muted">→ {p.points_to}</div>
              <div className={dead ? 'bad' : 'ok'}>{p.pointer !== 'normal' ? `${p.pointer} pointer` : dead ? 'old version' : 'live'}</div>
            </div>
          );
        })}
      </div>
      <h4>Table size</h4>
      <Bar label="after INSERT" value={s0} max={maxSize} tone="store" text={formatBytes(s0)} />
      <Bar label={`after UPDATE of all ${d.rows.toLocaleString()} rows`} value={s1} max={maxSize} tone="bad" text={formatBytes(s1)} />
      <Bar label="after VACUUM FULL" value={s2} max={maxSize} tone="ok" text={formatBytes(s2)} />
      <div className="stat-row">
        <Stat label="dead versions after UPDATE" value={d.dead[0].toLocaleString()} tone="bad" />
        {d.dead[1] != null && <Stat label="still dead: old transaction open" value={d.dead[1].toLocaleString()} tone="warn" />}
        <Stat label="dead after VACUUM" value={d.dead[2].toLocaleString()} tone="ok" />
      </div>
      <h4>VACUUM (VERBOSE) said</h4>
      <pre className="terminal">{d.vacuumLog.map((l, i) => <div key={i} className={`terminal-line ${/not yet removable/.test(l) && !/ 0 are dead/.test(l) ? 'bad' : ''}`}>{l}</div>)}</pre>
      <QueryGallery result={result} />
    </div>
  );
}
