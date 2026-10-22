import React, { createContext, useContext, useEffect, useState } from 'react';

export const formatBytes = (bytes) => {
  if (bytes == null || Number.isNaN(bytes)) return '–';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

export const formatMs = (ms) => {
  if (ms == null || Number.isNaN(ms)) return '–';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 100) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms).toLocaleString()} ms`;
};

export const formatNumber = (n) => (n == null ? '–' : Number(n).toLocaleString());

export function Empty({ children }) {
  return <div className="empty">{children || 'Press a button above to run this demo.'}</div>;
}

export function Stat({ label, value, tone, hint }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

/** A horizontal bar whose width animates whenever its value changes. */
export function Bar({ label, value, max, tone = 'accent', text, marker, markerLabel }) {
  const pct = max > 0 ? Math.max(1.5, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="bar-row">
      <div className="bar-label">{label}</div>
      <div className="bar-track">
        <div className={`bar-fill bar-${tone}`} style={{ width: `${pct}%` }} />
        {marker != null && max > 0 && (
          <div className="bar-marker" style={{ left: `${Math.min(100, (marker / max) * 100)}%` }} title={markerLabel} />
        )}
      </div>
      <div className="bar-text">{text ?? value}</div>
    </div>
  );
}

// ---- Live events streamed from the backend over SSE, shared by every demo ----------

const EventsContext = createContext({ events: [], connected: false });

/** Opt-in: only pass `enabled` when the backend serves GET /api/events/stream (event name `lab-event`). */
export function LiveEventsProvider({ enabled = false, children }) {
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return undefined;
    const source = new EventSource('/api/events/stream');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener('lab-event', (e) => {
      const event = JSON.parse(e.data);
      if (event.type === 'hello') return;
      setEvents((prev) => [{ ...event, id: `${event.ts}-${Math.random()}` }, ...prev].slice(0, 60));
    });
    return () => source.close();
  }, [enabled]);

  return <EventsContext.Provider value={{ events, connected }}>{children}</EventsContext.Provider>;
}

export const useLiveEvents = () => useContext(EventsContext);

/** Re-renders every `ms` so countdowns can tick. */
export function useNow(ms = 250) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** Steps 0 → n once per `ms` after `runKey` changes: drives "play the animation" visuals. */
export function useStepper(n, runKey, ms = 600) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    setStep(0);
    if (!n) return undefined;
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      setStep(i);
      if (i >= n) clearInterval(timer);
    }, ms);
    return () => clearInterval(timer);
  }, [n, runKey, ms]);
  return step;
}
