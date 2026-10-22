"""Common mistakes, reproduced side by side with the fix: N+1 queries, NOT IN with NULLs, deep
OFFSET pagination, and predicates that cannot use an index."""

from __future__ import annotations

import json
import time

from fastapi import APIRouter

from ..db import heavy, run, scratch, session, value
from ..lab import Demo, clamp

router = APIRouter(prefix="/api/demos")


@router.post("/n-plus-one")
def n_plus_one(orders: int = 50) -> dict:
    orders = clamp(orders, 10, 150)
    with Demo("n-plus-one") as d, session() as conn:
        started = time.perf_counter()
        rows = run(d, conn, "SELECT id, customer_id FROM orders ORDER BY id LIMIT %s", [orders], label="N+1",
                   title="WRONG: N+1, step 1: load the orders…",
                   note="…step 2: for each order, the app (often an ORM's lazy loading) runs SELECT name FROM customers WHERE id = $1. One round trip per row.")
        names = {}
        for r in rows:
            names[r["id"]] = conn.execute("SELECT name FROM customers WHERE id = %s", [r["customer_id"]]).fetchone()["name"]
        d.command(f"[N+1] SELECT name FROM customers WHERE id = $1  -- run {len(rows)}× (once per order)")
        n1_ms = (time.perf_counter() - started) * 1000
        started = time.perf_counter()
        joined = run(d, conn, """
            SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id
            ORDER BY o.id LIMIT %s""", [orders], label="JOIN",
            title="RIGHT: one JOIN", note="One round trip. The database does the matching, which is what it is built for.")
        join_ms = (time.perf_counter() - started) * 1000
        started = time.perf_counter()
        ids = sorted({r["customer_id"] for r in rows})
        batch = run(d, conn, "SELECT id, name FROM customers WHERE id = ANY(%s)", [ids], label="batch",
                    title="ALSO RIGHT: two queries, the second batched with = ANY($1)",
                    note="What ORMs call eager loading / prefetch: one query for the parents, one for all their children.")
        batch_ms = (time.perf_counter() - started) * 1000
        same = all(names[r["id"]] == r["name"] for r in joined) and len({b["id"] for b in batch}) == len(ids)
        d.check("N+1 sent one query per order plus one", len(names) == len(rows) == orders, f"{orders + 1} queries")
        d.check("All three approaches returned the same names", same)
        d.check("The JOIN was several times faster than N+1", join_ms * 3 < n1_ms, f"{n1_ms:.1f} ms vs {join_ms:.1f} ms")
        d.data.update({"orders": orders, "results": [
            {"method": "N+1 (loop in the app)", "queries": orders + 1, "ms": round(n1_ms, 2)},
            {"method": "Batched = ANY($1)", "queries": 2, "ms": round(batch_ms, 2)},
            {"method": "Single JOIN", "queries": 1, "ms": round(join_ms, 2)},
        ]})
    return d.result()


@router.post("/not-in-null")
def not_in_null() -> dict:
    with Demo("not-in-null") as d, session() as conn:
        nulls = value(conn, "SELECT count(*) FROM customers WHERE referred_by IS NULL")
        wrong = run(d, conn, """
            SELECT name FROM customers
            WHERE id NOT IN (SELECT referred_by FROM customers)
            ORDER BY name""",
            title="WRONG: NOT IN (subquery) when the subquery can return NULL",
            note=f"Who never referred anyone? referred_by contains {nulls} NULLs. `id NOT IN (…, NULL)` means id <> … AND id <> NULL, and id <> NULL is unknown, so no row ever qualifies.")
        right = run(d, conn, """
            SELECT name FROM customers c
            WHERE NOT EXISTS (SELECT 1 FROM customers r WHERE r.referred_by = c.id)
            ORDER BY name""",
            title="RIGHT: NOT EXISTS", note="NOT EXISTS asks 'is there a matching row?', which NULLs can't confuse. It also plans as an efficient anti-join.")
        filtered = run(d, conn, """
            SELECT name FROM customers
            WHERE id NOT IN (SELECT referred_by FROM customers WHERE referred_by IS NOT NULL)
            ORDER BY name""", title="Also right: filter the NULLs out", note="Works, but is easy to forget the next time.")
        run(d, conn, "SELECT 1 NOT IN (2, 3) AS a, 1 NOT IN (2, NULL) AS b, NULL = NULL AS c, NULL IS NULL AS d",
            title="Three-valued logic in one line", note="b and c are NULL (unknown), not false. WHERE keeps only rows where the condition is true.")
        d.check("NOT IN with a NULL in the list returned nothing", wrong == [] and nulls > 0, f"{nulls} NULLs in referred_by")
        d.check("NOT EXISTS found the customers who never referred anyone", len(right) > 0, f"{len(right)} customers")
        d.check("Filtering NULLs gives the same answer as NOT EXISTS", [r["name"] for r in filtered] == [r["name"] for r in right])
        d.data.update({"wrong": len(wrong), "right": len(right), "nulls": nulls})
    return d.result()


def _explain_ms(conn, sql: str, params=None) -> tuple[float, int]:
    doc = conn.execute(f"EXPLAIN (ANALYZE, FORMAT JSON) {sql}", params).fetchone()
    plan = next(iter(doc.values()))
    plan = plan if isinstance(plan, list) else json.loads(plan)
    root = plan[0]

    def scanned(node: dict) -> int:
        own = node.get("Actual Rows", 0) * node.get("Actual Loops", 1) if "Scan" in node.get("Node Type", "") else 0
        return own + sum(scanned(c) for c in node.get("Plans", []))

    return round(root["Execution Time"], 3), scanned(root["Plan"])


@router.post("/pagination")
def pagination(page_size: int = 20) -> dict:
    page_size = clamp(page_size, 10, 100)
    with heavy, Demo("pagination") as d, scratch(d, "pages") as schema, session(schema) as conn:
        points = []
        for offset in (0, 1_000, 10_000, 50_000, 100_000, 190_000):
            off_sql = f"SELECT id, kind FROM shop.events ORDER BY id LIMIT {page_size} OFFSET {offset}"
            off_ms, off_rows = _explain_ms(conn, off_sql)
            last_id = value(conn, f"SELECT id FROM shop.events ORDER BY id LIMIT 1 OFFSET {max(offset - 1, 0)}") if offset else 0
            key_sql = f"SELECT id, kind FROM shop.events WHERE id > {last_id} ORDER BY id LIMIT {page_size}"
            key_ms, key_rows = _explain_ms(conn, key_sql)
            points.append({"offset": offset, "offsetMs": off_ms, "offsetRowsRead": off_rows, "keysetMs": key_ms, "keysetRowsRead": key_rows})
            d.command(f"{off_sql}  -- {off_ms} ms, reads {off_rows:,} index entries")
            d.command(f"{key_sql}  -- {key_ms} ms, reads {key_rows:,}")
        run(d, conn, f"SELECT id, kind FROM shop.events ORDER BY id LIMIT {page_size} OFFSET 190000",
            title="WRONG: deep OFFSET", note="OFFSET reads and throws away every skipped row: page 9,500 reads 190,000 rows to return 20.")
        run(d, conn, f"SELECT id, kind FROM shop.events WHERE id > 190000 ORDER BY id LIMIT {page_size}",
            title="RIGHT: keyset (seek) pagination", note="Remember the last id of the page and continue after it: an index seek, as fast on page 9,500 as on page 1.")
        run(d, conn, "CREATE TABLE feed AS SELECT g AS id, 'post ' || g AS title FROM generate_series(1, 10) g")
        page1 = run(d, conn, "SELECT id, title FROM feed ORDER BY id DESC LIMIT 3 OFFSET 0", title="Feed page 1 (newest first)")
        run(d, conn, "INSERT INTO feed VALUES (11, 'post 11 (new!)')", title="A new post arrives while the reader is on page 1")
        page2 = run(d, conn, "SELECT id, title FROM feed ORDER BY id DESC LIMIT 3 OFFSET 3", title="WRONG: page 2 by OFFSET repeats a post",
                    note="Everything shifted down by one, so the last post of page 1 appears again on page 2.")
        page2_keyset = run(d, conn, "SELECT id, title FROM feed WHERE id < %s ORDER BY id DESC LIMIT 3", [page1[-1]["id"]],
                           title="RIGHT: page 2 by keyset continues where page 1 ended")
        deep = points[-1]
        d.check("Deep OFFSET read ~190,000 rows to return one page", deep["offsetRowsRead"] >= 190_000, f"{deep['offsetRowsRead']:,} rows read")
        d.check("Keyset read only the page itself", deep["keysetRowsRead"] <= page_size + 1, deep["keysetRowsRead"])
        d.check("Deep OFFSET was much slower than keyset", deep["offsetMs"] > 5 * deep["keysetMs"], f"{deep['offsetMs']} ms vs {deep['keysetMs']} ms")
        dup = {r["id"] for r in page1} & {r["id"] for r in page2}
        d.check("OFFSET showed a duplicate after an insert; keyset did not", bool(dup) and not ({r["id"] for r in page1} & {r["id"] for r in page2_keyset}),
                f"duplicated id {sorted(dup)}")
        d.data.update({"points": points, "pageSize": page_size, "page1": page1, "page2": page2, "page2Keyset": page2_keyset})
    return d.result()


SARGABLE = [
    {
        "key": "cast", "title": "Casting the column",
        "wrong": "SELECT * FROM ev WHERE user_id::text = '42'",
        "right": "SELECT * FROM ev WHERE user_id = 42",
        "why": "The index stores user_id, not user_id::text. Any function or cast on the column hides it from the index. Cast the value instead.",
    },
    {
        "key": "date", "title": "Wrapping a timestamp in a function",
        "wrong": "SELECT count(*) FROM ev WHERE created_at::date = '2026-05-01'",
        "right": "SELECT count(*) FROM ev WHERE created_at >= '2026-05-01' AND created_at < '2026-05-02'",
        "why": "Rewrite as a half-open range on the raw column, so a B-tree on created_at can seek straight to the day.",
    },
    {
        "key": "lower", "title": "lower() without an expression index",
        "wrong": "SELECT id, payload FROM ev WHERE lower(kind) = 'refund'",
        "right": "SELECT id, payload FROM ev WHERE kind = 'refund'",
        "why": "lower(kind) is a different value from kind. Store data normalized, or create an index ON ev (lower(kind)).",
    },
    {
        "key": "arith", "title": "Arithmetic on the column",
        "wrong": "SELECT * FROM ev WHERE id + 1 = 5001",
        "right": "SELECT * FROM ev WHERE id = 5000",
        "why": "Move the arithmetic to the constant side: the planner does not solve equations.",
    },
]


def _plan(conn, sql: str) -> tuple[str, float]:
    doc = conn.execute(f"EXPLAIN (ANALYZE, FORMAT JSON) {sql}").fetchone()
    plan = next(iter(doc.values()))
    plan = plan if isinstance(plan, list) else json.loads(plan)
    nodes = []

    def walk(n: dict) -> None:
        nodes.append(n["Node Type"] + (f" using {n['Index Name']}" if n.get("Index Name") else ""))
        for c in n.get("Plans", []):
            walk(c)

    walk(plan[0]["Plan"])
    return " → ".join(nodes), round(plan[0]["Execution Time"], 3)


@router.post("/index-not-used")
def index_not_used() -> dict:
    with heavy, Demo("index-not-used") as d, scratch(d, "sarg") as schema, session(schema) as conn:
        run(d, conn, "CREATE TABLE ev AS SELECT * FROM shop.events WHERE id <= 100000")
        run(d, conn, """
            ALTER TABLE ev ADD PRIMARY KEY (id);
            CREATE INDEX ON ev (user_id);
            CREATE INDEX ON ev (created_at);
            CREATE INDEX ON ev (kind)""", title="100,000 events with B-tree indexes on id, user_id, created_at and kind")
        run(d, conn, "VACUUM ANALYZE ev")
        cases = []
        for case in SARGABLE:
            wrong_plan, wrong_ms = _plan(conn, case["wrong"])
            right_plan, right_ms = _plan(conn, case["right"])
            d.command(f"{case['wrong']}  -- {wrong_plan} ({wrong_ms} ms)")
            d.command(f"{case['right']}  -- {right_plan} ({right_ms} ms)")
            cases.append({**case, "wrongPlan": wrong_plan, "wrongMs": wrong_ms, "rightPlan": right_plan, "rightMs": right_ms})
        for c in cases:
            d.check(f"{c['title']}: the wrong form can't use the index, the right one does",
                    "Index" not in c["wrongPlan"] and "Index" in c["rightPlan"], f"{c['wrongPlan']}  vs  {c['rightPlan']}")
        d.data["cases"] = cases
    return d.result()
