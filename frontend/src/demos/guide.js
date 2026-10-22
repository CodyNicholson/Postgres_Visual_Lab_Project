// The overview page: what Postgres is, how to start a project with it (typed out in an animated
// terminal), and an honest pros / cons / when-to-use comparison. antiPatterns and troubleshooting
// also feed the #pitfalls page, next to every demo's own pitfalls.

export const OVERVIEW = {
  title: 'PostgreSQL in one page',
  intro: 'PostgreSQL ("Postgres") is an open-source relational database: you store data in tables with typed columns, describe what you want in SQL, and Postgres works out how to get it, safely, while many clients read and write at once. Its mental model: every change happens in a transaction, every row change creates a new row version (MVCC) so readers never block writers, every change is first written to the write-ahead log (WAL) for crash safety and replication, and a cost-based planner turns each query into a plan of scans and joins.',
  facts: [
    ['Version in this lab', 'PostgreSQL 18.6'],
    ['Released', '18.0: Sept 2025 · 19 in beta'],
    ['License', 'PostgreSQL License (MIT-like)'],
    ['Written in', 'C'],
    ['Extensions here', 'pgvector 0.8.7, pg_trgm, pg_stat_statements, btree_gist, pageinspect, pgstattuple'],
  ],
  steps: [
    {
      title: 'Run a server',
      text: 'The quickest start is the official Docker image. In Postgres 18+ images the data lives in /var/lib/postgresql/18/docker, so mount the parent directory.',
      commands: [
        'docker run -d --name pg -e POSTGRES_PASSWORD=secret -p 5432:5432 \\',
        '  -v pgdata:/var/lib/postgresql postgres:18',
        'docker exec -it pg psql -U postgres',
      ],
    },
    {
      title: 'Create a database, a role and a table',
      text: 'Give the application its own database and a login role that owns its schema. Use lower_snake_case names, identity keys, text and timestamptz.',
      file: {
        name: 'setup.sql', lang: 'sql', code: `CREATE ROLE app LOGIN PASSWORD 'change-me';
CREATE DATABASE shop OWNER app;
\\c shop app

CREATE TABLE customers (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO customers (email, name) VALUES ('ada@example.com', 'Ada') RETURNING id;`,
      },
    },
    {
      title: 'Connect from code',
      text: 'Use a maintained driver, bound parameters and a connection pool. Python with psycopg 3, as this lab\'s backend does:',
      commands: ['pip install "psycopg[binary]" psycopg-pool'],
      file: {
        name: 'app.py', lang: 'python', code: `from psycopg_pool import ConnectionPool

pool = ConnectionPool("postgresql://app:change-me@localhost/shop", max_size=10)

with pool.connection() as conn:
    row = conn.execute("SELECT id, name FROM customers WHERE email = %s",
                       ["ada@example.com"]).fetchone()
    print(row)`,
      },
    },
    {
      title: 'Look before you optimize',
      text: 'Turn on pg_stat_statements, use EXPLAIN (ANALYZE, BUFFERS) on slow queries, add indexes for what you measured, and keep autovacuum on.',
      commands: [
        "psql -c \"ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements'\"",
        'docker restart pg',
        'psql -c "CREATE EXTENSION pg_stat_statements"',
      ],
    },
  ],
  pros: [
    'Correct and safe by default: ACID transactions, transactional DDL, real constraints, crash recovery through the WAL.',
    'Very broad SQL: CTEs and recursion, window functions, MERGE, JSON_TABLE, lateral joins, full-text search, ranges, arrays.',
    'Extensible: custom types, functions in many languages, and extensions such as pgvector, PostGIS, TimescaleDB, pg_trgm.',
    'One database for many jobs: relational data, documents (jsonb), search, queues (SKIP LOCKED), pub/sub, vectors.',
    'Excellent concurrency: MVCC means readers and writers don\'t block each other; SERIALIZABLE is real (SSI).',
    'Open source with a permissive license, no vendor lock-in, and every major cloud offers it as a managed service.',
  ],
  cons: [
    'MVCC needs VACUUM: updates leave dead row versions, and long transactions or neglected autovacuum cause bloat.',
    'A process per connection: hundreds of connections need a pooler such as PgBouncer.',
    'Scaling writes beyond one primary is not built in (sharding needs Citus or the application).',
    'Major-version upgrades need pg_upgrade, dump/restore or logical replication, with planning.',
    'Many knobs: defaults are conservative (shared_buffers, work_mem), so serious workloads need tuning.',
    'Some features have sharp edges: NOT IN with NULL, timestamp vs timestamptz, quoted identifiers, lock queues during migrations.',
  ],
  whenToUse: [
    'Your data has structure and relationships, and correctness matters (orders, accounts, inventory, bookings).',
    'You want one dependable database for OLTP plus reporting, search, JSON and moderate analytics.',
    'You need strong consistency, constraints and transactions across many tables.',
    'You want to add vector search (pgvector) or geospatial (PostGIS) next to existing relational data.',
  ],
  whenNotToUse: [
    'Petabyte-scale analytics over huge fact tables: a columnar warehouse (ClickHouse, BigQuery, Snowflake, DuckDB) is far faster.',
    'Write throughput beyond one big server with no natural sharding key, unless you adopt Citus or similar.',
    'A pure cache or session store with sub-millisecond latency: Redis or Memcached.',
    'Massive append-only time series with heavy retention rules, unless you add TimescaleDB or partitioning.',
  ],
  alternatives: [
    ['MySQL / MariaDB', 'Also relational and popular; simpler replication setups, fewer SQL features (no partial indexes, weaker CHECK history), different locking behaviour.'],
    ['SQLite', 'An embedded database in a single file: perfect for apps, tests and edge devices; one writer at a time and no network server.'],
    ['Oracle / SQL Server', 'Commercial relational databases with similar features, plus vendor tooling and licensing costs.'],
    ['MongoDB', 'Document database: flexible schema and easy horizontal sharding; joins, constraints and multi-document transactions are weaker.'],
    ['CockroachDB / YugabyteDB', 'Distributed SQL with the Postgres wire protocol: horizontal scaling and multi-region, with higher latency and fewer extensions.'],
    ['ClickHouse / DuckDB', 'Columnar analytics engines: aggregations over billions of rows in seconds; not for transactional workloads.'],
  ],
  // Every kind of query this lab demonstrates, at a glance, with the demo that runs it for real.
  cheatsheet: [
    ['Read rows', 'SELECT … FROM … WHERE … ORDER BY … LIMIT', 'select'],
    ['Top row per group', 'SELECT DISTINCT ON (category) …', 'select'],
    ['Insert / update / delete', 'INSERT … RETURNING · UPDATE … FROM · DELETE … USING', 'dml'],
    ['Upsert', 'INSERT … ON CONFLICT (key) DO UPDATE SET … EXCLUDED', 'upsert'],
    ['Sync a table', 'MERGE INTO t USING s ON … WHEN MATCHED … WHEN NOT MATCHED …', 'upsert'],
    ['Combine tables', 'INNER / LEFT / RIGHT / FULL / CROSS / LATERAL JOIN', 'joins'],
    ['"Has any" / "has none"', 'WHERE EXISTS (…) · WHERE NOT EXISTS (…)', 'joins'],
    ['Summaries', 'GROUP BY … HAVING · count(*) FILTER (WHERE …) · ROLLUP', 'aggregates'],
    ['Nested queries', 'scalar / correlated / derived-table subqueries', 'subqueries'],
    ['Set operations', 'UNION [ALL] · INTERSECT · EXCEPT', 'subqueries'],
    ['Step-by-step queries', 'WITH a AS (…), b AS (…) SELECT …', 'ctes'],
    ['Trees and graphs', 'WITH RECURSIVE … UNION ALL … CYCLE', 'ctes'],
    ['Running totals, rankings', 'sum() OVER (ORDER BY …) · row_number() OVER (PARTITION BY …)', 'windows'],
    ['Documents', "attrs @> '{\"color\": \"black\"}' · JSON_TABLE(…)", 'jsonb'],
    ['Arrays and periods', "'usb' = ANY(tags) · during && tstzrange(…) · EXCLUDE USING gist", 'arrays-ranges'],
    ['Text search', "search @@ websearch_to_tsquery('english', $1)", 'fulltext'],
    ['Fuzzy search', 'word_similarity($1, name) · LIKE \'%x%\' with gin_trgm_ops', 'trigram'],
    ['Similarity search', 'ORDER BY embedding <-> $1 LIMIT k', 'vector'],
    ['Query plans', 'EXPLAIN (ANALYZE, BUFFERS) …', 'explain'],
    ['Transactions', 'BEGIN · SAVEPOINT · ROLLBACK TO · COMMIT', 'transactions'],
    ['Locking reads', 'SELECT … FOR UPDATE [NOWAIT | SKIP LOCKED]', 'row-locks'],
    ['Bulk load / export', 'COPY … FROM STDIN · COPY (query) TO STDOUT CSV', 'copy'],
    ['Pub/sub', "LISTEN ch · NOTIFY ch, 'payload'", 'listen-notify'],
    ['Pagination', 'WHERE id > $last ORDER BY id LIMIT 20', 'pagination'],
  ],
  // How NOT to use Postgres: misuses of the tool as a whole (wrong job, wrong architecture).
  antiPatterns: [
    {
      dont: 'Using it as a pure high-speed cache or session store',
      why: 'Every write is durable (WAL, fsync) and creates a row version that VACUUM must clean up; millions of tiny updates per minute mean bloat and I/O, not microsecond latency.',
      instead: 'Use Redis/Memcached for ephemeral hot data; if it must be Postgres, use UNLOGGED tables and accept losing them on a crash.',
    },
    {
      dont: 'Treating it as a schemaless document store (one jsonb column for everything)',
      why: 'You lose types, constraints, foreign keys and per-column statistics, and every small change rewrites the whole document.',
      instead: 'Real columns for known structure, jsonb for the genuinely variable rest (see the JSONB demo).',
    },
    {
      dont: 'Opening a new connection per request, or thousands of connections',
      why: 'Each connection is a process; connect costs milliseconds, and too many active backends thrash memory and CPU, then hit "sorry, too many clients already".',
      instead: 'Use a pool in the app and PgBouncer between many app instances and the server (see Connections & pooling).',
    },
    {
      dont: 'Running heavy analytics on the primary that serves your app',
      why: 'Hour-long reports compete for CPU and I/O, hold back VACUUM with their old snapshots and can block migrations.',
      instead: 'Run reports on a read replica, a materialized view, or export to a columnar warehouse.',
    },
    {
      dont: 'Polling a table in a tight loop for new work',
      why: 'SELECT … WHERE state = \'queued\' every 10 ms from 50 workers burns CPU and fills pg_stat_statements.',
      instead: 'Use SKIP LOCKED workers woken up by LISTEN/NOTIFY, with a slow fallback poll.',
    },
    {
      dont: 'Long transactions that wait on users or external APIs',
      why: 'They hold locks and their snapshot keeps VACUUM from removing dead rows anywhere in the database.',
      instead: 'Do the slow work outside the transaction; keep transactions to milliseconds; set idle_in_transaction_session_timeout.',
    },
    {
      dont: 'Letting the app connect as a superuser or the schema owner',
      why: 'A single SQL injection can drop everything, and row-level security is bypassed for owners and superusers.',
      instead: 'A least-privilege runtime role, a separate owner role for migrations (see Roles and RLS).',
    },
    {
      dont: 'Storing large files (images, videos, PDFs) in bytea or large objects',
      why: 'Backups, replication and VACUUM all slow down, and the database becomes an expensive file server.',
      instead: 'Store files in object storage (S3 and similar) and keep their key and metadata in Postgres.',
    },
    {
      dont: 'Using it as an append-only log of billions of rows without a plan',
      why: 'One giant table makes VACUUM, indexes and retention (DELETE … WHERE created_at < …) slow and bloaty.',
      instead: 'Partition by time and drop old partitions (see Partitioning), or use TimescaleDB.',
    },
    {
      dont: 'Skipping backups, or never testing a restore',
      why: 'Replication copies mistakes (a DROP TABLE replicates in milliseconds); an untested backup is a guess.',
      instead: 'Point-in-time recovery (pgBackRest, Barman, WAL archiving) plus regular restore drills (see Backup & restore).',
    },
  ],
  // Errors people hit outside any single feature: install, connection, auth, config, version upgrades.
  troubleshooting: [
    {
      mistake: 'Connecting to localhost from inside a Docker container',
      symptom: 'psql: error: connection to server at "localhost" (::1), port 5432 failed: Connection refused\n\tIs the server running on that host and accepting TCP/IP connections?',
      why: 'Inside a container, localhost is the container itself, not the database container or the host.',
      fix: 'Use the compose service name (host=db, as this lab does), or host.docker.internal for a database on the host. Also check that the server listens on that address (listen_addresses).',
      avoid: 'Configure the host through an environment variable (PGHOST) and never hard-code localhost in containerized apps.',
    },
    {
      mistake: 'psql with no host when the server is not local',
      symptom: 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory\n\tIs the server running locally and accepting connections on that socket?',
      why: 'Without -h, libpq connects through the local Unix socket, which only exists on the server\'s machine/container.',
      fix: 'psql -h <host> -U <user> -d <db>, or docker exec -it <container> psql -U <user>.',
      avoid: 'Use full connection strings: postgresql://user@host:5432/db.',
    },
    {
      mistake: 'Wrong password (or the volume kept an old one)',
      symptom: 'psql: error: connection to server at "db" (172.31.0.2), port 5432 failed: FATAL:  password authentication failed for user "lab"',
      why: 'The password is wrong, the role does not exist (Postgres reports both the same way), or POSTGRES_PASSWORD was changed after the data volume was created: the image only applies it on first initialization.',
      fix: 'ALTER ROLE lab PASSWORD \'…\'; as a superuser (docker exec … psql), or recreate the volume if the data is disposable.',
      avoid: 'Keep secrets in .env, set them before first start, and change them with ALTER ROLE afterwards.',
    },
    {
      mistake: 'Connecting to a database that does not exist',
      symptom: 'FATAL:  database "nosuchdb" does not exist',
      why: 'If you don\'t name a database, libpq uses one named like your user; or POSTGRES_DB was not set on first start.',
      fix: 'CREATE DATABASE nosuchdb; or connect with -d postgres to see what exists (\\l).',
      avoid: 'Always pass the database name explicitly.',
    },
    {
      mistake: 'Starting the official image without a password',
      symptom: 'Error: Database is uninitialized and superuser password is not specified.\n       You must specify POSTGRES_PASSWORD to a non-empty value for the\n       superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".',
      why: 'The image refuses to create a database whose superuser has no password.',
      fix: 'Set POSTGRES_PASSWORD (this lab defaults it from .env).',
      avoid: 'Never use POSTGRES_HOST_AUTH_METHOD=trust outside throwaway local tests.',
    },
    {
      mistake: 'Mounting /var/lib/postgresql/data with the Postgres 18+ image',
      symptom: 'Error: in 18+, these Docker images are configured to store database data in a\n       format which is compatible with "pg_ctlcluster" (specifically, using\n       major-version-specific directory names). …\n       Counter to that, there appears to be PostgreSQL data in:\n         /var/lib/postgresql/data (unused mount/volume)',
      why: 'Since 18, PGDATA is /var/lib/postgresql/18/docker and the declared volume is /var/lib/postgresql. Old compose files mount the old path (and an upgraded image finds 17.x data there).',
      fix: 'Mount the volume at /var/lib/postgresql. To move existing data to 18, use pg_upgrade or dump and restore; never just bump the image tag.',
      avoid: 'Read the image release notes before changing major versions (docker-library/postgres#1259).',
    },
    {
      mistake: 'Creating objects in public on Postgres 15+',
      symptom: 'ERROR:  permission denied for schema public',
      why: 'Since Postgres 15 only the database owner can create in public by default.',
      fix: 'CREATE SCHEMA app AUTHORIZATION app_role; (or GRANT CREATE ON SCHEMA public TO app_role).',
      avoid: 'Make the app role own its database or schema.',
    },
    {
      mistake: 'Running out of connections',
      symptom: 'FATAL:  sorry, too many clients already',
      why: 'max_connections (100 by default) is exhausted: too many app instances × pool size, or leaked connections.',
      fix: 'SELECT application_name, state, count(*) FROM pg_stat_activity GROUP BY 1, 2; terminate idle leakers; reduce pool sizes.',
      avoid: 'PgBouncer in front, small pools, and timeouts for idle sessions.',
    },
    {
      mistake: 'Using pg_dump older than the server',
      symptom: 'pg_dump: error: aborting because of server version mismatch\npg_dump: detail: server version: 18.6 (Debian 18.6-1.pgdg13+2); pg_dump version: 17.11',
      why: 'Distro packages often ship an older client than the server.',
      fix: 'Install postgresql-client-18 from apt.postgresql.org (as this lab\'s backend Dockerfile does) or run pg_dump inside the server image.',
      avoid: 'Pin client tool versions to the server major version.',
    },
    {
      mistake: 'Comparing values of different types',
      symptom: 'ERROR:  operator does not exist: integer = text\nHINT:  No operator matches the given name and argument types. You might need to add explicit type casts.',
      why: 'Postgres has no implicit casts between text and numbers in comparisons (since 8.3).',
      fix: 'Cast the parameter, not the column: WHERE id = $1::int; fix columns that store numbers as text.',
      avoid: 'Keep join and foreign-key columns the same type.',
    },
    {
      mistake: 'Creating roles with MD5 passwords on Postgres 18',
      symptom: 'WARNING:  setting an MD5-encrypted password\nDETAIL:  MD5 password support is deprecated and will be removed in a future release of PostgreSQL.',
      why: 'MD5 password authentication is deprecated in 18; scram-sha-256 is the default.',
      fix: "SET password_encryption = 'scram-sha-256'; ALTER ROLE … PASSWORD '…'; and switch pg_hba.conf entries from md5 to scram-sha-256.",
      avoid: 'Use scram-sha-256 everywhere; update old drivers that can\'t speak SCRAM.',
    },
    {
      mistake: 'Small /dev/shm in Docker',
      symptom: 'ERROR:  could not resize shared memory segment "/PostgreSQL.…" to … bytes: No space left on device',
      why: 'Parallel queries use dynamic shared memory in /dev/shm, which Docker limits to 64 MB by default.',
      fix: 'Give the container more: shm_size: 256m in compose (as this lab does) or --shm-size.',
      avoid: 'Set shm_size for every Postgres container that runs parallel queries.',
    },
    {
      mistake: 'Upgrading by swapping the binaries or image tag',
      symptom: 'FATAL:  database files are incompatible with server\nDETAIL:  The data directory was initialized by PostgreSQL version 17, which is not compatible with this version 18.6 (Debian 18.6-1.pgdg13+2).',
      why: 'The on-disk format changes between major versions.',
      fix: 'Go back to the old image, then upgrade with pg_upgrade (both versions installed), dump/restore, or logical replication.',
      avoid: 'Pin the major version in your image tag (postgres:18, not postgres:latest).',
    },
  ],
};
