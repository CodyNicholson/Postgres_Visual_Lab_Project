"""Operations: connections and pooling, monitoring (pg_stat_activity, blocking, sizes),
zero-downtime migrations and lock queues, backups with pg_dump / pg_restore, and streaming
replication to a hot standby."""

from __future__ import annotations

import os
import secrets
import subprocess
import tempfile
import threading
import time

import psycopg
from fastapi import APIRouter, HTTPException
from psycopg import sql as pgsql

from ..db import connect, fail, heavy, pool, replica_host, run, scratch, session, value
from ..lab import Demo, clamp, error_text

router = APIRouter(prefix="/api/demos")


@router.post("/pooling")
def pooling(connections: int = 15, mistake: bool = False) -> dict:
    connections = clamp(connections, 5, 30)
    with heavy, Demo("pooling") as d:
        fresh = []
        for _ in range(connections):
            started = time.perf_counter()
            with connect() as c:
                connected = time.perf_counter()
                pid = c.execute("SELECT pg_backend_pid() AS pid").fetchone()["pid"]
            fresh.append({"connectMs": round((connected - started) * 1000, 2), "totalMs": round((time.perf_counter() - started) * 1000, 2), "pid": pid})
        d.command(f"psycopg.connect() + SELECT pg_backend_pid() + close  × {connections}  -- a new server process each time")
        pooled = []
        for _ in range(connections):
            started = time.perf_counter()
            with pool.connection() as c:
                got = time.perf_counter()
                pid = c.execute("SELECT pg_backend_pid() AS pid").fetchone()["pid"]
            pooled.append({"connectMs": round((got - started) * 1000, 3), "totalMs": round((time.perf_counter() - started) * 1000, 2), "pid": pid})
        d.command(f"pool.connection() + SELECT pg_backend_pid()  × {connections}  -- borrowed from psycopg_pool")
        with session() as conn:
            limits = run(d, conn, """
                SELECT current_setting('max_connections')::int AS max_connections,
                       current_setting('superuser_reserved_connections')::int AS reserved,
                       (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend') AS client_backends,
                       (SELECT count(*) FROM pg_stat_activity WHERE application_name = 'postgres-lab') AS lab_connections,
                       (SELECT count(*) FROM pg_stat_activity WHERE state = 'idle') AS idle""",
                         title="Connection limits and what is connected now",
                         note="Every connection is a server process with its own memory. max_connections is a hard cap, so apps share a few connections through a pool (in-app, or PgBouncer in front).")
            run(d, conn, """
                SELECT backend_type, count(*) FROM pg_stat_activity GROUP BY backend_type ORDER BY count(*) DESC""",
                title="pg_stat_activity by process type", note="Besides clients: checkpointer, WAL writer, autovacuum launcher, walsender (the replica) …")
            if mistake:
                role = f"lab_limited_{secrets.token_hex(3)}"
                password = secrets.token_urlsafe(16)
                conn.execute(pgsql.SQL("CREATE ROLE {} LOGIN CONNECTION LIMIT 2 PASSWORD {}").format(pgsql.Identifier(role), pgsql.Literal(password)))
                d.command(f"CREATE ROLE {role} LOGIN CONNECTION LIMIT 2 PASSWORD '…'  -- stands in for max_connections")
                opened, error = [], None
                try:
                    for i in range(3):
                        try:
                            opened.append(psycopg.connect("", user=role, password=password, dbname=os.environ.get("PGDATABASE", "lab"), connect_timeout=5))
                            d.command(f"[client {i + 1}] connect as {role}  -- ok")
                        except psycopg.OperationalError as exc:
                            error = str(exc).strip().splitlines()[-1]
                            d.command(f"[client {i + 1}] connect as {role}  -- -> {error}")
                finally:
                    for c in opened:
                        c.close()
                    conn.execute(f"DROP ROLE IF EXISTS {role}")
                d.data["limitError"] = error
                d.check("The connection over the limit was refused", error is not None and "too many connections" in error, error)
                d.data["mode"] = "mistake"
        avg = lambda xs, k: round(sum(x[k] for x in xs) / len(xs), 3)
        d.check("A pool reuses a few server processes", len({p["pid"] for p in pooled}) < connections,
                f"{len({p['pid'] for p in pooled})} distinct PIDs for {connections} borrows")
        d.check("Every fresh connection was a new server process", len({f["pid"] for f in fresh}) == connections)
        d.check("Borrowing from the pool is much faster than connecting", avg(pooled, "connectMs") * 5 < avg(fresh, "connectMs"),
                f"{avg(pooled, 'connectMs')} ms vs {avg(fresh, 'connectMs')} ms per connection")
        d.data.update({"fresh": fresh, "pooled": pooled, "limits": limits[0], "connections": connections})
    return d.result()


@router.post("/monitoring")
def monitoring() -> dict:
    with heavy, Demo("monitoring") as d, scratch(d, "monitor") as schema, session(schema) as conn:
        tag = f"lab-slow-{secrets.token_hex(3)}"
        slow_result: dict = {}

        def slow_query() -> None:
            with pool.connection() as c:
                c.execute(f"SET application_name = '{tag}'")
                try:
                    c.execute("SELECT pg_sleep(5)")
                except psycopg.Error as exc:
                    slow_result["error"] = error_text(exc)

        t = threading.Thread(target=slow_query)
        t.start()
        time.sleep(0.4)
        active = run(d, conn, """
            SELECT pid, application_name, state, wait_event_type, wait_event,
                   round(extract(epoch FROM now() - query_start) * 1000) AS running_ms, query
            FROM pg_stat_activity WHERE application_name = %s""", [tag],
            title="pg_stat_activity: find the long-running query",
            note="state, how long it has run, what it waits for, and the query text. In production: WHERE state <> 'idle' ORDER BY query_start.")
        pid = active[0]["pid"] if active else None
        cancelled = run(d, conn, "SELECT pg_cancel_backend(%s) AS cancelled", [pid], title="pg_cancel_backend(pid)",
                        note="Cancels the current query; the connection survives. pg_terminate_backend(pid) closes the whole session.")
        t.join()

        run(d, conn, "CREATE TABLE accounts (id int PRIMARY KEY, balance int); INSERT INTO accounts VALUES (1, 100)")
        with pool.connection() as holder:
            holder.execute(f"SET search_path = {schema}")
            holder.execute(f"SET application_name = '{tag}-holder'")
            run(d, holder, "BEGIN", label="A")
            run(d, holder, "UPDATE accounts SET balance = balance + 1 WHERE id = 1", label="A")
            waiter_done: dict = {}

            def waiter() -> None:
                with pool.connection() as c:
                    c.execute(f"SET search_path = {schema}")
                    c.execute(f"SET application_name = '{tag}-waiter'")
                    started = time.perf_counter()
                    c.execute("UPDATE accounts SET balance = balance - 1 WHERE id = 1")
                    waiter_done["ms"] = round((time.perf_counter() - started) * 1000, 1)

            w = threading.Thread(target=waiter)
            w.start()
            time.sleep(0.4)
            d.command("[B] UPDATE accounts SET balance = balance - 1 WHERE id = 1  -- (in another session: blocks)")
            blocking = run(d, conn, """
                SELECT pid, application_name, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocked_by,
                       left(query, 60) AS query
                FROM pg_stat_activity WHERE application_name LIKE %s ORDER BY application_name""", [f"{tag}-%"],
                title="Who blocks whom: pg_blocking_pids()",
                note="B waits on a Lock held by A, which sits 'idle in transaction': it changed a row and never committed. The classic cause of pile-ups.")
            run(d, holder, "COMMIT", label="A")
            w.join()
        sizes = run(d, conn, """
            SELECT relname AS table, pg_total_relation_size(c.oid) AS total_bytes,
                   pg_relation_size(c.oid) AS heap_bytes, pg_indexes_size(c.oid) AS index_bytes,
                   pg_size_pretty(pg_total_relation_size(c.oid)) AS pretty
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'shop' AND c.relkind = 'r' ORDER BY total_bytes DESC""",
            title="Table and index sizes", note="pg_total_relation_size = table + indexes + TOAST.")
        health = run(d, conn, """
            SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size,
                   round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2) AS cache_hit_pct,
                   xact_commit, xact_rollback, deadlocks, temp_files
            FROM pg_stat_database WHERE datname = current_database()""",
            title="pg_stat_database: cache hit ratio, commits, deadlocks", note="A cache hit ratio well below 99% on an OLTP database hints that shared_buffers or RAM is too small.")
        run(d, conn, """
            SELECT relname AS table, seq_scan, idx_scan, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze
            FROM pg_stat_user_tables WHERE schemaname = 'shop' ORDER BY seq_scan DESC""",
            title="pg_stat_user_tables: scans and vacuum activity", note="Many seq_scans on a big table → a missing index. Many dead tuples → autovacuum is falling behind.")
        d.check("The slow query was visible as active in pg_stat_activity", active and active[0]["state"] == "active", active[0]["running_ms"] if active else None)
        d.check("pg_cancel_backend cancelled it", cancelled[0]["cancelled"] and "canceling statement due to user request" in slow_result.get("error", ""),
                slow_result.get("error"))
        holder_row = next((r for r in blocking if r["application_name"].endswith("holder")), None)
        waiter_row = next((r for r in blocking if r["application_name"].endswith("waiter")), None)
        d.check("pg_blocking_pids showed B blocked by A", waiter_row and holder_row and holder_row["pid"] in waiter_row["blocked_by"],
                waiter_row)
        d.check("A was 'idle in transaction' while holding the lock", holder_row and holder_row["state"] == "idle in transaction")
        d.check("B finished as soon as A committed", waiter_done.get("ms", 0) >= 300, f"B waited {waiter_done.get('ms')} ms")
        d.data.update({"active": active, "blocking": blocking, "sizes": sizes, "health": health[0], "waitedMs": waiter_done.get("ms")})
    return d.result()


@router.post("/migrations")
def migrations(mistake: bool = False) -> dict:
    with heavy, Demo("migrations") as d, scratch(d, "migrate") as schema, session(schema) as conn:
        run(d, conn, "CREATE TABLE users AS SELECT g AS id, 'user' || g AS name FROM generate_series(1, 100000) g")
        run(d, conn, "ALTER TABLE users ADD PRIMARY KEY (id)")
        t0 = time.perf_counter()
        ms = lambda: round((time.perf_counter() - t0) * 1000, 1)
        lanes: list[dict] = []
        timeout = "off" if mistake else "800ms"
        with pool.connection() as a, pool.connection() as b, pool.connection() as c:
            for x in (a, b, c):
                x.execute(f"SET search_path = {schema}")
            run(d, a, "BEGIN", label="A report")
            run(d, a, "SELECT count(*) FROM users", label="A report")
            lanes.append({"who": "A report", "start": ms(), "end": None, "what": "BEGIN; SELECT count(*) FROM users; … (transaction left open)", "state": "holds ACCESS SHARE"})
            result: dict = {}

            def migrate() -> None:
                start = ms()
                if timeout != "off":
                    b.execute(f"SET lock_timeout = '{timeout}'")
                else:
                    b.execute("SET lock_timeout = 0")
                try:
                    b.execute("ALTER TABLE users ADD COLUMN email text")
                    result["b"] = None
                except psycopg.Error as exc:
                    result["b"] = error_text(exc)
                lanes.append({"who": "B migration", "start": start, "end": ms(), "what": f"SET lock_timeout = '{timeout}'; ALTER TABLE users ADD COLUMN email text",
                              "state": result["b"].splitlines()[0] if result["b"] else "done (needs ACCESS EXCLUSIVE)", "error": bool(result["b"])})

            def app_query() -> None:
                start = ms()
                c.execute("SELECT name FROM users WHERE id = 42")
                lanes.append({"who": "C app", "start": start, "end": ms(), "what": "SELECT name FROM users WHERE id = 42", "state": "queued behind B"})

            tb = threading.Thread(target=migrate)
            tb.start()
            time.sleep(0.15)
            tc = threading.Thread(target=app_query)
            tc.start()
            time.sleep(0.25)
            queue = run(d, conn, """
                SELECT a.application_name, l.mode, l.granted, pg_blocking_pids(l.pid) AS blocked_by
                FROM pg_locks l JOIN pg_stat_activity a USING (pid)
                WHERE l.relation = 'users'::regclass ORDER BY l.granted DESC, a.backend_start""",
                title="pg_locks while the migration waits",
                note="A holds a weak ACCESS SHARE lock. B wants ACCESS EXCLUSIVE and queues. C's plain SELECT would be compatible with A, but it queues behind B: one slow transaction plus one migration freezes the table.")
            if mistake:
                time.sleep(1.2)  # the report keeps its transaction open; everyone else waits
                run(d, a, "COMMIT", label="A report")
                lanes[0]["end"] = ms()
                tb.join()
                tc.join()
            else:
                tb.join()
                tc.join()
                run(d, a, "COMMIT", label="A report")
                lanes[0]["end"] = ms()
        d.command(f"[B migration] SET lock_timeout = '{timeout}'; ALTER TABLE users ADD COLUMN email text  -- {result.get('b') or 'ok'}")
        c_lane = next(l for l in lanes if l["who"] == "C app")
        waited = c_lane["end"] - c_lane["start"]
        filenode = lambda: value(conn, "SELECT pg_relation_filenode('users')")
        f0 = filenode()
        run(d, conn, "ALTER TABLE users ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free'",
            title="ADD COLUMN … DEFAULT constant: instant", note="Since Postgres 11 a constant default is stored in the catalog; no table rewrite.")
        f1 = filenode()
        run(d, conn, "ALTER TABLE users ADD COLUMN token float8 DEFAULT random()",
            title="ADD COLUMN … DEFAULT volatile: full rewrite", note="random() must be computed per row, so every row is rewritten under ACCESS EXCLUSIVE.")
        f2 = filenode()
        run(d, conn, "BEGIN")
        run(d, conn, "CREATE INDEX users_name_idx ON users (name)")
        modes = run(d, conn, "SELECT mode FROM pg_locks WHERE relation = 'users'::regclass AND pid = pg_backend_pid() ORDER BY mode",
                    title="Plain CREATE INDEX holds a SHARE lock", note="SHARE blocks INSERT/UPDATE/DELETE for the whole build.")
        run(d, conn, "ROLLBACK")
        run(d, conn, "CREATE INDEX CONCURRENTLY users_name_idx ON users (name)", title="CREATE INDEX CONCURRENTLY",
            note="Takes only SHARE UPDATE EXCLUSIVE, so writes continue. Slower, can't run inside a transaction, and leaves an INVALID index if it fails (drop it and retry).")
        valid = value(conn, "SELECT indisvalid FROM pg_index WHERE indexrelid = 'users_name_idx'::regclass")
        cic_tx = fail(d, conn, "BEGIN; CREATE INDEX CONCURRENTLY users_name2_idx ON users (name); COMMIT",
                      title="CONCURRENTLY inside a transaction block is refused")
        if mistake:
            d.check("Without lock_timeout the migration waited for the old transaction", result.get("b") is None)
            d.check("…and the app's simple SELECT was stuck behind it for over a second", waited > 1000, f"C waited {waited:.0f} ms")
            d.data["mode"] = "mistake"
        else:
            d.check("lock_timeout made the migration give up", result.get("b") and "canceling statement due to lock timeout" in result["b"], result.get("b"))
            d.check("The app query waited only until the migration gave up", 200 < waited < 1500, f"C waited {waited:.0f} ms")
        d.check("C queued behind B even though A only held a weak lock",
                any(not r["granted"] and r["mode"] == "AccessExclusiveLock" for r in queue) and sum(not r["granted"] for r in queue) >= 2, queue)
        d.check("Constant default: same file; volatile default: rewritten", f0 == f1 and f2 != f1, f"filenode {f0} → {f1} → {f2}")
        d.check("Plain CREATE INDEX took a ShareLock; CONCURRENTLY produced a valid index",
                any(m["mode"] == "ShareLock" for m in modes) and valid is True and cic_tx and "cannot run inside a transaction block" in cic_tx, modes)
        d.data.update({"lanes": sorted(lanes, key=lambda l: l["who"]), "queue": queue, "lockTimeout": timeout, "filenodes": [f0, f1, f2]})
    return d.result()


def _tool(d: Demo, args: list[str], expect_fail: bool = False) -> subprocess.CompletedProcess:
    started = time.perf_counter()
    proc = subprocess.run(args, capture_output=True, text=True, timeout=60)
    elapsed = round((time.perf_counter() - started) * 1000, 1)
    outcome = "ok" if proc.returncode == 0 else f"-> exit {proc.returncode}: {proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else ''}"
    d.command(f"$ {' '.join(args)}  -- {outcome} ({elapsed} ms)")
    if proc.returncode != 0 and not expect_fail:
        raise HTTPException(status_code=500, detail=proc.stderr.strip() or f"{args[0]} failed")
    return proc


@router.post("/backup")
def backup(mistake: bool = False) -> dict:
    with heavy, Demo("backup") as d, scratch(d, "backup") as schema, session(schema) as conn, \
            tempfile.TemporaryDirectory() as tmp:
        run(d, conn, f"""
            CREATE TABLE {schema}.customers AS SELECT * FROM shop.customers;
            ALTER TABLE {schema}.customers ADD PRIMARY KEY (id);
            CREATE TABLE {schema}.orders AS SELECT * FROM shop.orders;
            ALTER TABLE {schema}.orders ADD PRIMARY KEY (id),
              ADD FOREIGN KEY (customer_id) REFERENCES {schema}.customers(id);
            CREATE VIEW {schema}.order_counts AS SELECT customer_id, count(*) FROM {schema}.orders GROUP BY 1""",
            title="Something worth backing up: two tables, a foreign key and a view")
        before = {t: value(conn, f"SELECT count(*) FROM {schema}.{t}") for t in ("customers", "orders")}
        version = _tool(d, ["pg_dump", "--version"]).stdout.strip()
        _tool(d, ["pg_dump", "--schema", schema, "--no-owner", "--file", f"{tmp}/backup.sql"])
        sql_text = open(f"{tmp}/backup.sql", encoding="utf-8").read()
        excerpt = [line for line in sql_text.splitlines() if line.startswith(("CREATE", "ALTER TABLE ONLY", "COPY", "    ADD CONSTRAINT"))][:12]
        _tool(d, ["pg_dump", "--schema", schema, "--format", "custom", "--file", f"{tmp}/backup.dump"])
        listing = _tool(d, ["pg_restore", "--list", f"{tmp}/backup.dump"]).stdout
        toc = [line for line in listing.splitlines() if line and not line.startswith(";")]
        run(d, conn, f"DROP SCHEMA {schema} CASCADE", title="Disaster: DROP SCHEMA … CASCADE",
            note="Everything in the schema is gone: tables, rows, constraints, the view.")
        gone = value(conn, "SELECT count(*) FROM pg_namespace WHERE nspname = %s", [schema])
        restore_error = None
        if mistake:
            proc = _tool(d, ["pg_restore", "--dbname", os.environ.get("PGDATABASE", "lab"), f"{tmp}/backup.sql"], expect_fail=True)
            restore_error = proc.stderr.strip()
            d.check("pg_restore refuses a plain-SQL dump", "text format dump" in restore_error, restore_error)
            d.data["mode"] = "mistake"
        _tool(d, ["pg_restore", "--dbname", os.environ.get("PGDATABASE", "lab"), "--no-owner", "--exit-on-error", f"{tmp}/backup.dump"])
        after = {t: value(conn, f"SELECT count(*) FROM {schema}.{t}") for t in ("customers", "orders")}
        view_back = value(conn, f"SELECT count(*) FROM {schema}.order_counts")
        fk = value(conn, "SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND connamespace = %s::regnamespace", [schema])
        d.check("pg_dump matches the server's major version", "18." in version, version)
        d.check("The schema was really gone after the DROP", gone == 0)
        d.check("pg_restore brought back every row", after == before, f"{before} → {after}")
        d.check("…and the view and foreign key", view_back > 0 and fk == 1)
        d.data.update({"version": version, "sqlBytes": len(sql_text.encode()), "dumpBytes": os.path.getsize(f"{tmp}/backup.dump"),
                       "excerpt": excerpt, "toc": toc[:14], "before": before, "after": after, "restoreError": restore_error})
    return d.result()


@router.post("/replication")
def replication(writes: int = 5) -> dict:
    writes = clamp(writes, 1, 10)
    with heavy, Demo("replication") as d, scratch(d, "repl") as schema, session(schema) as primary:
        try:
            standby = connect(host=replica_host(), connect_timeout=3)
        except psycopg.OperationalError as exc:
            raise HTTPException(status_code=503, detail=f"replica not reachable: {str(exc).strip()}")
        with standby:
            d.command(f"-- connected to the primary (db) and the hot standby ({replica_host()})")
            run(d, primary, "CREATE TABLE heartbeats (id int PRIMARY KEY, written_at timestamptz DEFAULT clock_timestamp())")
            role = run(d, standby, "SELECT pg_is_in_recovery() AS standby, pg_last_wal_replay_lsn()::text AS replayed_lsn",
                       label="replica", title="On the replica: pg_is_in_recovery()")
            lags = []
            first_immediate = None
            for i in range(1, writes + 1):
                run(d, primary, "INSERT INTO heartbeats (id) VALUES (%s)", [i], label="primary")
                wrote = time.perf_counter()
                polls = 0
                while True:
                    polls += 1
                    try:
                        seen = standby.execute(f"SELECT 1 FROM {schema}.heartbeats WHERE id = %s", [i]).fetchone()
                    except psycopg.errors.UndefinedTable:
                        seen = None  # the CREATE TABLE has not been replayed yet
                    if first_immediate is None:
                        first_immediate = seen is not None
                    if seen or time.perf_counter() - wrote > 5:
                        break
                    time.sleep(0.002)
                lag = round((time.perf_counter() - wrote) * 1000, 2)
                lags.append({"id": i, "lagMs": lag, "polls": polls, "seen": seen is not None})
                d.command(f"[replica] SELECT 1 FROM heartbeats WHERE id = {i}  -- visible after {lag} ms ({polls} polls)")
            stat = run(d, primary, """
                SELECT application_name, client_addr::text, state, sync_state,
                       sent_lsn::text, replay_lsn::text,
                       pg_wal_lsn_diff(sent_lsn, replay_lsn) AS replay_gap_bytes, replay_lag::text
                FROM pg_stat_replication""", label="primary", title="On the primary: pg_stat_replication",
                note="One row per connected standby: streaming state, how far it has received and replayed the WAL, and its lag.")
            write_err = fail(d, standby, f"INSERT INTO {schema}.heartbeats (id) VALUES (999)", label="replica",
                             title="Write on the replica", note="A hot standby is read-only. Send writes to the primary.")
            count = value(standby, f"SELECT count(*) FROM {schema}.heartbeats")
        d.check("The replica reports it is in recovery (standby)", role[0]["standby"] is True)
        d.check(f"All {writes} writes became visible on the replica", all(l["seen"] for l in lags) and count == writes,
                f"lag {min(l['lagMs'] for l in lags)}–{max(l['lagMs'] for l in lags)} ms")
        d.check("pg_stat_replication shows a streaming standby", stat and stat[0]["state"] == "streaming", stat[0] if stat else None)
        d.check("Writes on the replica are rejected", write_err and "read-only transaction" in write_err, write_err)
        d.data.update({"lags": lags, "stat": stat[0] if stat else None, "immediateRead": first_immediate, "writes": writes})
    return d.result()
