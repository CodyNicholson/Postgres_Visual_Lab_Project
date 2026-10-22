// Small builders shared by the catalog files: request flows and the usual demo buttons.

export const post = (path) => ['ui', 'api', `POST ${path}`];
export const reply = (label = 'DemoResult: SQL, rows, checks') => ['api', 'ui', label];

/** ui → api → …steps… → api → ui */
export const flow = (path, ...steps) => [post(path), ...steps, reply()];

/** The usual query path through one Postgres session. */
export const queryFlow = (path, statement, scan = 'read pages from shared buffers') => flow(
  path,
  ['api', 'session', statement],
  ['session', 'planner', 'parse → rewrite → plan'],
  ['planner', 'storage', scan],
  ['storage', 'session', 'matching rows'],
  ['session', 'api', 'rows + timing'],
);

export const runButton = (path, label = 'Run the queries', params) => ({
  id: 'run', label, method: 'POST', path, params, tone: 'accent',
});

export const wrongButton = (path, label = 'Do it wrong', params) => ({
  id: 'mistake', label, method: 'POST', path, tone: 'ghost',
  params: (inputs) => ({ ...(params ? params(inputs) : {}), mistake: true }),
});
