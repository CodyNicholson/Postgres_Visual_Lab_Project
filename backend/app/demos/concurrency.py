"""Transactions and concurrency: ACID transactions and savepoints, isolation levels and their
anomalies, row locks and lost updates, SKIP LOCKED job queues, deadlock detection, advisory
locks, and MVCC row versions with VACUUM. Each demo opens several real sessions and records a
timeline of who ran what, when, and what happened."""

from __future__ import annotations

import contextlib
import threading
import time
from typing import Any, Iterator

import psycopg
from fastapi import APIRouter

from ..db import fail, heavy, pool, run, scratch, session, value
from ..lab import Demo, clamp, error_text

router = APIRouter(prefix="/api/demos")


class Timeline:
    """Records each session's statements with start/end times (ms since the demo began)."""

    def __init__(self, d: Demo) -> None:
        self.d = d
        self.t0 = time.perf_counter()
        self.events: list[dict[str, Any]] = []
        self.lock = threading.Lock()

    def now(self) -> float:
        return round((time.perf_counter() - self.t0) * 1000, 1)

    def step(self, who: str, conn: psycopg.Connection, sql: str, params: Any = None, *, expect_error: bool = False,
             note: str | None = None) -> tuple[list[dict], str | None]:
        start = self.now()
        rows: list[dict] = []
        error = None
        try:
            if expect_error:
                error = fail(self.d, conn, sql, params, label=who)
            else:
                rows = run(self.d, conn, sql, params, label=who)
        except psycopg.Error as exc:  # a step that failed for real (serialization, deadlock, lock timeout)
            error = error_text(exc)
            self.d.command(f"[{who}] {' '.join(sql.split())}  -- -> {error.splitlines()[0]}")
        end = self.now()
        shown = None
        if rows:
            shown = ", ".join(f"{k}={v}" for k, v in rows[0].items()) if len(rows) == 1 else f"{len(rows)} rows"
        with self.lock:
            self.events.append({"who": who, "sql": " ".join(sql.split()), "start": start, "end": end,
                                "result": shown, "error": error, "note": note})
        return rows, error


@contextlib.contextmanager
def sessions(n: int, schema: str) -> Iterator[list[psycopg.Connection]]:
    """n pooled connections, each with the scratch schema first on its search_path."""
    with contextlib.ExitStack() as stack:
        conns = []
        for _ in range(n):
            conn = stack.enter_context(pool.connection())
            conn.execute(f"SET search_path = {schema}, shop, public")
            conns.append(conn)
        yield conns


@router.post("/transactions")
def transactions(amount: int = 30) -> dict:
    amount = clamp(amount, 1, 500)
    with heavy, Demo("transactions") as d, scratch(d, "tx") as schema, sessions(2, schema) as (a, b):
        tl = Timeline(d)
        run(d, a, "CREATE TABLE accounts (name text PRIMARY KEY, balance numeric NOT NULL CHECK (balance >= 0))")
        run(d, a, "INSERT INTO accounts VALUES ('alice', 100), ('bob', 50)", title="Two accounts: alice 100, bob 50")
        tl.step("A", a, "BEGIN")
        tl.step("A", a, "UPDATE accounts SET balance = balance - %s WHERE name = 'alice'", [amount])
        tl.step("A", a, "UPDATE accounts SET balance = balance + %s WHERE name = 'bob'", [amount])
        mid, _ = tl.step("B", b, "SELECT sum(balance) AS total, string_agg(name || '=' || balance, ' ') AS seen FROM accounts",
                         note="Another session sees the old, committed balances: uncommitted changes are invisible.")
        tl.step("A", a, "COMMIT")
        after_commit = run(d, b, "SELECT name, balance FROM accounts ORDER BY name", title=f"After COMMIT: {amount} moved from alice to bob")
        big = 1000
        tl.step("A", a, "BEGIN")
        tl.step("A", a, "UPDATE accounts SET balance = balance + %s WHERE name = 'bob'", [big],
                note="Credit first …")
        _, err = tl.step("A", a, "UPDATE accounts SET balance = balance - %s WHERE name = 'alice'", [big], expect_error=True,
                         note="… then the debit violates CHECK (balance >= 0)")
        _, aborted = tl.step("A", a, "SELECT 1", expect_error=True, note="Any statement after an error fails until ROLLBACK")
        tl.step("A", a, "ROLLBACK")
        after_rollback = run(d, b, "SELECT name, balance FROM accounts ORDER BY name", title="After the failed transfer: nothing changed (atomicity)")
        run(d, a, "CREATE TABLE notes (body text NOT NULL)")
        tl.step("A", a, "BEGIN")
        tl.step("A", a, "INSERT INTO notes VALUES ('first')")
        tl.step("A", a, "SAVEPOINT before_risky")
        tl.step("A", a, "INSERT INTO notes VALUES (NULL)", expect_error=True)
        tl.step("A", a, "ROLLBACK TO SAVEPOINT before_risky", note="Undo only the failed part; the transaction is usable again")
        tl.step("A", a, "INSERT INTO notes VALUES ('second')")
        tl.step("A", a, "COMMIT")
        notes = run(d, b, "SELECT body FROM notes", title="SAVEPOINT kept 'first' and 'second'")
        bal = {r["name"]: float(r["balance"]) for r in after_commit}
        d.check("Uncommitted transfer was invisible to the other session", mid and float(mid[0]["total"]) == 150 and "alice=100" in mid[0]["seen"], mid)
        d.check(f"COMMIT moved {amount} atomically (total still 150)", bal == {"alice": 100 - amount, "bob": 50 + amount} if amount <= 100 else True, bal)
        d.check("The failing debit rolled back the credit too", [float(r["balance"]) for r in after_rollback] == [bal["alice"], bal["bob"]], err)
        d.check("After an error the transaction refuses further statements", aborted and "current transaction is aborted" in aborted, aborted)
        d.check("ROLLBACK TO SAVEPOINT kept the work before it", [r["body"] for r in notes] == ["first", "second"])
        d.data.update({"timeline": tl.events, "sessions": ["A", "B"], "balances": {"afterCommit": after_commit, "afterRollback": after_rollback}})
    return d.result()


def _isolation_scenarios(d: Demo, a, b) -> list[dict]:
    scenarios = []

    def reset() -> None:
        a.execute("DROP TABLE IF EXISTS stock, doctors")
        a.execute("CREATE TABLE stock (item text PRIMARY KEY, qty int NOT NULL)")
        a.execute("INSERT INTO stock VALUES ('widget', 10)")
        a.execute("CREATE TABLE doctors (name text PRIMARY KEY, on_call boolean NOT NULL)")
        a.execute("INSERT INTO doctors VALUES ('alice', true), ('bob', true)")
        d.command("-- reset: stock(widget=10), doctors(alice, bob on call)")

    # 1. READ COMMITTED: each statement sees the latest committed data
    reset()
    tl = Timeline(d)
    tl.step("A", a, "BEGIN ISOLATION LEVEL READ COMMITTED")
    r1, _ = tl.step("A", a, "SELECT qty FROM stock WHERE item = 'widget'")
    tl.step("B", b, "UPDATE stock SET qty = 3 WHERE item = 'widget'", note="autocommit: committed at once")
    r2, _ = tl.step("A", a, "SELECT qty FROM stock WHERE item = 'widget'", note="Same query, same transaction, different answer")
    tl.step("A", a, "COMMIT")
    scenarios.append({"key": "read-committed", "title": "READ COMMITTED: non-repeatable read",
                      "summary": "The default level. Every statement takes a fresh snapshot, so a second read inside the same transaction sees B's commit.",
                      "events": tl.events, "ok": r1[0]["qty"] == 10 and r2[0]["qty"] == 3})

    # 2. REPEATABLE READ: one snapshot for the whole transaction
    reset()
    tl = Timeline(d)
    tl.step("A", a, "BEGIN ISOLATION LEVEL REPEATABLE READ")
    r1, _ = tl.step("A", a, "SELECT qty FROM stock WHERE item = 'widget'")
    tl.step("B", b, "UPDATE stock SET qty = 3 WHERE item = 'widget'")
    r2, _ = tl.step("A", a, "SELECT qty FROM stock WHERE item = 'widget'", note="Still 10: A reads from its snapshot")
    _, err = tl.step("A", a, "UPDATE stock SET qty = qty - 1 WHERE item = 'widget'",
                     note="Writing a row changed since the snapshot is refused (no lost update)")
    tl.step("A", a, "ROLLBACK")
    scenarios.append({"key": "repeatable-read", "title": "REPEATABLE READ: stable snapshot, update conflict",
                      "summary": "A keeps seeing qty = 10. When it tries to update the row B changed, Postgres aborts it with a serialization error: retry the transaction.",
                      "events": tl.events, "ok": r1[0]["qty"] == r2[0]["qty"] == 10 and bool(err and "could not serialize access due to concurrent update" in err)})

    # 3. Write skew under REPEATABLE READ (the mistake)
    reset()
    tl = Timeline(d)
    tl.step("A", a, "BEGIN ISOLATION LEVEL REPEATABLE READ")
    tl.step("B", b, "BEGIN ISOLATION LEVEL REPEATABLE READ")
    tl.step("A", a, "SELECT count(*) AS on_call FROM doctors WHERE on_call", note="2 on call, so alice may leave")
    tl.step("B", b, "SELECT count(*) AS on_call FROM doctors WHERE on_call", note="2 on call, so bob may leave")
    tl.step("A", a, "UPDATE doctors SET on_call = false WHERE name = 'alice'")
    tl.step("B", b, "UPDATE doctors SET on_call = false WHERE name = 'bob'")
    tl.step("A", a, "COMMIT")
    tl.step("B", b, "COMMIT")
    left = value(a, "SELECT count(*) FROM doctors WHERE on_call")
    tl.events.append({"who": "A", "sql": "SELECT count(*) FROM doctors WHERE on_call", "start": tl.now(), "end": tl.now(),
                      "result": f"count={left}", "error": None, "note": "Nobody is on call: the rule was broken"})
    scenarios.append({"key": "write-skew", "title": "WRONG: write skew under REPEATABLE READ",
                      "summary": "Each transaction checked the rule (at least one doctor on call) on its own snapshot and updated a different row, so both committed and the rule broke.",
                      "events": tl.events, "ok": left == 0, "mistake": True})

    # 4. SERIALIZABLE prevents it
    reset()
    tl = Timeline(d)
    tl.step("A", a, "BEGIN ISOLATION LEVEL SERIALIZABLE")
    tl.step("B", b, "BEGIN ISOLATION LEVEL SERIALIZABLE")
    tl.step("A", a, "SELECT count(*) AS on_call FROM doctors WHERE on_call")
    tl.step("B", b, "SELECT count(*) AS on_call FROM doctors WHERE on_call")
    tl.step("A", a, "UPDATE doctors SET on_call = false WHERE name = 'alice'")
    _, e1 = tl.step("B", b, "UPDATE doctors SET on_call = false WHERE name = 'bob'")
    _, e2 = tl.step("A", a, "COMMIT")
    _, e3 = tl.step("B", b, "COMMIT")
    for c in (a, b):
        if c.info.transaction_status != psycopg.pq.TransactionStatus.IDLE:
            c.execute("ROLLBACK")
    left = value(a, "SELECT count(*) FROM doctors WHERE on_call")
    err = next((e for e in (e1, e2, e3) if e), None)
    scenarios.append({"key": "serializable", "title": "SERIALIZABLE: write skew detected",
                      "summary": "Postgres tracks read/write dependencies (SSI). One of the two transactions fails with a serialization failure, so one doctor stays on call. Apps must retry on SQLSTATE 40001.",
                      "events": tl.events, "ok": left == 1 and bool(err and "could not serialize access" in err)})
    return scenarios


@router.post("/isolation")
def isolation() -> dict:
    with heavy, Demo("isolation") as d, scratch(d, "iso") as schema, sessions(2, schema) as (a, b):
        scenarios = _isolation_scenarios(d, a, b)
        for s in scenarios:
            d.check(s["title"], s["ok"], s["summary"][:90])
        d.data.update({"scenarios": scenarios, "sessions": ["A", "B"]})
    return d.result()


def _counter_race(schema: str, strategy: str, workers: int, increments: int) -> dict:
    sql = {
        "read-modify-write": ("SELECT n FROM counter WHERE id = 1", "UPDATE counter SET n = %s WHERE id = 1"),
        "select-for-update": ("SELECT n FROM counter WHERE id = 1 FOR UPDATE", "UPDATE counter SET n = %s WHERE id = 1"),
        "atomic-update": (None, "UPDATE counter SET n = n + 1 WHERE id = 1"),
    }[strategy]
    barrier = threading.Barrier(workers)
    spans: list[dict] = []
    t0 = time.perf_counter()

    def worker(i: int) -> None:
        with pool.connection() as conn:
            conn.execute(f"SET search_path = {schema}")
            conn.execute("SET synchronous_commit = off")
            barrier.wait()
            start = time.perf_counter()
            for _ in range(increments):
                with conn.transaction():
                    if sql[0]:
                        n = conn.execute(sql[0]).fetchone()["n"]
                        time.sleep(0.002)  # the app "thinks" between read and write
                        conn.execute(sql[1], [n + 1])
                    else:
                        conn.execute(sql[1])
            spans.append({"worker": i + 1, "start": round((start - t0) * 1000, 1), "end": round((time.perf_counter() - t0) * 1000, 1)})

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return {"spans": sorted(spans, key=lambda s: s["worker"]), "ms": round((time.perf_counter() - t0) * 1000, 1)}


@router.post("/row-locks")
def row_locks(workers: int = 4, increments: int = 20) -> dict:
    workers = clamp(workers, 2, 6)
    increments = clamp(increments, 5, 50)
    with heavy, Demo("row-locks") as d, scratch(d, "locks") as schema, session(schema) as conn:
        run(d, conn, "CREATE TABLE counter (id int PRIMARY KEY, n int NOT NULL)")
        d.command("SET synchronous_commit = off  -- in each worker: this demo is about locks, so skip the per-commit disk flush")
        expected = workers * increments
        races = []
        for strategy, title, how in [
            ("read-modify-write", "WRONG: read, add 1 in the app, write back", ["SELECT n FROM counter", "-- app: n = n + 1", "UPDATE counter SET n = $n"]),
            ("select-for-update", "SELECT … FOR UPDATE, then write", ["SELECT n FROM counter FOR UPDATE", "-- app: n = n + 1", "UPDATE counter SET n = $n"]),
            ("atomic-update", "Atomic UPDATE n = n + 1", ["UPDATE counter SET n = n + 1"]),
        ]:
            run(d, conn, "TRUNCATE counter; INSERT INTO counter VALUES (1, 0)")
            r = _counter_race(schema, strategy, workers, increments)
            final = value(conn, "SELECT n FROM counter WHERE id = 1")
            d.command(f"-- {workers} workers × {increments}: {' ; '.join(how)}  → n = {final} (expected {expected}, {r['ms']} ms)")
            races.append({"strategy": strategy, "title": title, "how": how, "final": final, "expected": expected, **r})
        with pool.connection() as other:
            other.execute(f"SET search_path = {schema}")
            run(d, conn, "BEGIN", label="A")
            run(d, conn, "SELECT n FROM counter WHERE id = 1 FOR UPDATE", label="A", title="Session A locks the row")
            nowait = fail(d, other, "SELECT n FROM counter WHERE id = 1 FOR UPDATE NOWAIT", label="B",
                          title="Session B: FOR UPDATE NOWAIT", note="Fail immediately instead of queueing behind A's lock.")
            skipped = run(d, other, "SELECT n FROM counter WHERE id = 1 FOR UPDATE SKIP LOCKED", label="B",
                          title="Session B: FOR UPDATE SKIP LOCKED", note="Skip rows someone else has locked (see the job-queue demo).")
            run(d, conn, "COMMIT", label="A")
        lost = expected - races[0]["final"]
        d.check("Read-modify-write in the app lost updates", lost > 0, f"{lost} of {expected} increments lost")
        d.check("SELECT … FOR UPDATE lost nothing", races[1]["final"] == expected, races[1]["final"])
        d.check("Atomic UPDATE lost nothing", races[2]["final"] == expected, races[2]["final"])
        d.check("NOWAIT failed fast and SKIP LOCKED returned nothing", nowait and "could not obtain lock on row" in nowait and skipped == [], nowait)
        d.data.update({"races": races, "workers": workers, "increments": increments})
    return d.result()


@router.post("/skip-locked")
def skip_locked(jobs: int = 24, workers: int = 3, mistake: bool = False) -> dict:
    jobs = clamp(jobs, 6, 48)
    workers = clamp(workers, 2, 6)
    with heavy, Demo("skip-locked") as d, scratch(d, "queue") as schema, session(schema) as conn:
        run(d, conn, """
            CREATE TABLE jobs (id int PRIMARY KEY, state text NOT NULL DEFAULT 'queued', runs int NOT NULL DEFAULT 0,
                               worker int, started_ms numeric, finished_ms numeric)""")
        run(d, conn, "INSERT INTO jobs (id) SELECT generate_series(1, %s)", [jobs], title=f"{jobs} queued jobs")
        claim = ("SELECT id FROM jobs WHERE state = 'queued' ORDER BY id LIMIT 1" if mistake else
                 "SELECT id FROM jobs WHERE state = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED")
        d.command(f"-- each of {workers} workers loops: BEGIN; {claim}; <work 25 ms>; UPDATE jobs SET state = 'done' …; COMMIT"
                  "  (synchronous_commit = off: this demo is about locking, not durability)")
        t0 = time.perf_counter()
        barrier = threading.Barrier(workers)
        log: list[dict] = []
        lock = threading.Lock()

        def worker(w: int) -> None:
            with pool.connection() as c:
                c.execute(f"SET search_path = {schema}")
                c.execute("SET synchronous_commit = off")
                barrier.wait()
                while True:
                    with c.transaction():
                        row = c.execute(claim).fetchone()
                        if not row:
                            return
                        start = (time.perf_counter() - t0) * 1000
                        time.sleep(0.025)  # the job's work
                        c.execute("UPDATE jobs SET state = 'done', runs = runs + 1, worker = %s, started_ms = %s, finished_ms = %s WHERE id = %s",
                                  [w, round(start, 1), round((time.perf_counter() - t0) * 1000, 1), row["id"]])
                    with lock:
                        log.append({"job": row["id"], "worker": w, "start": round(start, 1), "end": round((time.perf_counter() - t0) * 1000, 1)})

        threads = [threading.Thread(target=worker, args=(w + 1,)) for w in range(workers)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        total_ms = round((time.perf_counter() - t0) * 1000, 1)
        summary = run(d, conn, "SELECT worker, count(*) AS jobs FROM jobs GROUP BY worker ORDER BY worker", title="Jobs per worker")
        dupes = len(log) - len({e["job"] for e in log})
        done = value(conn, "SELECT count(*) FROM jobs WHERE state = 'done'")
        if mistake:
            d.check("Without row locks several workers ran the same job", dupes > 0, f"{dupes} duplicate runs of {jobs} jobs")
            d.data["mode"] = "mistake"
        else:
            d.check("Every job ran exactly once", dupes == 0 and len(log) == jobs, f"{len(log)} runs for {jobs} jobs")
            d.check("Work was spread across the workers", len(summary) == workers, summary)
            d.check("Workers ran in parallel (faster than one worker)", total_ms < jobs * 25 * 0.8, f"{total_ms} ms vs {jobs * 25} ms serial")
        d.check("All jobs ended up done", done == jobs)
        d.data.update({"log": log, "jobs": jobs, "workers": workers, "totalMs": total_ms, "duplicates": dupes})
    return d.result()


def _two_session_lock_scenario(d: Demo, schema: str, ordered: bool) -> dict:
    tl = Timeline(d)
    with pool.connection() as a, pool.connection() as b:
        for c in (a, b):
            c.execute(f"SET search_path = {schema}")
            c.execute("SET deadlock_timeout = '200ms'")
        d.command("SET deadlock_timeout = '200ms'  -- both sessions (default 1s)")
        first_b, second_b = (1, 2) if ordered else (2, 1)
        tl.step("A", a, "BEGIN")
        tl.step("B", b, "BEGIN")
        tl.step("A", a, "UPDATE accounts SET balance = balance - 10 WHERE id = 1")
        result: dict[str, Any] = {}

        def a_second() -> None:
            result["a"] = tl.step("A", a, "UPDATE accounts SET balance = balance + 10 WHERE id = 2",
                                  note="waits for B's lock on row 2" if not ordered else None)

        if ordered:
            # B wants row 1 first, so it queues behind A and never grabs row 2 out of order
            tb = threading.Thread(target=lambda: result.setdefault("b1", tl.step("B", b, "UPDATE accounts SET balance = balance - 5 WHERE id = 1",
                                                                                  note="waits for A (same order: no cycle)")))
            tb.start()
            time.sleep(0.15)
            a_second()
            tl.step("A", a, "COMMIT")
            tb.join()
            tl.step("B", b, "UPDATE accounts SET balance = balance + 5 WHERE id = 2")
            tl.step("B", b, "COMMIT")
        else:
            tl.step("B", b, "UPDATE accounts SET balance = balance - 5 WHERE id = 2")
            ta = threading.Thread(target=a_second)
            ta.start()
            time.sleep(0.1)
            _, eb1 = tl.step("B", b, "UPDATE accounts SET balance = balance + 5 WHERE id = 1",
                             note="waits for A's lock on row 1: a cycle")
            ta.join()
            ea = result["a"][1]
            for who, c, err in (("A", a, ea), ("B", b, eb1)):
                tl.step(who, c, "ROLLBACK" if err else "COMMIT")
            result["errors"] = [e for e in (ea, eb1) if e]
    return {"events": tl.events, **result}


@router.post("/deadlocks")
def deadlocks() -> dict:
    with heavy, Demo("deadlocks") as d, scratch(d, "deadlock") as schema, session(schema) as conn:
        run(d, conn, "CREATE TABLE accounts (id int PRIMARY KEY, balance int NOT NULL)")
        run(d, conn, "INSERT INTO accounts VALUES (1, 100), (2, 100)", title="Two rows: id 1 and id 2")
        bad = _two_session_lock_scenario(d, schema, ordered=False)
        run(d, conn, "UPDATE accounts SET balance = 100")
        good = _two_session_lock_scenario(d, schema, ordered=True)
        final = run(d, conn, "SELECT id, balance FROM accounts ORDER BY id", title="Final balances after the ordered run")
        errors = bad.get("errors", [])
        d.check("Opposite lock order → Postgres detected a deadlock and aborted one session",
                len(errors) == 1 and "deadlock detected" in errors[0], errors[0] if errors else "no error")
        d.check("The other session went on and committed", any(e["sql"] == "COMMIT" and not e["error"] for e in bad["events"]))
        d.check("Same lock order → the second session just waited, no deadlock",
                not any(e["error"] for e in good["events"]), f"{len(good['events'])} steps")
        d.check("Both ordered transfers applied", [r["balance"] for r in final] == [85, 115], final)
        d.data.update({"deadlock": bad["events"], "ordered": good["events"], "sessions": ["A", "B"]})
    return d.result()


@router.post("/advisory-locks")
def advisory_locks(workers: int = 4, mistake: bool = False) -> dict:
    workers = clamp(workers, 2, 6)
    with heavy, Demo("advisory-locks") as d:
        key = 7_000_000 + int(time.time() * 1000) % 1_000_000  # unique per run so visitors don't collide
        d.command(f"-- lock key {key} (an arbitrary bigint the app agrees on, e.g. hashtext('nightly-report'))")
        t0 = time.perf_counter()
        barrier = threading.Barrier(workers)
        tries: list[dict] = []
        queue: list[dict] = []
        lock = threading.Lock()

        def try_worker(w: int) -> None:
            with pool.connection() as c:
                barrier.wait()
                got = c.execute("SELECT pg_try_advisory_lock(%s) AS got", [key]).fetchone()["got"]
                start = (time.perf_counter() - t0) * 1000
                if got:
                    time.sleep(0.3)
                    c.execute("SELECT pg_advisory_unlock(%s)", [key])
                with lock:
                    tries.append({"worker": w, "got": got, "start": round(start, 1), "end": round((time.perf_counter() - t0) * 1000, 1)})

        threads = [threading.Thread(target=try_worker, args=(w + 1,)) for w in range(workers)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        d.command(f"SELECT pg_try_advisory_lock({key})  -- {workers} workers at once → {sum(t['got'] for t in tries)} got it")
        t1 = time.perf_counter()
        barrier2 = threading.Barrier(workers)

        def queue_worker(w: int) -> None:
            with pool.connection() as c:
                barrier2.wait()
                asked = (time.perf_counter() - t1) * 1000
                with c.transaction():
                    c.execute("SELECT pg_advisory_xact_lock(%s)", [key])
                    got = (time.perf_counter() - t1) * 1000
                    time.sleep(0.08)
                with lock:
                    queue.append({"worker": w, "asked": round(asked, 1), "start": round(got, 1), "end": round((time.perf_counter() - t1) * 1000, 1)})

        threads = [threading.Thread(target=queue_worker, args=(w + 1,)) for w in range(workers)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        d.command(f"BEGIN; SELECT pg_advisory_xact_lock({key}); <work 80 ms>; COMMIT  -- {workers} workers queue and run one at a time")
        queue.sort(key=lambda q: q["start"])
        overlap = any(queue[i]["start"] < queue[i - 1]["end"] - 1 for i in range(1, len(queue)))
        if mistake:
            with pool.connection() as leaky, pool.connection() as other:
                run(d, leaky, "SELECT pg_advisory_lock(%s)", [key], label="request 1", title="WRONG: session lock, never unlocked",
                    note="A request takes a session-level lock and returns without unlocking. With a connection pool the connection lives on, and so does the lock.")
                held = run(d, other, "SELECT pg_try_advisory_lock(%s) AS got", [key], label="request 2",
                           title="The next request can never get it", note="Locked until that pooled connection closes. Use pg_advisory_xact_lock or unlock in a finally block.")
                run(d, leaky, "SELECT pg_advisory_unlock_all()", label="cleanup")
            d.check("A forgotten session lock blocks everyone else", held[0]["got"] is False)
            d.data["mode"] = "mistake"
        d.check("Exactly one worker got the try-lock", sum(t["got"] for t in tries) == 1, tries)
        d.check("Blocking xact locks serialized the workers (no overlap)", not overlap and len(queue) == workers)
        d.data.update({"tries": sorted(tries, key=lambda t: t["worker"]), "queue": queue, "key": key, "workers": workers})
    return d.result()


@router.post("/mvcc")
def mvcc(rows: int = 10_000, mistake: bool = False) -> dict:
    rows = clamp(rows, 1_000, 50_000)
    with heavy, Demo("mvcc") as d, scratch(d, "mvcc") as schema, sessions(2, schema) as (conn, other):
        notices: list[str] = []
        conn.add_notice_handler(lambda diag: notices.append(diag.message_primary or ""))
        run(d, conn, "CREATE TABLE items (id int PRIMARY KEY, qty int NOT NULL, pad text) WITH (autovacuum_enabled = false)",
            title="A table with autovacuum switched off, so we control VACUUM")
        run(d, conn, "INSERT INTO items SELECT g, 0, repeat('x', 60) FROM generate_series(1, %s) g", [rows])
        run(d, conn, "CREATE TABLE tiny (id int PRIMARY KEY, qty int NOT NULL)", title="A tiny table with room to spare on its page")
        run(d, conn, "INSERT INTO tiny SELECT g, 0 FROM generate_series(1, 5) g")
        v1 = run(d, conn, "SELECT ctid, xmin, xmax, id, qty FROM tiny WHERE id = 1",
                 title="Hidden system columns of row 1", note="ctid = (page, slot) where this version lives; xmin = the transaction that created it.")
        run(d, conn, "UPDATE tiny SET qty = qty + 1 WHERE id = 1")
        run(d, conn, "UPDATE tiny SET qty = qty + 1 WHERE id = 1")
        v2 = run(d, conn, "SELECT ctid, xmin, xmax, id, qty FROM tiny WHERE id = 1",
                 title="After two UPDATEs", note="An UPDATE never overwrites: it writes a new version (new ctid, new xmin) and stamps the old one with xmax.")
        page = run(d, conn, """
            SELECT lp AS slot,
                   CASE lp_flags WHEN 1 THEN 'normal' WHEN 2 THEN 'redirect' WHEN 3 THEN 'dead' ELSE 'unused' END AS pointer,
                   t_xmin AS xmin, t_xmax AS xmax, t_ctid AS points_to
            FROM heap_page_items(get_raw_page('tiny', 0)) ORDER BY lp""",
            title="pageinspect: every slot of page 0", note="Slots 1–5 are the original rows. Row 1's old versions have xmax set and point (t_ctid) to the next version in slots 6 and 7: a HOT chain inside one page.")
        size0 = value(conn, "SELECT pg_table_size('items')")
        if mistake:
            run(d, other, "BEGIN ISOLATION LEVEL REPEATABLE READ", label="old tx")
            run(d, other, "SELECT count(*) FROM items", label="old tx", title="WRONG: a long-running transaction stays open",
                note="Its snapshot may still need the old row versions, so VACUUM must keep them.")
        run(d, conn, "UPDATE items SET qty = qty + 1", title=f"UPDATE all {rows:,} rows")
        dead1 = run(d, conn, "SELECT tuple_count, dead_tuple_count, round(dead_tuple_percent::numeric, 1) AS dead_pct FROM pgstattuple('items')",
                    title="pgstattuple: live vs dead versions")[0]
        size1 = value(conn, "SELECT pg_table_size('items')")
        notices.clear()
        run(d, conn, "VACUUM (VERBOSE) items", title="VACUUM", note="Marks dead versions' space as reusable. Doesn't shrink the file or block reads and writes.")
        vacuum_log = [line.strip() for n in notices for line in n.splitlines() if line.strip()][:10]
        dead2 = run(d, conn, "SELECT tuple_count, dead_tuple_count FROM pgstattuple('items')", title="After VACUUM")[0]
        held_back = None
        if mistake:
            held_back = dead2["dead_tuple_count"]
            run(d, other, "COMMIT", label="old tx")
            run(d, conn, "VACUUM items", title="RIGHT: end the old transaction, VACUUM again")
            dead2 = run(d, conn, "SELECT tuple_count, dead_tuple_count FROM pgstattuple('items')")[0]
            d.check("While the old transaction was open, VACUUM could not remove the dead versions",
                    held_back >= rows * 0.9, f"{held_back:,} dead versions kept")
            d.data["mode"] = "mistake"
        run(d, conn, "VACUUM FULL items", title="VACUUM FULL", note="Rewrites the table compactly and returns space to the OS, but takes an ACCESS EXCLUSIVE lock for the whole time.")
        size2 = value(conn, "SELECT pg_table_size('items')")
        d.check("UPDATE created a new row version (ctid and xmin changed)", v1[0]["ctid"] != v2[0]["ctid"] and v1[0]["xmin"] != v2[0]["xmin"],
                f"{v1[0]['ctid']} → {v2[0]['ctid']}")
        d.check("Updating every row left one dead version per row", dead1["dead_tuple_count"] >= rows * 0.9, f"{dead1['dead_tuple_count']:,} dead")
        d.check("The table roughly doubled in size", size1 > size0 * 1.6, f"{size0:,} → {size1:,} bytes")
        d.check("VACUUM removed the dead versions", dead2["dead_tuple_count"] == 0, dead2)
        d.check("VACUUM FULL shrank the file back", size2 < size1 * 0.7, f"{size1:,} → {size2:,} bytes")
        d.data.update({"rows": rows, "versions": [v1[0], v2[0]], "page": page, "sizes": [size0, size1, size2],
                       "dead": [dead1["dead_tuple_count"], held_back, dead2["dead_tuple_count"]], "vacuumLog": vacuum_log})
    return d.result()
