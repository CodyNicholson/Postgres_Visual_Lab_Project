import React, { useState } from 'react';
import { DEMOS } from '../demos/catalog.js';
import { callApi } from '../api.js';
import { formatMs } from './common.jsx';

/**
 * Runs every demo's self-test against the live stack, one after another, and shows which
 * checks passed. Each check is verified on the server against real Postgres behaviour.
 */
export default function TestRunner({ results, setResults, onOpen }) {
  const [running, setRunning] = useState(false);

  const runAll = async () => {
    setRunning(true);
    setResults({});
    for (const demo of DEMOS) {
      setResults((prev) => ({ ...prev, [demo.id]: { status: 'running' } }));
      try {
        const result = await callApi(demo.test.method, demo.test.path);
        const ok = result.checks.every((c) => c.passed);
        setResults((prev) => ({ ...prev, [demo.id]: { status: ok ? 'pass' : 'fail', result } }));
      } catch (error) {
        setResults((prev) => ({ ...prev, [demo.id]: { status: 'fail', error: error.message } }));
      }
    }
    setRunning(false);
  };

  const done = Object.values(results).filter((r) => r.status === 'pass' || r.status === 'fail');
  const passed = done.filter((r) => r.status === 'pass').length;
  const checks = done.reduce((sum, r) => sum + (r.result?.checks.length || 0), 0);
  const checksPassed = done.reduce((sum, r) => sum + (r.result?.checks.filter((c) => c.passed).length || 0), 0);

  return (
    <article className="demo">
      <header className="demo-head">
        <span className="chip">Self-test suite</span>
        <h2>Run every demo</h2>
        <p className="tagline">{DEMOS.length} demos, each checked against the live stack</p>
      </header>
      <section className="card">
        <p>
          Each demo endpoint runs its real Postgres calls and then checks its own result. This button runs them all in
          order and shows which checks passed. The backend's automated tests make the same calls (see the README).
        </p>
        <div className="actions">
          <button type="button" className="btn btn-accent" disabled={running} onClick={runAll}>
            {running && <span className="spinner" aria-hidden="true" />}
            {running ? 'Running…' : 'Run all demos'}
          </button>
          {done.length > 0 && (
            <span className={`pill ${passed === done.length ? 'pill-ok' : 'pill-bad'}`}>
              {passed}/{done.length} demos · {checksPassed}/{checks} checks passed
            </span>
          )}
        </div>
      </section>
      <section className="card">
        <table className="suite">
          <thead><tr><th>demo</th><th>endpoint</th><th>status</th><th>checks</th><th>server time</th></tr></thead>
          <tbody>
            {DEMOS.map((demo) => {
              const r = results[demo.id];
              return (
                <tr key={demo.id} className={r ? `suite-${r.status}` : ''}>
                  <td><button type="button" className="link" onClick={() => onOpen(demo.id)}>{demo.title}</button></td>
                  <td><code>{demo.test.method} {decodeURIComponent(demo.test.path)}</code></td>
                  <td>
                    {!r && <span className="muted">–</span>}
                    {r?.status === 'running' && <span className="spinner" aria-label="running" />}
                    {r?.status === 'pass' && <span className="ok">✓ pass</span>}
                    {r?.status === 'fail' && <span className="bad" title={r.error}>✗ fail</span>}
                  </td>
                  <td>
                    {r?.result && (
                      <span title={r.result.checks.map((c) => `${c.passed ? '✓' : '✗'} ${c.name}: ${c.detail}`).join('\n')}>
                        {r.result.checks.filter((c) => c.passed).length}/{r.result.checks.length}
                      </span>
                    )}
                    {r?.error && <span className="bad">{r.error}</span>}
                  </td>
                  <td>{r?.result ? formatMs(r.result.elapsedMs) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </article>
  );
}
