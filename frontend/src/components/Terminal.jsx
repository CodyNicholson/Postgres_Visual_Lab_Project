import React, { useEffect, useState } from 'react';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Types each command out character by character, like someone at a shell. Click to replay. */
export default function Terminal({ commands, speed = 28 }) {
  const full = commands.join('\n');
  const [shown, setShown] = useState(prefersReducedMotion() ? full.length : 0);
  const [runKey, setRunKey] = useState(0);

  useEffect(() => {
    if (prefersReducedMotion()) return undefined;
    setShown(0);
    const timer = setInterval(() => {
      setShown((n) => {
        if (n >= full.length) clearInterval(timer);
        return Math.min(full.length, n + 1);
      });
    }, speed);
    return () => clearInterval(timer);
  }, [full, speed, runKey]);

  const lines = full.slice(0, shown).split('\n');
  return (
    <pre className="terminal terminal-typed" onClick={() => setRunKey((k) => k + 1)} title="Click to replay">
      {lines.map((line, i) => (
        <div key={i}>
          <span className="prompt">$</span> {line}
          {i === lines.length - 1 && <span className="caret" aria-hidden="true">▋</span>}
        </div>
      ))}
    </pre>
  );
}
