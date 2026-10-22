import React from 'react';
import { formatMs } from './common.jsx';

/** The commands the backend actually ran (typed out line by line) and the self-checks the backend verified. */
export default function ResultPanel({ result, actionLabel }) {
  if (!result) return null;
  const passed = result.checks?.filter((c) => c.passed).length ?? 0;
  const total = result.checks?.length ?? 0;
  return (
    <div className="result-panel">
      <div className="result-head">
        <span className="result-title">{actionLabel}</span>
        <span className="pill">server {formatMs(result.elapsedMs)}</span>
        {result.clientMs != null && <span className="pill">browser round trip {formatMs(result.clientMs)}</span>}
        {total > 0 && (
          <span className={`pill ${passed === total ? 'pill-ok' : 'pill-bad'}`}>{passed}/{total} checks passed</span>
        )}
      </div>
      <div className="result-grid">
        <div>
          <h4>Commands & calls</h4>
          <pre className="terminal" key={`${result.demo}-${result.elapsedMs}-${result.clientMs}`}>
            {result.commands?.map((command, i) => (
              <div key={i} className="terminal-line" style={{ animationDelay: `${Math.min(i, 25) * 45}ms` }}>
                <span className="prompt">›</span> {command}
              </div>
            ))}
          </pre>
        </div>
        {total > 0 && (
          <div>
            <h4>Self-checks</h4>
            <ul className="checks">
              {result.checks.map((check, i) => (
                <li key={i} className={check.passed ? 'check-ok' : 'check-bad'} style={{ animationDelay: `${i * 90}ms` }}>
                  <span className="check-icon">{check.passed ? '✓' : '✗'}</span>
                  <div>
                    <div>{check.name}</div>
                    {check.detail && <div className="check-detail">{check.detail}</div>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
