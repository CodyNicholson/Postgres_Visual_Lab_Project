"""Schema and server-side logic: constraints, views and materialized views, functions and
procedures (SQL and PL/pgSQL), triggers, and declarative partitioning. Everything runs in a
private scratch schema."""

from __future__ import annotations

from fastapi import APIRouter

from ..db import fail, run, scratch, session, value
from ..lab import Demo, clamp

router = APIRouter(prefix="/api/demos")


@router.post("/constraints")
def constraints() -> dict:
    with Demo("constraints") as d, scratch(d, "constraints") as schema, session(schema) as conn:
        run(d, conn, """
            CREATE TABLE authors (
              id    integer PRIMARY KEY,
              email text NOT NULL UNIQUE
            );
            CREATE TABLE books (
              id        integer PRIMARY KEY,
              author_id integer NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
              title     text NOT NULL,
              pages     integer CHECK (pages > 0),
              isbn      text UNIQUE
            )""", title="Constraints declared on the tables",
            note="PRIMARY KEY = UNIQUE + NOT NULL. REFERENCES is a foreign key; ON DELETE CASCADE deletes a writer's books with the writer. CHECK is any boolean rule.")
        run(d, conn, "INSERT INTO authors VALUES (1, 'ada@x.io'), (2, 'grace@x.io')")
        run(d, conn, "INSERT INTO books VALUES (10, 1, 'Notes', 40, '111'), (11, 2, 'COBOL', 300, '222'), (12, 2, 'Compilers', 250, NULL)",
            title="Valid rows go in")
        results = {}
        for key, title, sql in [
            ("pk", "PRIMARY KEY: duplicate id", "INSERT INTO authors VALUES (1, 'other@x.io')"),
            ("unique", "UNIQUE: duplicate email", "INSERT INTO authors VALUES (3, 'ada@x.io')"),
            ("notnull", "NOT NULL: missing title", "INSERT INTO books (id, author_id, title) VALUES (13, 1, NULL)"),
            ("check", "CHECK: zero pages", "INSERT INTO books VALUES (13, 1, 'Empty', 0, NULL)"),
            ("fk", "FOREIGN KEY: author 99 doesn't exist", "INSERT INTO books VALUES (13, 99, 'Ghost', 10, NULL)"),
        ]:
            results[key] = fail(d, conn, sql, title=title)
        run(d, conn, "INSERT INTO books VALUES (13, 1, 'Second NULL isbn', 10, NULL)", title="UNIQUE allows many NULLs",
            note="NULLs are not equal to each other, so two NULL isbns don't clash. Add NULLS NOT DISTINCT (Postgres 15+) to forbid that.")
        cascaded = run(d, conn, "DELETE FROM authors WHERE id = 2 RETURNING id", title="ON DELETE CASCADE")
        left = value(conn, "SELECT count(*) FROM books WHERE author_id = 2")
        run(d, conn, "CREATE TABLE seats_strict (id int PRIMARY KEY, pos int UNIQUE); INSERT INTO seats_strict VALUES (1, 1), (2, 2)")
        swap_fail = fail(d, conn, "UPDATE seats_strict SET pos = 3 - pos", title="Swapping two UNIQUE values: plain UNIQUE",
                         note="A plain UNIQUE constraint is checked row by row, so the moment row 1 becomes pos 2 it clashes with row 2.")
        run(d, conn, "CREATE TABLE seats (id int PRIMARY KEY, pos int UNIQUE DEFERRABLE INITIALLY IMMEDIATE); INSERT INTO seats VALUES (1, 1), (2, 2)")
        with conn.transaction():
            run(d, conn, "SET CONSTRAINTS ALL DEFERRED", title="DEFERRABLE: check at COMMIT",
                note="A deferred constraint is checked at COMMIT, so a transaction may pass through an invalid state while it swaps two positions.")
            run(d, conn, "UPDATE seats SET pos = 2 WHERE id = 1")
            run(d, conn, "UPDATE seats SET pos = 1 WHERE id = 2")
        swapped = run(d, conn, "SELECT id, pos FROM seats ORDER BY id")
        run(d, conn, "ALTER TABLE books ADD CONSTRAINT short_title CHECK (length(title) < 40) NOT VALID",
            title="NOT VALID, then VALIDATE",
            note="On a big table, add the constraint NOT VALID (instant, checks only new rows), then VALIDATE CONSTRAINT later with a weaker lock.")
        run(d, conn, "ALTER TABLE books VALIDATE CONSTRAINT short_title")
        d.check("PRIMARY KEY rejected a duplicate", results["pk"] and "duplicate key value violates unique constraint" in results["pk"], results["pk"])
        d.check("UNIQUE rejected a duplicate email", results["unique"] and "authors_email_key" in results["unique"], results["unique"])
        d.check("NOT NULL rejected a missing title", results["notnull"] and "violates not-null constraint" in results["notnull"], results["notnull"])
        d.check("CHECK rejected pages = 0", results["check"] and "violates check constraint" in results["check"], results["check"])
        d.check("FOREIGN KEY rejected an unknown author", results["fk"] and "violates foreign key constraint" in results["fk"], results["fk"])
        d.check("ON DELETE CASCADE removed the writer's books too", cascaded and left == 0)
        d.check("Deferred UNIQUE allowed swapping positions inside one transaction",
                [(r["id"], r["pos"]) for r in swapped] == [(1, 2), (2, 1)], swapped)
        d.check("Plain UNIQUE failed the same swap", swap_fail and "duplicate key" in swap_fail, swap_fail)
        d.data["results"] = results
    return d.result()


@router.post("/views")
def views(mistake: bool = False) -> dict:
    with Demo("views") as d, scratch(d, "views") as schema, session(schema) as conn:
        run(d, conn, "CREATE TABLE sales AS SELECT o.id, o.customer_id, o.status, oi.qty * oi.unit_price AS amount FROM shop.orders o JOIN shop.order_items oi ON oi.order_id = o.id")
        run(d, conn, """
            CREATE VIEW revenue_by_status AS
            SELECT status, count(*) AS lines, sum(amount) AS revenue FROM sales GROUP BY status""",
            title="CREATE VIEW", note="A view is a saved query. It stores no data: every SELECT re-runs it, so it is always current.")
        run(d, conn, """
            CREATE MATERIALIZED VIEW revenue_snapshot AS
            SELECT status, count(*) AS lines, sum(amount) AS revenue FROM sales GROUP BY status""",
            title="CREATE MATERIALIZED VIEW", note="A materialized view stores the result like a table: fast to read, but stale until refreshed.")
        before = {
            "table": value(conn, "SELECT sum(amount) FROM sales"),
            "view": value(conn, "SELECT sum(revenue) FROM revenue_by_status"),
            "matview": value(conn, "SELECT sum(revenue) FROM revenue_snapshot"),
        }
        run(d, conn, "INSERT INTO sales VALUES (99999, 1, 'paid', 5000.00)", title="New sale of 5,000 arrives")
        after = {
            "table": value(conn, "SELECT sum(amount) FROM sales"),
            "view": value(conn, "SELECT sum(revenue) FROM revenue_by_status"),
            "matview": value(conn, "SELECT sum(revenue) FROM revenue_snapshot"),
        }
        run(d, conn, "SELECT * FROM revenue_by_status ORDER BY status", title="The view sees it immediately")
        run(d, conn, "SELECT * FROM revenue_snapshot ORDER BY status", title="The materialized view is stale")
        if mistake:
            e = fail(d, conn, "REFRESH MATERIALIZED VIEW CONCURRENTLY revenue_snapshot", label="mistake",
                     title="WRONG: REFRESH … CONCURRENTLY without a unique index",
                     note="CONCURRENTLY diffs old and new rows, which needs a unique index to match them up.")
            d.check("CONCURRENTLY refuses without a unique index", e and "cannot refresh materialized view" in e, e)
            d.data["mode"] = "mistake"
        run(d, conn, "CREATE UNIQUE INDEX ON revenue_snapshot (status)")
        run(d, conn, "REFRESH MATERIALIZED VIEW CONCURRENTLY revenue_snapshot", title="REFRESH MATERIALIZED VIEW CONCURRENTLY",
            note="With a unique index, CONCURRENTLY refreshes without blocking readers.")
        refreshed = value(conn, "SELECT sum(revenue) FROM revenue_snapshot")
        run(d, conn, """
            CREATE VIEW paid_sales AS SELECT id, customer_id, status, amount FROM sales WHERE status = 'paid'
            WITH CHECK OPTION""", title="Updatable view WITH CHECK OPTION",
            note="Simple views are updatable. CHECK OPTION refuses writes the view could not see afterwards.")
        run(d, conn, "INSERT INTO paid_sales VALUES (100000, 2, 'paid', 10)")
        check_opt = fail(d, conn, "INSERT INTO paid_sales VALUES (100001, 2, 'pending', 10)", title="Inserting a pending sale through the paid view")
        d.check("The view reflected the new sale at once", float(after["view"]) == float(after["table"]) == float(before["table"]) + 5000)
        d.check("The materialized view stayed stale until REFRESH", float(after["matview"]) == float(before["matview"]) and float(refreshed) == float(after["table"]),
                f"stale {float(after['matview']):,.2f} → refreshed {float(refreshed):,.2f}")
        d.check("WITH CHECK OPTION rejected an out-of-view row", check_opt and "violates check option" in check_opt, check_opt)
        d.data["totals"] = {"before": before, "after": after, "refreshed": refreshed}
    return d.result()


@router.post("/functions")
def functions(n: int = 10, mistake: bool = False) -> dict:
    n = clamp(n, 1, 30)
    with Demo("functions") as d, scratch(d, "functions") as schema, session(schema) as conn:
        notices: list[str] = []
        conn.add_notice_handler(lambda diag: notices.append(diag.message_primary or ""))
        run(d, conn, """
            CREATE FUNCTION price_with_tax(price numeric, rate numeric DEFAULT 0.2)
            RETURNS numeric LANGUAGE sql IMMUTABLE
            RETURN round(price * (1 + rate), 2)""",
            title="SQL function", note="The simplest kind: one expression. IMMUTABLE tells the planner the same inputs always give the same output.")
        run(d, conn, "SELECT name, price, price_with_tax(price) AS with_tax, price_with_tax(price, 0.07) AS with_7pct FROM products ORDER BY id LIMIT 4",
            title="Calling it like a built-in")
        run(d, conn, """
            CREATE FUNCTION fib(n integer) RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
            DECLARE a numeric := 0; b numeric := 1; t numeric;
            BEGIN
              IF n < 0 THEN RAISE EXCEPTION 'n must be >= 0, got %', n; END IF;
              FOR i IN 1..n LOOP
                t := a + b; a := b; b := t;
              END LOOP;
              RAISE NOTICE 'fib(%) computed in % steps', n, n;
              RETURN a;
            END $$""",
            title="PL/pgSQL function", note="Variables, IF, loops, RAISE NOTICE / EXCEPTION. Runs inside the server, next to the data.")
        fib = run(d, conn, "SELECT fib(%s) AS fib", [n], title=f"SELECT fib({n})")
        run(d, conn, """
            CREATE FUNCTION top_customers(k integer)
            RETURNS TABLE (name text, revenue numeric) LANGUAGE sql STABLE AS $$
              SELECT c.name, sum(oi.qty * oi.unit_price)
              FROM customers c JOIN orders o ON o.customer_id = c.id JOIN order_items oi ON oi.order_id = o.id
              GROUP BY c.name ORDER BY 2 DESC LIMIT k
            $$""", title="Set-returning function (RETURNS TABLE)", note="Use it in FROM like a parameterized view.")
        top = run(d, conn, "SELECT * FROM top_customers(3)", title="SELECT * FROM top_customers(3)")
        run(d, conn, "CREATE TABLE ledger (id int GENERATED ALWAYS AS IDENTITY, note text)")
        run(d, conn, """
            CREATE PROCEDURE fill_ledger(batches integer) LANGUAGE plpgsql AS $$
            BEGIN
              FOR i IN 1..batches LOOP
                INSERT INTO ledger (note) VALUES ('batch ' || i);
                COMMIT;  -- procedures may control transactions; functions may not
              END LOOP;
            END $$""", title="PROCEDURE with COMMIT inside", note="CALL a procedure for batch jobs: it can COMMIT between batches, so a long job doesn't hold one giant transaction.")
        run(d, conn, "CALL fill_ledger(3)", title="CALL fill_ledger(3)")
        run(d, conn, """
            DO $$
            BEGIN
              RAISE NOTICE 'ledger has % rows', (SELECT count(*) FROM ledger);
            END $$""", title="DO block (anonymous code)", note="Run one-off procedural code without creating a function.")
        bad = fail(d, conn, "SELECT fib(-1)", title="RAISE EXCEPTION becomes a normal SQL error")
        if mistake:
            run(d, conn, "CREATE FUNCTION slugify(t text) RETURNS text LANGUAGE plpgsql AS $$ BEGIN RETURN lower(replace(t, ' ', '-')); END $$")
            run(d, conn, "CREATE TABLE pc AS SELECT * FROM products")
            e = fail(d, conn, "CREATE INDEX ON pc (slugify(name))",
                     label="mistake", title="WRONG: indexing a function not marked IMMUTABLE",
                     note="Functions default to VOLATILE. An index stores results forever, so Postgres only allows IMMUTABLE functions in it.")
            run(d, conn, "ALTER FUNCTION slugify(text) IMMUTABLE")
            run(d, conn, "CREATE INDEX ON pc (slugify(name))", title="RIGHT: mark it IMMUTABLE (only if it truly is)")
            d.check("Postgres refused the non-IMMUTABLE index expression", e and "must be marked IMMUTABLE" in e, e)
            d.data["mode"] = "mistake"
        expected = [0, 1]
        for _ in range(n):
            expected.append(expected[-1] + expected[-2])
        d.check(f"fib({n}) is correct", int(fib[0]["fib"]) == expected[n], fib[0]["fib"])
        d.check("The procedure committed three batches", value(conn, "SELECT count(*) FROM ledger") == 3)
        d.check("RAISE NOTICE messages reached the client", any("fib(" in m for m in notices) and any("ledger has" in m for m in notices), notices)
        d.check("RAISE EXCEPTION surfaced as an error", bad and "n must be >= 0" in bad, bad)
        d.data.update({"notices": notices, "n": n, "fib": fib[0]["fib"], "top": top})
    return d.result()


@router.post("/triggers")
def triggers(mistake: bool = False) -> dict:
    with Demo("triggers") as d, scratch(d, "triggers") as schema, session(schema) as conn:
        run(d, conn, """
            CREATE TABLE accounts (id int PRIMARY KEY, owner text NOT NULL, balance numeric NOT NULL,
                                   updated_at timestamptz NOT NULL DEFAULT now());
            CREATE TABLE audit_log (id bigint GENERATED ALWAYS AS IDENTITY, op text, row_id int,
                                    old_row jsonb, new_row jsonb, at timestamptz DEFAULT clock_timestamp())""")
        run(d, conn, """
            CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              NEW.updated_at := clock_timestamp();
              RETURN NEW;
            END $$;
            CREATE TRIGGER accounts_touch BEFORE UPDATE ON accounts
              FOR EACH ROW EXECUTE FUNCTION touch()""",
            title="BEFORE UPDATE trigger: maintain updated_at",
            note="A BEFORE row trigger can change NEW before it is written. Returning NULL would skip the row.")
        run(d, conn, """
            CREATE FUNCTION audit() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              INSERT INTO audit_log (op, row_id, old_row, new_row)
              VALUES (TG_OP, coalesce(NEW.id, OLD.id),
                      CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
                      CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
              RETURN NULL;  -- ignored for AFTER triggers
            END $$;
            CREATE TRIGGER accounts_audit AFTER INSERT OR UPDATE OR DELETE ON accounts
              FOR EACH ROW EXECUTE FUNCTION audit()""",
            title="AFTER trigger: audit every change", note="TG_OP tells which operation fired it; OLD and NEW are the row before and after.")
        run(d, conn, """
            CREATE FUNCTION no_overdraft() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF NEW.balance < 0 THEN
                RAISE EXCEPTION 'account % would be overdrawn (%)', NEW.id, NEW.balance USING ERRCODE = 'check_violation';
              END IF;
              RETURN NEW;
            END $$;
            CREATE TRIGGER accounts_guard BEFORE INSERT OR UPDATE ON accounts
              FOR EACH ROW EXECUTE FUNCTION no_overdraft()""",
            title="BEFORE trigger as a business rule", note="Raising an exception aborts the statement, so the bad write never happens. (A CHECK constraint is simpler when it fits.)")
        run(d, conn, """
            CREATE FUNCTION summary() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              RAISE NOTICE '% rows changed in one statement', (SELECT count(*) FROM changed);
              RETURN NULL;
            END $$;
            CREATE TRIGGER accounts_summary AFTER UPDATE ON accounts
              REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION summary()""",
            title="Statement-level trigger with a transition table", note="Fires once per statement and sees all changed rows at once in `changed`.")
        notices: list[str] = []
        conn.add_notice_handler(lambda diag: notices.append(diag.message_primary or ""))
        run(d, conn, "INSERT INTO accounts (id, owner, balance) VALUES (1, 'Ada', 100), (2, 'Grace', 50)", title="INSERT two accounts")
        t0 = value(conn, "SELECT updated_at FROM accounts WHERE id = 1")
        run(d, conn, "UPDATE accounts SET balance = balance + 10", title="UPDATE both (+10)")
        t1 = value(conn, "SELECT updated_at FROM accounts WHERE id = 1")
        blocked = fail(d, conn, "UPDATE accounts SET balance = balance - 500 WHERE id = 2", title="UPDATE that would overdraw")
        run(d, conn, "DELETE FROM accounts WHERE id = 2", title="DELETE one")
        log = run(d, conn, "SELECT id, op, row_id, old_row->>'balance' AS old_balance, new_row->>'balance' AS new_balance FROM audit_log ORDER BY id",
                  title="The audit log the trigger wrote")
        if mistake:
            run(d, conn, "CREATE TABLE notes (id int PRIMARY KEY, body text, updated_at timestamptz)")
            run(d, conn, "CREATE TRIGGER notes_touch AFTER UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION touch()", label="mistake",
                title="WRONG: setting NEW in an AFTER trigger", note="The row is already written when AFTER triggers run; changes to NEW are silently thrown away.")
            run(d, conn, "INSERT INTO notes VALUES (1, 'hi', NULL)")
            run(d, conn, "UPDATE notes SET body = 'hello' WHERE id = 1")
            lost = value(conn, "SELECT updated_at FROM notes WHERE id = 1")
            d.check("AFTER trigger's change to NEW was ignored", lost is None, f"updated_at = {lost}")
            d.data["mode"] = "mistake"
        d.check("BEFORE trigger bumped updated_at", t1 > t0, f"{t0} → {t1}")
        d.check("Audit log captured INSERT ×2, UPDATE ×2, DELETE ×1",
                [r["op"] for r in log] == ["INSERT", "INSERT", "UPDATE", "UPDATE", "DELETE"], [r["op"] for r in log])
        d.check("Guard trigger blocked the overdraft", blocked and "would be overdrawn" in blocked, blocked)
        d.check("Statement trigger saw 2 rows in its transition table", "2 rows changed in one statement" in notices, notices)
        d.data["notices"] = notices
    return d.result()


@router.post("/partitioning")
def partitioning(mistake: bool = False) -> dict:
    with Demo("partitioning") as d, scratch(d, "partitions") as schema, session(schema) as conn:
        run(d, conn, """
            CREATE TABLE measurements (
              id bigint GENERATED ALWAYS AS IDENTITY,
              created_at timestamptz NOT NULL,
              kind text NOT NULL,
              PRIMARY KEY (id, created_at)
            ) PARTITION BY RANGE (created_at)""",
            title="CREATE TABLE … PARTITION BY RANGE",
            note="The parent holds no rows itself; each partition holds one slice. The primary key must include the partition key.")
        months = []
        for m in range(1, 10):
            start, end = f"2026-{m:02d}-01", (f"2026-{m + 1:02d}-01" if m < 12 else "2027-01-01")
            name = f"measurements_2026_{m:02d}"
            months.append(name)
            run(d, conn, f"CREATE TABLE {name} PARTITION OF measurements FOR VALUES FROM ('{start}') TO ('{end}')",
                title="CREATE TABLE … PARTITION OF (one per month)" if m == 1 else None)
        run(d, conn, "CREATE TABLE measurements_default PARTITION OF measurements DEFAULT",
            title="DEFAULT partition", note="Catches rows that fit no other partition, instead of an error.")
        run(d, conn, "INSERT INTO measurements (created_at, kind) SELECT created_at, kind FROM shop.events WHERE id % 4 = 0",
            title="INSERT 50,000 events: Postgres routes each row to its month")
        run(d, conn, "INSERT INTO measurements (created_at, kind) VALUES ('2027-03-01', 'late')")
        run(d, conn, "ANALYZE measurements")
        counts = run(d, conn, """
            SELECT tableoid::regclass AS partition, count(*) AS rows, min(created_at)::date AS first, max(created_at)::date AS last
            FROM measurements GROUP BY 1 ORDER BY 1""",
            title="Rows per partition (tableoid tells where each row lives)")
        plan = run(d, conn, """
            EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF, BUFFERS OFF)
            SELECT count(*) FROM measurements WHERE created_at >= '2026-03-01' AND created_at < '2026-04-01'""",
            title="Partition pruning in EXPLAIN",
            note="The WHERE clause matches only March, so the planner skips every other partition.")
        plan_text = "\n".join(r["QUERY PLAN"] for r in plan)
        scanned = [m for m in months + ["measurements_default"] if m in plan_text]
        run(d, conn, f"ALTER TABLE measurements DETACH PARTITION {months[0]}", title="Retention: DETACH PARTITION (then DROP)",
            note="Removing a month of data is a metadata change: instant, no DELETE, no bloat, no VACUUM.")
        run(d, conn, f"DROP TABLE {months[0]}")
        remaining = value(conn, "SELECT count(*) FROM measurements WHERE created_at < '2026-02-01'")
        if mistake:
            run(d, conn, "CREATE TABLE logs (id bigint, at timestamptz NOT NULL) PARTITION BY RANGE (at)")
            e1 = fail(d, conn, "ALTER TABLE logs ADD PRIMARY KEY (id)", label="mistake",
                      title="WRONG: a primary key without the partition key",
                      note="Each partition enforces uniqueness on its own, so the partition key must be part of every unique constraint.")
            run(d, conn, "CREATE TABLE logs_jan PARTITION OF logs FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')")
            e2 = fail(d, conn, "INSERT INTO logs VALUES (1, '2026-05-05')", label="mistake",
                      title="WRONG: no partition for the row (and no DEFAULT)", note="Create partitions ahead of time (pg_partman or a cron job), or add a DEFAULT partition.")
            d.check("PK without the partition key is rejected", e1 and "must include all partitioning columns" in e1, e1)
            d.check("A row with no partition is rejected", e2 and "no partition of relation" in e2, e2)
            d.data["mode"] = "mistake"
        d.check("Every row landed in its month (and the 2027 row in DEFAULT)",
                any(str(r["partition"]).endswith("default") and r["rows"] == 1 for r in counts), len(counts))
        d.check("Only the March partition was scanned", scanned == ["measurements_2026_03"], scanned)
        d.check("Dropping a partition removed January instantly", remaining == 0)
        d.data.update({"partitions": counts, "scanned": scanned, "plan": plan_text})
    return d.result()
