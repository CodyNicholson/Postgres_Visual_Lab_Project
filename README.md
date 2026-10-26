# Postgres Visual Lab

An interactive, animated tour of **PostgreSQL 18**: every kind of query and every major feature,
run for real against a live Postgres server (plus a streaming replica), with the exact SQL, a
plain-language explanation and the rows that came back, and a whole lot about how **not** to use
Postgres: 10 anti-patterns, 13 setup/connection errors and 125 feature-specific mistakes with the
exact error text Postgres 18.6 prints, 63 of which you can reproduce with one click.

## What each page shows

- **Overview & getting started**: the mental model (transactions, MVCC, WAL, planner), version
  facts, typed-out setup steps, a cheat sheet of every query type linked to its demo, pros, cons,
  when to use it and when not, alternatives, and how not to use Postgres.
- **One page per feature** (44): how it works, an animated request-flow diagram (browser →
  backend → Postgres sessions → planner → tables / WAL / replica), buttons that run the demo,
  a feature-specific animated visual, **every SQL statement the demo ran with its explanation and
  result rows** (tabs, or "Show all"), the code, common mistakes with Don't/Do code and
  "Reproduce it for real", and the commands + self-checks from the run.
- **Mistakes, errors & fixes**: everything above in one searchable page (paste an error message).
- **Run all demos**: runs every demo's self-test and marks each one ✓ / ✗.

## Quick start

```bash
docker network create tunnel-net        # once; the compose file joins this external network
cp .env.example .env                    # then set POSTGRES_PASSWORD and REPLICATION_PASSWORD (openssl rand -hex 24)
docker compose up -d --build
open http://localhost:3000
```

The first start seeds the sample data (a small shop, an employee tree, 200,000 events, articles,
food embeddings) in a few seconds.

| Service | Container | Port | Notes |
|---|---|---|---|
| `db` | `postgres-lab-db` | – (internal 5432) | `pgvector/pgvector:0.8.7-pg18-trixie` = PostgreSQL 18.6 + pgvector; `pg_stat_statements` preloaded. `docker exec -it postgres-lab-db psql -U lab` |
| `replica` | `postgres-lab-replica` | – | Hot standby cloned with `pg_basebackup`, streaming from `db` |
| `backend` | `postgres-lab-backend` | 8000 | FastAPI + psycopg 3.3 + psycopg_pool, pg_dump/pg_restore 18 |
| `frontend` | – | 3000 → 80 | unprivileged nginx serving the React build, proxies `/api/` |

## Feature coverage

| Area | Demo | Features / APIs |
|---|---|---|
| SQL queries | SELECT, WHERE, ORDER BY | WHERE with bound params, ranges, IN, LIKE/ILIKE, IS NULL vs = NULL, DISTINCT, DISTINCT ON, CASE, COALESCE, FETCH FIRST WITH TIES |
| | INSERT, UPDATE, DELETE | identity keys, multi-row INSERT, INSERT … SELECT, RETURNING, `old.`/`new.` in RETURNING (18), UPDATE … FROM |
| | Upsert & MERGE | ON CONFLICT DO NOTHING / DO UPDATE, EXCLUDED, MERGE with DELETE/UPDATE/INSERT, `merge_action()` |
| | JOINs | INNER, LEFT, RIGHT, FULL, CROSS, self, LATERAL, EXISTS / NOT EXISTS (Venn diagram from real counts) |
| | GROUP BY & aggregates | count/sum/avg/min/max, HAVING, FILTER, ROLLUP, string_agg, array_agg, percentile_cont, mode |
| | Subqueries & set operations | scalar, correlated, IN, derived tables, > ALL, UNION [ALL], INTERSECT, EXCEPT |
| | CTEs & recursive queries | WITH, WITH RECURSIVE (org chart), calendar generation, data-modifying CTE, MATERIALIZED, CYCLE |
| | Window functions | row_number/rank/dense_rank, running totals, lag, moving averages, ntile, first_value, top-N per group |
| Data types | Core types | numeric vs float, timestamptz across DST, interval, uuidv7 (18), virtual/stored generated columns (18), enum, domain, sizes |
| | JSONB | -> ->> ? @> @@, jsonb_set, jsonb_agg, JSON_TABLE (17), GIN jsonb_path_ops (proved in EXPLAIN) |
| | Arrays & range types | ANY, @>, &&, unnest, array_sort (18), ranges, range_agg, EXCLUDE USING gist, WITHOUT OVERLAPS (18) |
| | Full-text search | tsvector, websearch_to_tsquery, to_tsquery operators, ts_rank, ts_headline, weights, GIN |
| Schema & server logic | Constraints | PK, UNIQUE (NULLs), NOT NULL, CHECK, FK + CASCADE, DEFERRABLE, NOT VALID + VALIDATE |
| | Views & materialized views | views, WITH CHECK OPTION, materialized views, REFRESH … CONCURRENTLY |
| | Functions & procedures | SQL & PL/pgSQL functions, RETURNS TABLE, RAISE NOTICE/EXCEPTION, procedures with COMMIT, DO |
| | Triggers | BEFORE/AFTER row triggers, audit log, validation trigger, statement trigger with transition table |
| | Partitioning | range partitions, DEFAULT, routing, pruning in EXPLAIN, DETACH + DROP retention |
| Indexes & performance | EXPLAIN & EXPLAIN ANALYZE | plan tree from FORMAT JSON, estimates vs actuals, buffers |
| | Index types | B-tree, expression, partial, covering (INCLUDE), skip scan (18), GIN, BRIN, hash, measured before/after |
| | Planner statistics | pg_stats, stale statistics after bulk load, ANALYZE, CREATE STATISTICS (dependencies) |
| | pg_stat_statements | normalized queries, calls, total/mean time, buffers |
| Transactions & concurrency | Transactions & savepoints | BEGIN/COMMIT/ROLLBACK, visibility, atomic failure, aborted transactions, SAVEPOINT |
| | Isolation levels | READ COMMITTED, REPEATABLE READ, write skew, SERIALIZABLE (SSI) with two real sessions |
| | Row locks & lost updates | read-modify-write race, FOR UPDATE, atomic UPDATE, NOWAIT, SKIP LOCKED |
| | Job queue with SKIP LOCKED | concurrent workers, no duplicates (and duplicates without locks) |
| | Deadlocks | real deadlock detection, consistent lock order |
| | Advisory locks | pg_try_advisory_lock, pg_advisory_xact_lock, leaked session locks |
| | MVCC & VACUUM | xmin/xmax/ctid, pageinspect HOT chain, pgstattuple, bloat, VACUUM, VACUUM FULL, old snapshots |
| Security | Roles & privileges | GRANT/REVOKE, schema USAGE, column privileges, SET ROLE, ownership |
| | Row-level security | policies USING / WITH CHECK, tenant setting, owner bypass, FORCE ROW LEVEL SECURITY |
| | SQL injection | concatenation vs bound parameters, `psycopg.sql.Identifier` |
| Features & extensions | LISTEN / NOTIFY | transactional delivery, de-duplication, pg_notify from triggers, payload limit |
| | COPY & bulk loading | autocommit INSERT vs one transaction vs executemany vs unnest vs COPY, COPY TO STDOUT CSV |
| | pg_trgm | similarity, word_similarity, %, trigram GIN for LIKE '%…%' |
| | pgvector | <-> and <=> nearest neighbours, HNSW index |
| Operations | Connections & pooling | fresh connections vs psycopg_pool, PIDs, max_connections, CONNECTION LIMIT error |
| | Monitoring | pg_stat_activity, pg_cancel_backend, pg_blocking_pids, sizes, cache hit ratio, pg_stat_user_tables |
| | Safe schema migrations | lock queue behind ALTER TABLE, lock_timeout, instant vs rewriting ALTER, CREATE INDEX CONCURRENTLY |
| | Backup & restore | real pg_dump (plain + custom), pg_restore --list, DROP, restore, verification |
| | Streaming replication | real hot standby, replication lag, pg_stat_replication, read-only errors |
| Common mistakes | N+1 queries · NOT IN and NULL · OFFSET pagination · Why isn't my index used? | each wrong form next to its fix, measured |

## Architecture

```
Browser (React + Vite)
   │  POST /api/demos/<feature>
   ▼
frontend (nginx :80) ────── /api/ ──► backend (FastAPI :8000, psycopg 3 + pool, pg_dump 18)
                                           │  every run gets a private scratch schema
                                           │  run_<demo>_<hex>, dropped afterwards
                                           ▼
                                  db: PostgreSQL 18.6 (+ pgvector, pg_trgm, pg_stat_statements,
                                      btree_gist, pageinspect, pgstattuple)
                                           │  WAL stream (physical replication)
                                           ▼
                                  replica: hot standby (read-only)
```

Every demo endpoint returns a DemoResult: `commands` (the SQL that ran, with timings), `data`
(including `queries`: each statement's SQL, explanation, columns and rows, or its real error),
`checks` (what was verified) and `elapsedMs`.

## How not to use it and common errors

How not to use Postgres (details on the overview and `#pitfalls` pages):

- as a pure high-speed cache or session store;
- as a schemaless document store with one jsonb column;
- with a new connection per request or thousands of connections;
- for heavy analytics on the primary that serves the app;
- with tight polling loops instead of SKIP LOCKED + LISTEN/NOTIFY;
- with long transactions that wait on users or APIs;
- connected as a superuser or the schema owner;
- as a file store for large blobs;
- as an unpartitioned append-only log of billions of rows;
- without tested backups.

The errors people hit most (all texts captured from PostgreSQL 18.6 in this lab):

| Error | Cause | Fix | Avoid |
|---|---|---|---|
| `connection to server at "localhost" (::1), port 5432 failed: Connection refused` | localhost inside a container is the container | use the service name (`db`) | configure PGHOST |
| `FATAL:  password authentication failed for user "lab"` | wrong password, or POSTGRES_PASSWORD changed after the volume was created | `ALTER ROLE … PASSWORD` | set secrets before first start |
| `Error: in 18+, these Docker images are configured to store database data in a format which is compatible with "pg_ctlcluster"…` | volume mounted at `/var/lib/postgresql/data` | mount `/var/lib/postgresql` | read image notes before major upgrades |
| `ERROR:  current transaction is aborted, commands ignored until end of transaction block` | an earlier statement in the transaction failed | ROLLBACK (or to a savepoint) | savepoints around risky statements |
| `ERROR:  column "products.name" must appear in the GROUP BY clause or be used in an aggregate function` | ungrouped column | group or aggregate it | group by the primary key |
| `ERROR:  there is no unique or exclusion constraint matching the ON CONFLICT specification` | no unique index on the conflict target | create it | design keys first |
| `ERROR:  could not serialize access due to read/write dependencies among transactions` | SERIALIZABLE detected a conflict | retry the transaction | retry wrapper for 40001 |
| `ERROR:  deadlock detected` | opposite lock order | retry | lock rows in a consistent order |
| `ERROR:  canceling statement due to lock timeout` | migration waited behind a long transaction | retry later | `lock_timeout` in migrations |
| `ERROR:  CREATE INDEX CONCURRENTLY cannot run inside a transaction block` | migration framework wrapped it | run outside a transaction | per-framework non-atomic migration |
| `ERROR:  permission denied for schema public` | Postgres 15+ default | own schema / GRANT CREATE | app-owned schemas |
| `FATAL:  sorry, too many clients already` | connections exhausted | find leakers, add PgBouncer | small pools |
| `pg_dump: error: aborting because of server version mismatch` | older pg_dump | install postgresql-client-18 | pin client versions |
| `pg_restore: error: input file appears to be a text format dump. Please use psql.` | plain SQL dump | `psql -f` | use `--format=custom` |
| `FATAL:  recovery aborted because of insufficient parameter settings` | standby max_connections < primary | raise it on the standby | identical configs |

The `#pitfalls` page lists all 148 entries with why / fix / avoid.

Sources: [PostgreSQL 18 release notes](https://www.postgresql.org/docs/release/18.0/),
[PostgreSQL 18 documentation](https://www.postgresql.org/docs/18/),
[PostgreSQL wiki: Don't Do This](https://wiki.postgresql.org/wiki/Don%27t_Do_This),
[docker-library/postgres #1259](https://github.com/docker-library/postgres/pull/1259),
[#1370](https://github.com/docker-library/postgres/issues/1370),
[#1377](https://github.com/docker-library/postgres/issues/1377),
[pgvector README](https://github.com/pgvector/pgvector), [psycopg 3 docs](https://www.psycopg.org/psycopg3/docs/).

Found while building this lab (and now documented in the pitfalls): a standby with lower
`max_connections` refuses to start; `hot_standby_feedback = on` holds back VACUUM on the primary;
Postgres 18's pg_stat_statements groups queries by table *name*, so identical queries in
different schemas share one entry; an inlinable SQL function can slip past the "must be marked
IMMUTABLE" index check; reading a full page triggers opportunistic pruning of dead versions.

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `POSTGRES_PASSWORD` | password of the `lab` superuser; required (no fallback). Applied only when the volume is first created |
| `REPLICATION_PASSWORD` | password of the `replicator` role the replica uses (same rules) |

The database ports are not published; only the UI (3000) and API (8000) are, on `127.0.0.1` only (Docker's
iptables rules bypass `ufw`, so a bare `3000:80` would be reachable from outside).
The primary and replica sit on the internal `backend-net`, which the public nginx container cannot reach.
nginx runs unprivileged (uid 101) with all capabilities dropped, `no-new-privileges`, and memory,
CPU and process limits; the other containers have `no-new-privileges` and memory and process limits.
Every response carries `Content-Security-Policy` (same-origin only, no framing), `X-Content-Type-Options`,
`Referrer-Policy` and `Permissions-Policy` (`frontend/security-headers.conf`); the nginx version is hidden.

## Safety on the public site

Visitors never send SQL: every demo runs fixed statements, choices are allow-listed, numbers are
clamped, and text inputs (search terms) are bound parameters. Each run works in its own scratch
schema that is dropped afterwards, so visitors never see or break each other's data. Sessions
get `statement_timeout = 20s`, `lock_timeout = 10s` and `idle_in_transaction_session_timeout = 60s`;
pooled connections are reset with `DISCARD ALL`; demos that open several connections share a
small semaphore. The SQL-injection demo only concatenates three prepared payloads.

## Tests

| Layer | Command | Result (2026-10-22) |
|---|---|---|
| Backend unit tests (image build, no DB) | `docker build --target test backend` | 2 passed, 89 skipped (need a DB) |
| Backend suite against the real stack: every demo and every "Do it wrong" mode | see below | 75 passed, 16 skipped (demos without a mistake mode) |
| Frontend (Vitest): catalog completeness, every page renders, every visual renders with real captured results | `docker build --target test frontend` | 300 passed |
| Isolated stack smoke test through nginx (UI, health, all 44 demos) | isolated stack below, then GET `/`, `/api/health` and each demo's self-test | 46/46 ok |
| In-browser "Run all demos" (headless Chromium) | `#suite` page | 44 ✓, 0 ✗ |

Backend suite against the isolated stack:

```bash
docker compose -p postgres-visual-lab-project-test -f docker-compose.yml -f docker-compose.test.yml up -d --build
docker build --target test -t postgres-lab-backend-test backend
docker run --rm --network postgres-visual-lab-project-test_backend-net \
  -e PGHOST=db -e PGUSER=lab -e PGDATABASE=lab -e PGPASSWORD="$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)" -e REPLICA_HOST=replica \
  postgres-lab-backend-test python -m pytest -q
docker compose -p postgres-visual-lab-project-test -f docker-compose.yml -f docker-compose.test.yml down -v
```

Refresh the frontend's real-result fixtures after changing a demo's data shape:
`python3 -I frontend/scripts/capture-fixtures.py http://localhost:3900` (with the isolated stack up).

## Local development

```bash
docker compose up -d db replica backend
cd frontend && npm ci && npm run dev      # http://localhost:3000 (localhost only), proxies /api to :8000
```

Backend code lives in `backend/app/demos/<category>.py` (one router per category);
`backend/app/db.py` has the recorder (`run`, `fail`) and scratch-schema helpers. Frontend demo
content lives in `frontend/src/demos/<category>.js`, visuals in `frontend/src/visuals/`.

## Notes and limits

- Logical replication, synchronous replication, failover/promotion, point-in-time recovery and
  WAL archiving are explained in the pages but not run (they need more servers or long timelines).
- PgBouncer is described, not deployed; pooling is shown with psycopg_pool.
- "Too many connections" is reproduced with a per-role `CONNECTION LIMIT 2`, not by exhausting
  the shared server's `max_connections`.
- Disk-full, wraparound and out-of-memory failures are described only: reproducing them would
  take down the shared server.
- Timings are measured live inside one Docker host, so network round trips (N+1, autocommit
  inserts) look much cheaper than in production.
- PostgreSQL 19 is in beta at the time of writing; the lab pins 18.6.
