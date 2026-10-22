import { flow, runButton, wrongButton } from './flows.js';

const CAT = 'Indexes & performance';

export const PERFORMANCE_DEMOS = [
  {
    id: 'explain',
    category: CAT,
    title: 'EXPLAIN & EXPLAIN ANALYZE',
    tagline: 'Read a query plan: scans, joins, estimates vs reality, buffers',
    description: [
      'Before running a query, the planner considers many ways to execute it and picks the cheapest by its cost estimates. EXPLAIN shows that plan as a tree: leaves read data (Seq Scan, Index Scan, Bitmap Heap Scan), inner nodes combine it (Hash Join, Sort, Aggregate, Limit). EXPLAIN ANALYZE actually runs the query and adds real row counts, timings and (on by default in Postgres 18) buffer counts.',
      'Pick a query and run it. The tree is drawn from EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) on the 200,000-row events table: green leaves use an index, red leaves scan the whole table. Compare "est." with "actual": a big mismatch (highlighted) is the most common reason for a bad plan.',
      'Read plans bottom-up and look for: Seq Scans on big tables with very selective filters, "Rows Removed by Filter" in the millions, nested loops with many loops, and sorts or hashes that spill to disk.',
    ],
    keyApis: ['EXPLAIN', 'EXPLAIN (ANALYZE, BUFFERS)', 'FORMAT JSON', 'Seq Scan', 'Index Scan / Index Only Scan', 'Bitmap Heap Scan', 'Hash Join', 'auto_explain'],
    useCases: ['Diagnosing slow queries', 'Choosing indexes', 'Verifying a fix', 'Code review of SQL'],
    snippet: {
      lang: 'sql', name: 'explain.sql', code: `EXPLAIN SELECT * FROM events WHERE user_id = 42;            -- plan + estimates only
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM events WHERE user_id = 42;   -- runs it

-- Bitmap Heap Scan on events  (cost=4.73..152.83 rows=40 width=…) (actual time=… rows=38 loops=1)
--   Recheck Cond: (user_id = 42)
--   Buffers: shared hit=41
--   ->  Bitmap Index Scan on events_user_id_idx  (… rows=40) (actual … rows=38 loops=1)`,
    },
    inputs: [{
      name: 'query', label: 'Query', type: 'select', default: 'by_user',
      options: ['by_id', 'by_user', 'by_kind', 'top_n', 'join'],
    }],
    flow: flow('/api/demos/explain',
      ['api', 'session', 'EXPLAIN (ANALYZE, BUFFERS) …'],
      ['session', 'planner', 'enumerate plans, estimate costs from pg_stats'],
      ['planner', 'storage', 'execute the cheapest plan, count rows/buffers'],
      ['planner', 'session', 'plan tree with actuals'],
      ['session', 'api', 'JSON plan'],
    ),
    actions: [
      runButton('/api/demos/explain', 'EXPLAIN ANALYZE it', (i) => ({ query: i.query })),
      wrongButton('/api/demos/explain', 'EXPLAIN ANALYZE a DELETE', (i) => ({ query: i.query })),
    ],
    pitfalls: [
      {
        mistake: 'EXPLAIN ANALYZE on INSERT/UPDATE/DELETE outside a transaction',
        symptom: 'DELETE 1000 … the rows are really gone after "just looking at the plan".',
        why: 'ANALYZE executes the statement to measure it.',
        fix: 'Restore the rows from a backup.',
        avoid: 'BEGIN; EXPLAIN ANALYZE <write>; ROLLBACK;',
        lang: 'sql', wrongCode: 'EXPLAIN ANALYZE DELETE FROM victims;', rightCode: 'BEGIN;\nEXPLAIN ANALYZE DELETE FROM victims;\nROLLBACK;',
        reproduce: 'mistake',
      },
      {
        mistake: 'Reading cost as milliseconds',
        symptom: '"The plan says cost=10000, so it takes 10 seconds."',
        why: 'Costs are arbitrary planner units (seq_page_cost = 1.0) used only to compare plans of the same query.',
        fix: 'Use EXPLAIN ANALYZE for real time; compare estimated vs actual rows.',
        avoid: 'Focus on rows estimates and actual time, not cost numbers.',
      },
      {
        mistake: 'Testing plans on a tiny development database',
        symptom: 'Fast in dev, Seq Scans and timeouts in production (or the other way round).',
        why: 'The planner\'s choice depends on table sizes and statistics; on 100 rows a Seq Scan is the right plan.',
        fix: 'Run EXPLAIN (ANALYZE, BUFFERS) on production-sized data (a restored copy) or capture plans in production with auto_explain.',
        avoid: 'Keep a realistic staging dataset; log slow plans with auto_explain.log_min_duration.',
      },
    ],
    visual: 'explain',
  },
  {
    id: 'indexes',
    category: CAT,
    title: 'Index types',
    tagline: 'B-tree, expression, partial, covering, skip scan, GIN, BRIN, hash: measured',
    description: [
      'An index is a separate structure that lets Postgres find rows without reading the whole table. B-tree (the default) handles equality, ranges and sorting. An expression index indexes a computed value; a partial index covers only some rows; a covering index (INCLUDE) can answer a query alone (Index Only Scan). GIN indexes the contents of jsonb, arrays and full text; BRIN stores min/max per block range and is tiny on naturally ordered data. Postgres 18 adds B-tree skip scan, so an index on (kind, user_id) can serve WHERE user_id = … alone.',
      'For each type the demo copies the events into a private table, times a query with no index, creates the index, and times it again. The bars show the before/after time and the index size, measured just now. Choose the number of rows to see how the gap grows with table size.',
      'Indexes are not free: each one slows every INSERT and UPDATE, takes disk and memory, and needs VACUUM. "Do it wrong" shows the planner (rightly) ignoring an index on a column where most rows match.',
    ],
    keyApis: ['CREATE INDEX', 'USING btree / hash / gin / gist / brin', 'CREATE INDEX … (expr)', 'CREATE INDEX … WHERE', 'INCLUDE (…)', 'gin jsonb_path_ops', 'skip scan (18)', 'pg_relation_size'],
    useCases: ['Speeding up lookups', 'Sorting without a sort', 'Searching JSON and text', 'Huge time-series tables'],
    snippet: {
      lang: 'sql', name: 'indexes.sql', code: `CREATE INDEX ev_user_idx      ON ev (user_id);                              -- B-tree
CREATE INDEX ev_ms_idx        ON ev (((payload->>'ms')::int));              -- expression
CREATE INDEX ev_refund_idx    ON ev (created_at) WHERE kind = 'refund';     -- partial
CREATE INDEX ev_user_inc_idx  ON ev (user_id) INCLUDE (created_at);         -- covering
CREATE INDEX ev_kind_user_idx ON ev (kind, user_id);                        -- skip scan (18)
CREATE INDEX ev_payload_idx   ON ev USING gin (payload jsonb_path_ops);     -- GIN
CREATE INDEX ev_created_brin  ON ev USING brin (created_at);                -- BRIN
CREATE INDEX ev_user_hash     ON ev USING hash (user_id);                   -- hash`,
    },
    inputs: [{ name: 'rows', label: 'Rows in the table', type: 'select', default: 100000, options: [20000, 50000, 100000, 200000] }],
    flow: flow('/api/demos/indexes',
      ['api', 'session', 'CREATE TABLE ev AS … (no indexes)'],
      ['session', 'planner', 'EXPLAIN ANALYZE: Seq Scan'],
      ['session', 'storage', 'CREATE INDEX …'],
      ['planner', 'storage', 'EXPLAIN ANALYZE again: Index Scan'],
      ['session', 'api', 'before/after timings + sizes'],
    ),
    actions: [
      runButton('/api/demos/indexes', 'Measure every index type', (i) => ({ rows: i.rows })),
      wrongButton('/api/demos/indexes', 'Index a non-selective column', (i) => ({ rows: i.rows })),
    ],
    pitfalls: [
      {
        mistake: 'Indexing every column "just in case"',
        symptom: 'Writes slow down, the database is twice the size of its data, and most indexes show idx_scan = 0 in pg_stat_user_indexes.',
        why: 'Every INSERT/UPDATE must update every index; unused indexes still cost WAL, cache and VACUUM time.',
        fix: 'Find unused ones: SELECT indexrelid::regclass, idx_scan FROM pg_stat_user_indexes WHERE idx_scan = 0; then DROP INDEX CONCURRENTLY.',
        avoid: 'Add indexes for specific, measured queries.',
      },
      {
        mistake: 'Expecting an index to help when most rows match',
        symptom: 'EXPLAIN shows Seq Scan on events even though an index on kind exists.',
        why: '60% of rows are page_view. Reading most of the table through an index (random I/O) is slower than one sequential pass, so the planner ignores it, correctly.',
        fix: 'Nothing to fix. For the rare values, a partial index (WHERE kind = \'refund\') is small and useful.',
        avoid: 'Index selective predicates; check pg_stats.most_common_freqs.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Wrong column order in a multicolumn index',
        symptom: 'An index on (created_at, user_id) is not used for WHERE user_id = 42 (or only via a slow full index scan).',
        why: 'B-tree entries are sorted by the first column first. Postgres 18 skip scan helps only when the leading column has few distinct values.',
        fix: 'Create the index with the equality column first: (user_id, created_at).',
        avoid: 'Equality columns first, then range/sort columns.',
      },
      {
        mistake: 'CREATE INDEX on a busy production table',
        symptom: 'All INSERT/UPDATE/DELETE on the table wait for minutes while the index builds.',
        why: 'Plain CREATE INDEX takes a SHARE lock that blocks writes for the whole build.',
        fix: 'Use CREATE INDEX CONCURRENTLY (see the safe migrations demo); drop and retry if it leaves an INVALID index.',
        avoid: 'Always CONCURRENTLY on live tables.',
      },
    ],
    visual: 'indexes',
  },
  {
    id: 'statistics',
    category: CAT,
    title: 'Planner statistics & ANALYZE',
    tagline: 'What the planner knows about your data, and what happens when it is wrong',
    description: [
      'The planner chooses plans from statistics that ANALYZE collects: the number of rows, distinct values, the most common values and their frequencies, histograms and physical correlation, stored in pg_stats. Autovacuum runs ANALYZE automatically after enough rows change, but not instantly.',
      'The demo first shows what Postgres knows about events.kind next to the real frequencies. Then it loads 100,000 rows into a table that was analyzed when it had 10: the estimate is off by orders of magnitude until ANALYZE runs. Finally, two correlated columns (each zip belongs to one city) fool the planner into multiplying selectivities, and CREATE STATISTICS fixes it.',
      'Bad estimates are behind most "suddenly slow" queries: a nested loop chosen for "10 rows" that really runs for 100,000.',
    ],
    keyApis: ['ANALYZE', 'pg_stats', 'n_distinct', 'most_common_vals', 'default_statistics_target', 'CREATE STATISTICS (dependencies, ndistinct, mcv)', 'autovacuum_analyze_scale_factor'],
    useCases: ['After bulk loads', 'Fixing bad plans', 'Correlated columns', 'Skewed data'],
    snippet: {
      lang: 'sql', name: 'stats.sql', code: `SELECT attname, n_distinct, most_common_vals, most_common_freqs, correlation
FROM pg_stats WHERE tablename = 'events';

-- After a bulk load, don't wait for autovacuum:
COPY fresh FROM STDIN …;
ANALYZE fresh;

-- City and zip are correlated: tell the planner
CREATE STATISTICS places_dep (dependencies) ON city, zip FROM places;
ANALYZE places;`,
    },
    inputs: [{ name: 'rows', label: 'Rows to bulk load', type: 'select', default: 100000, options: [20000, 50000, 100000, 200000] }],
    flow: flow('/api/demos/statistics',
      ['api', 'session', 'bulk INSERT, no ANALYZE'],
      ['session', 'planner', 'estimate from stale pg_stats: 10 rows?'],
      ['session', 'storage', 'ANALYZE: sample 30,000 rows'],
      ['planner', 'planner', 'estimate again: ≈ actual'],
      ['session', 'api', 'estimates vs actuals'],
    ),
    actions: [runButton('/api/demos/statistics', 'Compare estimates', (i) => ({ rows: i.rows }))],
    pitfalls: [
      {
        mistake: 'Querying right after a bulk load without ANALYZE',
        symptom: 'EXPLAIN ANALYZE shows rows=10 estimated vs rows=99000 actual, and a nested loop that takes minutes.',
        why: 'Statistics still describe the table before the load; autovacuum\'s ANALYZE comes later.',
        fix: 'Run ANALYZE table; right after loading.',
        avoid: 'Make ANALYZE the last step of every ETL/bulk-load job (and after pg_upgrade/restore if needed).',
        reproduce: 'run',
      },
      {
        mistake: 'Ignoring correlated columns',
        symptom: 'WHERE city = … AND zip = … is estimated at 10 rows, but returns 1,000.',
        why: 'By default Postgres assumes columns are independent and multiplies their selectivities.',
        fix: 'CREATE STATISTICS … (dependencies) ON city, zip FROM places; ANALYZE places;',
        avoid: 'Add extended statistics for columns that usually appear together and depend on each other.',
        reproduce: 'run',
      },
      {
        mistake: 'Disabling autovacuum to "save resources"',
        symptom: 'Plans degrade over weeks, tables bloat, and eventually: WARNING:  database "lab" must be vacuumed within … transactions.',
        why: 'Autovacuum also refreshes statistics and prevents transaction-ID wraparound.',
        fix: 'Re-enable it; run VACUUM (ANALYZE) manually to catch up.',
        avoid: 'Tune autovacuum (scale factors, cost limits) per table instead of turning it off.',
      },
    ],
    visual: 'statistics',
  },
  {
    id: 'pg-stat-statements',
    category: CAT,
    title: 'pg_stat_statements',
    tagline: 'Which queries cost the most, in aggregate',
    description: [
      'pg_stat_statements records statistics for every distinct query shape the server runs: how often it ran, total and mean time, rows, buffer hits and reads. Constants are normalized to $1, $2, so 50 lookups with 50 different ids become one row with calls = 50. Sorting by total time tells you which query to optimize first, which is rarely the one people guess.',
      'The demo runs a small workload (many cheap primary-key lookups, fewer unindexed scans) and then reads pg_stat_statements. The bars show total time per query shape. The extension needs shared_preload_libraries = \'pg_stat_statements\' in the server configuration, which this lab sets in docker-compose.yml.',
      'A Postgres 18 detail found while building this demo: queries are now grouped by table name, so the same query against different schemas lands in one entry.',
    ],
    keyApis: ['shared_preload_libraries', 'CREATE EXTENSION pg_stat_statements', 'calls', 'total_exec_time', 'mean_exec_time', 'shared_blks_hit / read', 'pg_stat_statements_reset()'],
    useCases: ['Finding the slowest queries', 'Spotting N+1 patterns (huge calls)', 'Before/after comparisons', 'Capacity planning'],
    snippet: {
      lang: 'sql', name: 'top_queries.sql', code: `-- postgresql.conf: shared_preload_libraries = 'pg_stat_statements'  (restart)
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

SELECT query, calls,
       round(total_exec_time::numeric, 1) AS total_ms,
       round(mean_exec_time::numeric, 3)  AS mean_ms,
       rows, shared_blks_hit, shared_blks_read
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;`,
    },
    inputs: [{ name: 'calls', label: 'Primary-key lookups to run', type: 'number', default: 50, min: 10, max: 200 }],
    flow: flow('/api/demos/pg-stat-statements',
      ['api', 'session', 'workload: 3 query shapes × N'],
      ['session', 'planner', 'executor hooks record time per queryid'],
      ['api', 'session', 'SELECT … FROM pg_stat_statements'],
      ['session', 'api', 'normalized queries + totals'],
    ),
    actions: [runButton('/api/demos/pg-stat-statements', 'Run workload & read stats', (i) => ({ calls: i.calls }))],
    pitfalls: [
      {
        mistake: 'CREATE EXTENSION without shared_preload_libraries',
        symptom: 'ERROR:  pg_stat_statements must be loaded via "shared_preload_libraries"',
        why: 'The extension needs shared memory allocated at server start.',
        fix: "Set shared_preload_libraries = 'pg_stat_statements' (append to any existing list) and restart the server.",
        avoid: 'Enable it on every server from day one; the overhead is small.',
      },
      {
        mistake: 'Sorting by mean time only',
        symptom: 'You optimize a 2-second report that runs once a day, while a 3 ms query called 2 million times a day eats the CPU.',
        why: 'Impact = calls × mean time = total time.',
        fix: 'ORDER BY total_exec_time DESC first, then look at mean and calls.',
        avoid: 'Review the top 10 by total time regularly.',
        reproduce: 'run',
      },
    ],
    visual: 'pgss',
  },
];
