// Calls the lab backend. Every demo endpoint returns a DemoResult:
// { demo, commands, data, checks: [{ name, passed, detail }], elapsedMs }.

export function buildUrl(path, params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  });
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function callApi(method, url, body) {
  const started = performance.now();
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.error || json.detail || `${method} ${url} failed with ${response.status}`);
  }
  return { ...json, clientMs: Math.round(performance.now() - started) };
}

/** Runs one demo button: a DemoResult endpoint built from the action's path, params and body. */
export function runAction(action, inputs) {
  const path = typeof action.path === 'function' ? action.path(inputs) : action.path;
  const params = action.params ? action.params(inputs) : {};
  const body = action.body ? action.body(inputs) : undefined;
  return callApi(action.method, buildUrl(path, params), body);
}
