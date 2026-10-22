import React, { useState } from 'react';

/** A code listing with a file-name tab and a copy button. Lines fade in one after another. */
export default function CodeBlock({ code, lang, name }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="muted">{name || lang}</span>
        <button type="button" className="btn btn-ghost btn-small" onClick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>
      </div>
      <pre className="code" key={code}>
        {code.split('\n').map((line, i) => (
          <div key={i} className="terminal-line" style={{ animationDelay: `${Math.min(i, 40) * 25}ms` }}>{line || ' '}</div>
        ))}
      </pre>
    </div>
  );
}
