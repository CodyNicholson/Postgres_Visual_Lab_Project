import { flow, runButton, wrongButton } from './flows.js';

const CAT = 'Operations';

export const OPERATIONS_DEMOS = [
  {
    id: 'pooling',
    category: CAT,
    title: 'Connections & pooling',
    tagline: 'Each connection is a process: why pools exist, and what happens at the limit',
    description: [
      'Every Postgres connection is a separate server process with its own memory, created at connect time (fork, authentication, catalog warm-up). Opening a connection per request wastes milliseconds and, under load, runs into max_connections. A pool keeps a few connections open and lends them out; an external pooler such as PgBouncer does the same for many app instances.',
      'The demo opens fresh connections one after another and then borrows the same number from the backend\'s psycopg_pool. Compare the connect times, and the number of distinct server PIDs: fresh connections get a new process each time; the pool reuses a handful.',
      '"Do it wrong" creates a role with CONNECTION LIMIT 2 (standing in for max_connections) and opens three connections, reproducing the error apps hit when they leak connections or scale without a pool.',
    ],
    keyApis: ['max_connections', 'superuser_reserved_connections', 'pg_stat_activity', 'ConnectionPool (psycopg_pool)', 'PgBouncer pool_mode', 'CONNECTION LIMIT'],
    useCases: ['Web apps and APIs', 'Serverless functions', 'Microservices sharing a database', 'Capacity planning'],
    snippet: {
      lang: 'python', name: 'pool.py', code: `from psycopg_pool import ConnectionPool

pool = ConnectionPool("postgresql://app@db/lab", min_size=2, max_size=20, timeout=15,
                      reset=lambda c: c.execute("DISCARD ALL"))

def handler(request):
    with pool.connection() as conn:          # borrow …
        return conn.execute("SELECT …").fetchall()
                                             # … and give back, even on errors`,
    },
    inputs: [{ name: 'connections', label: 'Connections to open', type: 'number', default: 15, min: 5, max: 30 }],
    flow: flow('/api/demos/pooling',
      ['api', 'session', 'connect: TCP + auth + fork a backend'],
      ['session', 'api', 'SELECT pg_backend_pid(); close'],
      ['api', 'api', 'pool.connection(): reuse an open one'],
      ['api', 'session', 'SELECT pg_backend_pid()'],
      ['session', 'api', 'same PIDs again'],
    ),
    actions: [
      runButton('/api/demos/pooling', 'Fresh vs pooled', (i) => ({ connections: i.connections })),
      wrongButton('/api/demos/pooling', 'Hit the connection limit', (i) => ({ connections: i.connections })),
    ],
    pitfalls: [
      {
        mistake: 'Opening more connections than the server allows',
        symptom: 'FATAL:  sorry, too many clients already\n(or, per role/database: FATAL:  too many connections for role "lab_limited_…"; or FATAL:  remaining connection slots are reserved for roles with the SUPERUSER attribute)',
        why: 'Every app instance × its pool size exceeds max_connections, or connections leak (never returned to the pool).',
        fix: 'Find who holds them: SELECT application_name, state, count(*) FROM pg_stat_activity GROUP BY 1, 2; fix leaks; put PgBouncer in front.',
        avoid: 'Size pools so instances × max_size < max_connections − reserved; always use with-blocks / try-finally to return connections.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Raising max_connections into the thousands',
        symptom: 'Throughput drops and latency rises as connections grow; out-of-memory kills.',
        why: 'Each process costs memory (work_mem can be used several times per query) and contends for locks and CPU.',
        fix: 'Lower it back and use a pooler; a few dozen active connections per CPU-rich server is typical.',
        avoid: 'Pool, don\'t scale connections.',
      },
      {
        mistake: 'Session state with transaction-mode PgBouncer',
        symptom: 'SET, temp tables, LISTEN, advisory locks or prepared statements "randomly" stop working.',
        why: 'In transaction pooling each transaction may run on a different server connection.',
        fix: 'Use SET LOCAL inside transactions; for prepared statements use PgBouncer 1.21+ with max_prepared_statements.',
        avoid: 'Keep per-request state inside a single transaction.',
      },
    ],
    visual: 'pooling',
  },
  {
    id: 'monitoring',
    category: CAT,
    title: 'Monitoring & troubleshooting',
    tagline: 'pg_stat_activity, blocking chains, cancel/terminate, sizes, cache hit ratio',
    description: [
      'When "the database is slow", the first questions are: what is running right now, for how long, and what is it waiting for? pg_stat_activity answers that per connection. pg_blocking_pids(pid) shows who blocks whom. pg_cancel_backend(pid) stops a query; pg_terminate_backend(pid) ends the session.',
      'The demo starts a real 5-second query, finds it in pg_stat_activity and cancels it. Then session A updates a row and stays idle in transaction while session B tries to update the same row: the blocking view shows B waiting on A. Finally, table sizes, the cache hit ratio, and sequential vs index scans per table.',
      'Turn these into dashboards and alerts: long-running queries, idle in transaction, blocked sessions, replication lag, dead tuples and disk usage.',
    ],
    keyApis: ['pg_stat_activity', 'pg_blocking_pids()', 'pg_cancel_backend()', 'pg_terminate_backend()', 'pg_locks', 'pg_stat_database', 'pg_stat_user_tables', 'pg_total_relation_size()'],
    useCases: ['Incident response', 'Finding blockers', 'Capacity planning', 'Spotting missing indexes'],
    snippet: {
      lang: 'sql', name: 'whats_happening.sql', code: `-- What is running, longest first
SELECT pid, state, wait_event_type, wait_event, now() - query_start AS running, left(query, 80)
FROM pg_stat_activity WHERE state <> 'idle' ORDER BY query_start;

-- Who blocks whom
SELECT pid, pg_blocking_pids(pid) AS blocked_by, left(query, 60)
FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0;

SELECT pg_cancel_backend(12345);      -- stop the query
SELECT pg_terminate_backend(12345);   -- end the session`,
    },
    flow: flow('/api/demos/monitoring',
      ['api', 'session2', 'slow: SELECT pg_sleep(5)'],
      ['api', 'session', 'SELECT … FROM pg_stat_activity'],
      ['session', 'session2', 'pg_cancel_backend(pid)'],
      ['session2', 'api', 'canceling statement due to user request'],
      ['session', 'api', 'blocking chain, sizes, ratios'],
    ),
    actions: [runButton('/api/demos/monitoring', 'Find, block and cancel')],
    pitfalls: [
      {
        mistake: 'Killing sessions without knowing what they hold',
        symptom: 'FATAL:  terminating connection due to administrator command\n(on the victim\'s side), and a half-done batch job.',
        why: 'pg_terminate_backend rolls back the whole open transaction of that session.',
        fix: 'Try pg_cancel_backend first (cancels just the query); terminate idle-in-transaction blockers.',
        avoid: 'Look at state, xact_start and query in pg_stat_activity before acting.',
        reproduce: 'run',
      },
      {
        mistake: 'No statement or idle timeouts',
        symptom: 'A runaway query or a forgotten open transaction blocks everything for hours.',
        why: 'By default Postgres waits forever.',
        fix: 'Cancel/terminate the offender (see the demo).',
        avoid: "ALTER ROLE app SET statement_timeout = '30s'; SET idle_in_transaction_session_timeout = '60s'; (this lab sets both).",
      },
      {
        mistake: 'Ignoring disk usage',
        symptom: 'PANIC:  could not write to file "pg_wal/xlogtemp.…": No space left on device',
        why: 'WAL, bloat, temp files or a stuck replication slot fill the disk, and Postgres stops.',
        fix: 'Free space (drop an abandoned slot: SELECT pg_drop_replication_slot(…)), grow the volume, then investigate.',
        avoid: 'Alert on disk usage, pg_replication_slots lag and the biggest tables.',
      },
    ],
    visual: 'monitoring',
  },
  {
    id: 'migrations',
    category: CAT,
    title: 'Safe schema migrations',
    tagline: 'Lock queues, lock_timeout, instant vs rewriting ALTERs, CREATE INDEX CONCURRENTLY',
    description: [
      'Most ALTER TABLE forms need an ACCESS EXCLUSIVE lock, even if only for a moment. The trap: if any transaction is using the table, the ALTER waits, and every query that arrives after it queues behind the ALTER. One slow report plus one migration can freeze a busy table.',
      'The lanes show it for real: A holds an open transaction, B (the migration) waits for its lock, and C, a plain SELECT, gets stuck behind B. With lock_timeout = 800ms the migration gives up and C runs; retry the migration later. "Do it wrong" removes the timeout: C waits as long as A does.',
      'Also measured: adding a column with a constant default is instant (the file is unchanged), a volatile default rewrites the whole table, plain CREATE INDEX takes a SHARE lock that blocks writes, while CREATE INDEX CONCURRENTLY does not.',
    ],
    keyApis: ['lock_timeout', 'ACCESS EXCLUSIVE', 'ADD COLUMN … DEFAULT', 'CREATE INDEX CONCURRENTLY', 'NOT VALID / VALIDATE', 'pg_locks', 'pg_relation_filenode()'],
    useCases: ['Zero-downtime deploys', 'Adding columns and indexes to big tables', 'Rolling back failed migrations'],
    snippet: {
      lang: 'sql', name: 'migration.sql', code: `SET lock_timeout = '2s';           -- give up instead of freezing the table
SET statement_timeout = '15min';

ALTER TABLE users ADD COLUMN plan text NOT NULL DEFAULT 'free';   -- instant (11+)
CREATE INDEX CONCURRENTLY users_name_idx ON users (name);          -- no write lock
ALTER TABLE orders ADD CONSTRAINT orders_user_fk
  FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;            -- instant
ALTER TABLE orders VALIDATE CONSTRAINT orders_user_fk;             -- weak lock`,
    },
    flow: flow('/api/demos/migrations',
      ['api', 'session', 'A: BEGIN; SELECT … (holds ACCESS SHARE)'],
      ['api', 'session2', 'B: ALTER TABLE … (wants ACCESS EXCLUSIVE, waits)'],
      ['session2', 'storage', 'C: SELECT queues behind B'],
      ['session2', 'session2', 'lock_timeout → B gives up'],
      ['session', 'api', 'lanes + lock table'],
    ),
    actions: [runButton('/api/demos/migrations', 'Run the migration safely'), wrongButton('/api/demos/migrations', 'Without lock_timeout')],
    pitfalls: [
      {
        mistake: 'Running ALTER TABLE without lock_timeout',
        symptom: 'The app freezes during a deploy: all queries on the table pile up behind one ALTER TABLE in pg_stat_activity (wait_event = relation).',
        why: 'The ALTER waits for ACCESS EXCLUSIVE behind a long transaction, and the lock queue is first-come-first-served, so everyone waits behind it.',
        fix: 'Cancel the migration (pg_cancel_backend), let traffic drain, retry with lock_timeout.',
        avoid: "SET lock_timeout = '2s' in every migration, with automatic retries.",
        reproduce: 'mistake',
      },
      {
        mistake: 'A migration step that rewrites the whole table',
        symptom: 'ALTER TABLE takes 40 minutes under an exclusive lock.',
        why: 'Volatile defaults, most column type changes (int → bigint) and adding a STORED generated column rewrite every row.',
        fix: 'Add a nullable column, backfill in batches, then add constraints with NOT VALID + VALIDATE.',
        avoid: 'Check whether a step rewrites: compare pg_relation_filenode before/after on a copy (as this demo does).',
        reproduce: 'run',
      },
      {
        mistake: 'CREATE INDEX CONCURRENTLY inside a transaction (or migration framework that wraps one)',
        symptom: 'ERROR:  CREATE INDEX CONCURRENTLY cannot run inside a transaction block',
        why: 'CONCURRENTLY works in several transactions of its own.',
        fix: 'Run it outside a transaction (Django: atomic = False; Rails: disable_ddl_transaction!; Alembic: autocommit_block()).',
        avoid: 'If it fails midway it leaves an INVALID index: DROP INDEX CONCURRENTLY and retry.',
        reproduce: 'run',
      },
    ],
    visual: 'migrations',
  },
  {
    id: 'backup',
    category: CAT,
    title: 'Backup & restore',
    tagline: 'pg_dump, pg_restore, and the disaster in between',
    description: [
      'pg_dump makes a logical backup of a database (or a schema, or tables) as a consistent snapshot, without blocking normal reads and writes. The plain format is a SQL script you restore with psql; the custom format (-Fc) is compressed and restored with pg_restore, which can list its contents, restore selectively and run in parallel.',
      'The demo really runs pg_dump 18 against this server: a plain dump (you can see the statements it wrote) and a custom-format dump (its table of contents). Then it drops the whole schema, a simulated disaster, and restores it with pg_restore. The counters prove every row, the foreign key and the view came back.',
      'pg_dump is not the whole story: for point-in-time recovery you need physical base backups plus archived WAL (pg_basebackup, pgBackRest, Barman). And a backup you have never restored is a hope, not a backup.',
    ],
    keyApis: ['pg_dump', 'pg_dump -Fc / -Fd -j', 'pg_restore', 'pg_restore --list', 'psql -f dump.sql', 'pg_dumpall --globals-only', 'pg_basebackup', 'archive_command'],
    useCases: ['Nightly backups', 'Copying production to staging', 'Major-version upgrades', 'Restoring one table'],
    snippet: {
      lang: 'bash', name: 'backup.sh', code: `# Custom format: compressed, selective and parallel restore
pg_dump --format=custom --file=lab.dump lab
pg_restore --list lab.dump | head
pg_restore --dbname=lab --no-owner --exit-on-error lab.dump

# Plain SQL: restore with psql, not pg_restore
pg_dump --schema=shop --file=shop.sql lab
psql --single-transaction -v ON_ERROR_STOP=1 -d lab -f shop.sql

# Roles and tablespaces are cluster-wide: dump them separately
pg_dumpall --globals-only > globals.sql`,
    },
    flow: flow('/api/demos/backup',
      ['api', 'session', 'pg_dump --format custom (snapshot)'],
      ['session', 'storage', 'read every table in one consistent snapshot'],
      ['api', 'session', 'DROP SCHEMA … CASCADE'],
      ['api', 'session', 'pg_restore backup.dump'],
      ['session', 'api', 'row counts before = after'],
    ),
    actions: [runButton('/api/demos/backup', 'Dump, destroy, restore'), wrongButton('/api/demos/backup', 'pg_restore a plain dump')],
    pitfalls: [
      {
        mistake: 'pg_restore on a plain-SQL dump',
        symptom: 'pg_restore: error: input file appears to be a text format dump. Please use psql.',
        why: 'pg_restore reads only the custom, directory and tar formats.',
        fix: 'psql -d db -f dump.sql, or re-dump with --format=custom.',
        avoid: 'Standardize on -Fc (or -Fd for parallel) and name files .dump vs .sql.',
        reproduce: 'mistake',
      },
      {
        mistake: 'An older pg_dump against a newer server',
        symptom: 'pg_dump: error: aborting because of server version mismatch\npg_dump: detail: server version: 18.6 (Debian 18.6-1.pgdg13+2); pg_dump version: 17.11',
        why: 'pg_dump must understand the server\'s catalogs, so it must be at least the server\'s major version (reproduced in this lab with the postgres:17 image).',
        fix: 'Install the matching client (postgresql-client-18 from apt.postgresql.org, as this lab\'s backend image does), or run pg_dump from the server\'s image.',
        avoid: 'Pin client tools to the server\'s major version in CI and backup containers.',
      },
      {
        mistake: 'Never testing restores',
        symptom: 'The backup file exists, but the restore fails (missing roles, extensions, wrong format), or takes 10 hours.',
        why: 'Backups are only verified by restoring them.',
        fix: 'Restore into a scratch server now and measure how long it takes.',
        avoid: 'Automate a scheduled restore test; dump globals (roles) too; keep WAL archives for point-in-time recovery.',
      },
    ],
    visual: 'backup',
  },
  {
    id: 'replication',
    category: CAT,
    title: 'Streaming replication',
    tagline: 'A real hot standby: WAL shipping, replication lag, read-only replicas',
    description: [
      'Every change in Postgres is first written to the write-ahead log (WAL). Streaming replication sends that WAL to standby servers that replay it continuously, so they hold an almost up-to-date copy. A hot standby also serves read-only queries, and can be promoted to primary if the primary fails.',
      'This lab runs a second Postgres container, cloned from the primary with pg_basebackup. The demo writes heartbeats on the primary and polls the replica until each one appears: the bars are the real replication lag in milliseconds. pg_stat_replication on the primary shows the standby streaming, and a write on the replica is refused.',
      'Replication is asynchronous by default: right after a commit on the primary, the replica may not have the row yet. Read-your-own-writes needs the primary (or synchronous_commit = remote_apply).',
    ],
    keyApis: ['pg_basebackup -R', 'primary_conninfo', 'standby.signal', 'pg_stat_replication', 'pg_is_in_recovery()', 'pg_last_wal_replay_lsn()', 'synchronous_standby_names', 'pg_promote()'],
    useCases: ['High availability', 'Read scaling', 'Offloading reports', 'Zero-data-loss setups (synchronous)'],
    snippet: {
      lang: 'bash', name: 'standby.sh', code: `# On the standby (empty data dir): clone the primary and configure streaming
pg_basebackup -h primary -U replicator -D "$PGDATA" -X stream -R --progress
postgres -D "$PGDATA" -c hot_standby=on -c max_connections=120   # >= primary!

-- On the primary
SELECT application_name, state, sync_state, replay_lag FROM pg_stat_replication;
-- On the standby
SELECT pg_is_in_recovery(), pg_last_wal_replay_lsn();`,
    },
    inputs: [{ name: 'writes', label: 'Heartbeats to write', type: 'number', default: 5, min: 1, max: 10 }],
    flow: flow('/api/demos/replication',
      ['api', 'session', 'INSERT heartbeat (primary)'],
      ['session', 'wal', 'append + flush WAL'],
      ['wal', 'replica', 'walsender → walreceiver stream'],
      ['replica', 'replica', 'startup process replays WAL'],
      ['replica', 'api', 'row visible after N ms'],
    ),
    actions: [runButton('/api/demos/replication', 'Write & watch it replicate', (i) => ({ writes: i.writes }))],
    pitfalls: [
      {
        mistake: 'Standby configured with lower limits than the primary',
        symptom: 'FATAL:  recovery aborted because of insufficient parameter settings\nDETAIL:  max_connections = 100 is a lower setting than on the primary server, where its value was 120.',
        why: 'A hot standby must have max_connections, max_worker_processes, max_wal_senders, max_prepared_transactions and max_locks_per_transaction at least as high as the primary. (Hit for real while building this lab.)',
        fix: 'Raise the standby\'s settings and restart it.',
        avoid: 'Keep primary and standby configuration identical (manage it in one place).',
      },
      {
        mistake: 'Writing to a replica',
        symptom: 'ERROR:  cannot execute INSERT in a read-only transaction',
        why: 'A standby replays the primary\'s WAL and cannot accept its own writes.',
        fix: 'Route writes to the primary (a separate connection string or a proxy that knows the roles).',
        avoid: 'Use target_session_attrs=read-write in libpq connection strings for writers.',
        reproduce: 'run',
      },
      {
        mistake: 'Reading your own write from a replica',
        symptom: 'A user saves a form and the next page (served from the replica) shows the old data.',
        why: 'Asynchronous replication lags by milliseconds to seconds.',
        fix: 'Read from the primary right after writes (session stickiness), or wait for the replica to reach your commit LSN.',
        avoid: 'Decide per query whether stale reads are acceptable.',
      },
      {
        mistake: 'Abandoned replication slots or hot_standby_feedback without monitoring',
        symptom: 'The primary\'s disk fills with pg_wal files, or tables bloat because VACUUM can\'t remove dead rows.',
        why: 'A slot keeps WAL until its consumer reads it; hot_standby_feedback holds back VACUUM for the replica\'s queries (seen while building this lab).',
        fix: 'SELECT pg_drop_replication_slot(\'name\'); for dead slots; set max_slot_wal_keep_size.',
        avoid: 'Monitor pg_replication_slots (active, wal_status) and replica query durations.',
      },
    ],
    visual: 'replication',
  },
];
