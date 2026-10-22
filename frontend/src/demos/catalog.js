// Every lab demo in one place: what it teaches, how its request flows through the stack
// (drives the animated diagram), which buttons it has, and which call the "Run all" suite uses.
// Flow steps are [from, to, label]; from === to means work done inside that node.
// The demo entries live in one file per category; the self-test calls are listed here.

import { QUERY_DEMOS } from './queries.js';
import { TYPE_DEMOS } from './types.js';
import { SCHEMA_DEMOS } from './schema.js';
import { PERFORMANCE_DEMOS } from './performance.js';
import { CONCURRENCY_DEMOS } from './concurrency.js';
import { SECURITY_DEMOS } from './security.js';
import { FEATURE_DEMOS } from './features.js';
import { OPERATIONS_DEMOS } from './operations.js';
import { MISTAKE_DEMOS } from './mistakes.js';

/** The participants a flow can show. Colors are CSS variables defined in App.css. */
export const NODE_META = {
  ui: { label: 'Browser', sub: 'React', color: 'var(--ui)' },
  api: { label: 'Backend', sub: 'FastAPI + psycopg', color: 'var(--api)' },
  session: { label: 'Session A', sub: 'postgres backend', color: 'var(--session)' },
  session2: { label: 'Session B', sub: 'another backend', color: 'var(--session2)' },
  planner: { label: 'Planner', sub: 'plan + execute', color: 'var(--planner)' },
  storage: { label: 'Tables', sub: 'heap + indexes', color: 'var(--store)' },
  wal: { label: 'WAL', sub: 'write-ahead log', color: 'var(--wal)' },
  replica: { label: 'Replica', sub: 'hot standby', color: 'var(--replica)' },
};

/** Left-to-right order of the participants in every diagram. */
export const NODE_ORDER = ['ui', 'api', 'session', 'session2', 'planner', 'storage', 'wal', 'replica'];

export function nodesFor(flow) {
  const used = new Set(flow.flatMap(([from, to]) => [from, to]));
  return NODE_ORDER.filter((id) => used.has(id));
}

export const CATEGORIES = [
  'SQL queries',
  'Data types',
  'Schema & server logic',
  'Indexes & performance',
  'Transactions & concurrency',
  'Security',
  'Features & extensions',
  'Operations',
  'Common mistakes',
];

// The call "Run all demos" (and test-isolated.sh) makes for each demo: small, fast parameters.
const TESTS = {
  select: { test: { method: 'POST', path: '/api/demos/select?country=UK&limit=5' } },
  dml: { test: { method: 'POST', path: '/api/demos/dml' } },
  upsert: { test: { method: 'POST', path: '/api/demos/upsert' } },
  joins: { test: { method: 'POST', path: '/api/demos/joins' } },
  aggregates: { test: { method: 'POST', path: '/api/demos/aggregates?min_revenue=1000' } },
  subqueries: { test: { method: 'POST', path: '/api/demos/subqueries' } },
  ctes: { test: { method: 'POST', path: '/api/demos/ctes' } },
  windows: { test: { method: 'POST', path: '/api/demos/windows' } },
  types: { test: { method: 'POST', path: '/api/demos/types' } },
  jsonb: { test: { method: 'POST', path: '/api/demos/jsonb?color=black' } },
  'arrays-ranges': { test: { method: 'POST', path: '/api/demos/arrays-ranges' } },
  fulltext: { test: { method: 'POST', path: '/api/demos/fulltext?q=indexes%20for%20fast%20queries' } },
  constraints: { test: { method: 'POST', path: '/api/demos/constraints' } },
  views: { test: { method: 'POST', path: '/api/demos/views' } },
  functions: { test: { method: 'POST', path: '/api/demos/functions?n=10' } },
  triggers: { test: { method: 'POST', path: '/api/demos/triggers' } },
  partitioning: { test: { method: 'POST', path: '/api/demos/partitioning' } },
  explain: { test: { method: 'POST', path: '/api/demos/explain?query=by_user' } },
  indexes: { test: { method: 'POST', path: '/api/demos/indexes?rows=20000' } },
  statistics: { test: { method: 'POST', path: '/api/demos/statistics?rows=20000' } },
  'pg-stat-statements': { test: { method: 'POST', path: '/api/demos/pg-stat-statements?calls=20' } },
  transactions: { test: { method: 'POST', path: '/api/demos/transactions?amount=30' } },
  isolation: { test: { method: 'POST', path: '/api/demos/isolation' } },
  'row-locks': { test: { method: 'POST', path: '/api/demos/row-locks?workers=3&increments=10' } },
  'skip-locked': { test: { method: 'POST', path: '/api/demos/skip-locked?jobs=12&workers=3' } },
  deadlocks: { test: { method: 'POST', path: '/api/demos/deadlocks' } },
  'advisory-locks': { test: { method: 'POST', path: '/api/demos/advisory-locks?workers=3' } },
  mvcc: { test: { method: 'POST', path: '/api/demos/mvcc?rows=5000' } },
  roles: { test: { method: 'POST', path: '/api/demos/roles' } },
  rls: { test: { method: 'POST', path: '/api/demos/rls?tenant=1' } },
  'sql-injection': { test: { method: 'POST', path: '/api/demos/sql-injection' } },
  'listen-notify': { test: { method: 'POST', path: '/api/demos/listen-notify' } },
  copy: { test: { method: 'POST', path: '/api/demos/copy?rows=5000' } },
  trigram: { test: { method: 'POST', path: '/api/demos/trigram?q=mecanical%20keybord' } },
  vector: { test: { method: 'POST', path: '/api/demos/vector?sweet=0.8&savory=0.2&crunchy=0.8&k=4' } },
  pooling: { test: { method: 'POST', path: '/api/demos/pooling?connections=8' } },
  monitoring: { test: { method: 'POST', path: '/api/demos/monitoring' } },
  migrations: { test: { method: 'POST', path: '/api/demos/migrations' } },
  backup: { test: { method: 'POST', path: '/api/demos/backup' } },
  replication: { test: { method: 'POST', path: '/api/demos/replication?writes=3' } },
  'n-plus-one': { test: { method: 'POST', path: '/api/demos/n-plus-one?orders=30' } },
  'not-in-null': { test: { method: 'POST', path: '/api/demos/not-in-null' } },
  pagination: { test: { method: 'POST', path: '/api/demos/pagination?page_size=20' } },
  'index-not-used': { test: { method: 'POST', path: '/api/demos/index-not-used' } },
};

export const DEMOS = [
  ...QUERY_DEMOS,
  ...TYPE_DEMOS,
  ...SCHEMA_DEMOS,
  ...PERFORMANCE_DEMOS,
  ...CONCURRENCY_DEMOS,
  ...SECURITY_DEMOS,
  ...FEATURE_DEMOS,
  ...OPERATIONS_DEMOS,
  ...MISTAKE_DEMOS,
].map((demo) => ({ ...demo, ...TESTS[demo.id] }));
