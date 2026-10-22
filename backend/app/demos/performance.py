"""Performance: EXPLAIN / EXPLAIN ANALYZE plans, every index type with before/after timings,
planner statistics (and what stale or missing statistics do), and pg_stat_statements."""

from __future__ import annotations

import json
import statistics as stats
import time

from fastapi import APIRouter

from ..db import fail, heavy, run, scratch, session, value
from ..lab import Demo, clamp, pick

router = APIRouter(prefix="/api/demos")

EXPLAIN_QUERIES = {
    "by_id": ("Primary key lookup", "SELECT * FROM events WHERE id = 123456",
              "One row by its primary key: an Index Scan touches a handful of pages."),
    "by_user": ("Indexed column, several rows", "SELECT * FROM events WHERE user_id = 42",
                "user_id has a B-tree index. ~40 matching rows spread over the table: a Bitmap Index Scan collects them, then a Bitmap Heap Scan reads each page once."),
    "by_kind": ("Unindexed column", "SELECT count(*) FROM events WHERE kind = 'refund'",
                "No index on kind, so every row is read: a (parallel) Seq Scan with a Filter that throws most rows away."),
    "top_n": ("ORDER BY … LIMIT", "SELECT id, kind, created_at FROM events ORDER BY created_at DESC LIMIT 10",
              "No index on created_at: scan everything and keep the top 10 in a small heap (top-N heapsort) instead of sorting all rows."),
    "join": ("Join + aggregate", """SELECT c.country, count(*) AS orders
FROM customers c JOIN orders o ON o.customer_id = c.id
GROUP BY c.country ORDER BY orders DESC""",
             "Small tables: a Hash Join builds a hash table of customers, probes it with every order, then a HashAggregate groups."),
}


def simplify_plan(node: dict) -> dict:
    """The parts of an EXPLAIN (FORMAT JSON) node the plan-tree visual draws."""
    return {
        "type": node.get("Node Type"),
        "strategy": node.get("Strategy") or node.get("Join Type") or node.get("Scan Direction"),
        "relation": node.get("Relation Name"),
        "index": node.get("Index Name"),
        "filter": node.get("Filter") or node.get("Index Cond") or node.get("Hash Cond") or node.get("Recheck Cond"),
        "planRows": node.get("Plan Rows"),
        "rows": node.get("Actual Rows"),
        "loops": node.get("Actual Loops"),
        "removed": node.get("Rows Removed by Filter"),
        "ms": node.get("Actual Total Time"),
        "cost": node.get("Total Cost"),
        "hit": node.get("Shared Hit Blocks"),
        "read": node.get("Shared Read Blocks"),
        "workers": node.get("Workers Launched"),
        "children": [simplify_plan(c) for c in node.get("Plans", [])],
    }


def explain_json(conn, sql: str) -> dict:
    row = conn.execute(f"EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {sql}").fetchone()
    doc = next(iter(row.values()))
    doc = doc if isinstance(doc, list) else json.loads(doc)
    return doc[0]


def node_types(plan: dict) -> list[str]:
    out = [plan["type"]]
    for child in plan["children"]:
        out += node_types(child)
    return out


@router.post("/explain")
def explain(query: str = "by_user", mistake: bool = False) -> dict:
    query = pick(query, EXPLAIN_QUERIES, "by_user")
    title, sql, note = EXPLAIN_QUERIES[query]
    with Demo("explain") as d, session() as conn:
        run(d, conn, f"EXPLAIN {sql}", title="EXPLAIN: the plan and its estimates",
            note="Plans only, runs nothing. cost=startup..total is in arbitrary units; rows= is the planner's estimate.")
        run(d, conn, f"EXPLAIN (ANALYZE, BUFFERS) {sql}", title=f"EXPLAIN (ANALYZE, BUFFERS): {title}", note=note)
        doc = explain_json(conn, sql)
        d.command(f"EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {' '.join(sql.split())}  -- plan tree for the visual")
        plan = simplify_plan(doc["Plan"])
        if mistake:
            with scratch(d, "explain") as schema:
                run(d, conn, f"CREATE TABLE {schema}.victims AS SELECT g AS id FROM generate_series(1, 1000) g")
                run(d, conn, f"EXPLAIN ANALYZE DELETE FROM {schema}.victims", label="mistake",
                    title="WRONG: EXPLAIN ANALYZE on a DELETE", note="ANALYZE really executes the statement to time it. The rows are gone.")
                gone = value(conn, f"SELECT count(*) FROM {schema}.victims")
                run(d, conn, f"INSERT INTO {schema}.victims SELECT generate_series(1, 1000)")
                run(d, conn, "BEGIN")
                run(d, conn, f"EXPLAIN ANALYZE DELETE FROM {schema}.victims", title="RIGHT: inside BEGIN … ROLLBACK")
                run(d, conn, "ROLLBACK")
                kept = value(conn, f"SELECT count(*) FROM {schema}.victims")
            d.check("EXPLAIN ANALYZE DELETE deleted the rows for real", gone == 0, f"{gone} rows left")
            d.check("Wrapped in a transaction and rolled back, the rows survive", kept == 1000, f"{kept} rows")
            d.data["mode"] = "mistake"
        types = node_types(plan)
        expect = {"by_id": "Index Scan", "by_user": "Bitmap Index Scan", "by_kind": "Seq Scan", "top_n": "Sort", "join": "Hash Join"}[query]
        if query == "top_n":
            types_ok = any(t in ("Sort", "Gather Merge") for t in types) or "Limit" in types
        elif query == "by_user":
            types_ok = any(t in ("Bitmap Index Scan", "Index Scan") for t in types)
        else:
            types_ok = expect in types
        d.check(f"The plan uses {expect}", types_ok, " → ".join(types))
        d.check("Execution time and buffer counts were measured", doc.get("Execution Time") is not None and plan["hit"] is not None,
                f"{doc.get('Execution Time'):.2f} ms, planning {doc.get('Planning Time'):.2f} ms")
        d.data.update({"query": query, "sql": sql, "plan": plan, "executionMs": doc.get("Execution Time"),
                       "planningMs": doc.get("Planning Time"), "options": {k: v[0] for k, v in EXPLAIN_QUERIES.items()}})
    return d.result()


INDEX_CASES = [
    {
        "key": "btree", "name": "B-tree", "ddl": "CREATE INDEX ev_user_idx ON ev (user_id)",
        "sql": "SELECT * FROM ev WHERE user_id = 42",
        "note": "The default index: sorted keys, for =, <, >, BETWEEN, ORDER BY, and prefix LIKE 'abc%'.",
    },
    {
        "key": "expression", "name": "Expression", "ddl": "CREATE INDEX ev_ms_idx ON ev (((payload->>'ms')::int))",
        "sql": "SELECT count(*) FROM ev WHERE (payload->>'ms')::int > 1995",
        "note": "Indexes the result of an expression, so WHERE on that exact expression can use it (also lower(email)).",
    },
    {
        "key": "partial", "name": "Partial", "ddl": "CREATE INDEX ev_refund_idx ON ev (created_at) WHERE kind = 'refund'",
        "sql": "SELECT id, created_at FROM ev WHERE kind = 'refund' ORDER BY created_at DESC LIMIT 20",
        "note": "Only rows matching the WHERE are indexed: refunds are 0.5% of rows, so the index is tiny.",
    },
    {
        "key": "covering", "name": "Covering (INCLUDE)", "ddl": "CREATE INDEX ev_user_inc_idx ON ev (user_id) INCLUDE (created_at)",
        "sql": "SELECT user_id, max(created_at) FROM ev WHERE user_id < 60 GROUP BY user_id",
        "note": "Extra INCLUDE columns let the query be answered from the index alone (Index Only Scan) with no table visits.",
    },
    {
        "key": "skip", "name": "Multicolumn + skip scan (18)", "ddl": "CREATE INDEX ev_kind_user_idx ON ev (kind, user_id)",
        "sql": "SELECT count(*) FROM ev WHERE user_id = 42",
        "note": "New in Postgres 18: a B-tree on (kind, user_id) can serve WHERE user_id = … alone by skipping through the few distinct kinds.",
    },
    {
        "key": "gin", "name": "GIN (jsonb)", "ddl": "CREATE INDEX ev_payload_idx ON ev USING gin (payload jsonb_path_ops)",
        "sql": "SELECT count(*) FROM ev WHERE payload @> '{\"ms\": 1234}'",
        "note": "Inverted index over the keys and values inside each document: for @>, ?, @@ on jsonb, arrays and full text.",
    },
    {
        "key": "brin", "name": "BRIN", "ddl": "CREATE INDEX ev_created_brin ON ev USING brin (created_at)",
        "sql": "SELECT count(*) FROM ev WHERE created_at >= '2026-05-01' AND created_at < '2026-05-03'",
        "note": "Stores only min/max per block range. Tiny, and great when values follow the physical order (append-only time series).",
    },
    {
        "key": "hash", "name": "Hash", "ddl": "CREATE INDEX ev_user_hash ON ev USING hash (user_id)",
        "sql": "SELECT * FROM ev WHERE user_id = 4242",
        "note": "Equality only. Rarely better than a B-tree; mostly useful for very long keys.",
    },
]


def _measure(conn, sql: str) -> tuple[float, list[str]]:
    times, plan = [], None
    for _ in range(3):
        doc = explain_json(conn, sql)
        times.append(doc["Execution Time"])
        plan = simplify_plan(doc["Plan"])
    return round(stats.median(times), 3), node_types(plan)


@router.post("/indexes")
def indexes(rows: int = 100_000, mistake: bool = False) -> dict:
    rows = clamp(rows, 20_000, 200_000)
    with heavy, Demo("indexes") as d, scratch(d, "indexes") as schema, session(schema) as conn:
        run(d, conn, "CREATE TABLE ev AS SELECT * FROM shop.events WHERE id <= %s ORDER BY id", [rows],
            title=f"Copy {rows:,} events into a private table (no indexes)")
        run(d, conn, "VACUUM ANALYZE ev")
        results = []
        for case in INDEX_CASES:
            before_ms, before_plan = _measure(conn, case["sql"])
            d.command(f"EXPLAIN ANALYZE {case['sql']}  -- before: {' → '.join(before_plan)} ({before_ms} ms)")
            started = time.perf_counter()
            conn.execute(case["ddl"])
            build_ms = round((time.perf_counter() - started) * 1000, 2)
            d.command(f"{case['ddl']}  -- built in {build_ms} ms")
            run(d, conn, "VACUUM ANALYZE ev")
            size = value(conn, "SELECT pg_relation_size(%s::regclass)", [case["ddl"].split()[2]])
            after_ms, after_plan = _measure(conn, case["sql"])
            d.command(f"EXPLAIN ANALYZE {case['sql']}  -- after: {' → '.join(after_plan)} ({after_ms} ms)")
            uses = any("Index" in t for t in after_plan)
            results.append({**case, "beforeMs": before_ms, "afterMs": after_ms, "beforePlan": before_plan,
                            "afterPlan": after_plan, "sizeBytes": size, "usesIndex": uses,
                            "buildMs": build_ms})
            run(d, conn, f"DROP INDEX {case['ddl'].split()[2]}")
        table_size = value(conn, "SELECT pg_relation_size('ev')")
        if mistake:
            run(d, conn, "CREATE INDEX ev_kind_idx ON ev (kind)")
            run(d, conn, "ANALYZE ev")
            plan = [r["QUERY PLAN"] for r in run(d, conn, "EXPLAIN SELECT * FROM ev WHERE kind = 'page_view'", label="mistake",
                    title="WRONG: expecting an index to help a non-selective filter",
                    note="60% of rows are page_view. Reading most of the table through an index is slower than one sequential pass, so the planner ignores the index (correctly).")]
            d.check("The planner chose a Seq Scan despite the index", "Seq Scan" in plan[0], plan[0])
            d.data["mode"] = "mistake"
        for r in results:
            d.check(f"{r['name']} index is used by its query", r["usesIndex"], " → ".join(r["afterPlan"]))
        brin = next(r for r in results if r["key"] == "brin")
        btree = next(r for r in results if r["key"] == "btree")
        d.check("BRIN is far smaller than a B-tree", brin["sizeBytes"] * 10 < btree["sizeBytes"],
                f"BRIN {brin['sizeBytes']:,} B vs B-tree {btree['sizeBytes']:,} B")
        d.data.update({"rows": rows, "results": results, "tableBytes": table_size})
    return d.result()


@router.post("/statistics")
def planner_statistics(rows: int = 100_000) -> dict:
    rows = clamp(rows, 20_000, 200_000)
    with heavy, Demo("statistics") as d, scratch(d, "stats") as schema, session(schema) as conn:
        mcv = run(d, conn, """
            SELECT attname, n_distinct, most_common_vals::text AS most_common_vals, most_common_freqs, correlation
            FROM pg_stats WHERE schemaname = 'shop' AND tablename = 'events' AND attname IN ('kind', 'user_id', 'created_at')
            ORDER BY attname""",
            title="pg_stats: what ANALYZE learned about shop.events",
            note="n_distinct (negative = fraction of rows), the most common values and their frequencies, and how well the column follows the physical order (correlation, 1 = perfectly sorted).")
        actual = run(d, conn, "SELECT kind, round(count(*)::numeric / sum(count(*)) OVER (), 4) AS actual_freq FROM shop.events GROUP BY kind ORDER BY 2 DESC",
                     title="Actual frequencies, for comparison")
        run(d, conn, "CREATE TABLE fresh (id int, kind text) WITH (autovacuum_enabled = false)")
        run(d, conn, "INSERT INTO fresh SELECT g, 'rare' FROM generate_series(1, 10) g")
        run(d, conn, "ANALYZE fresh", title="ANALYZE while the table has 10 rows")
        run(d, conn, "INSERT INTO fresh SELECT g, CASE WHEN mod(g, 100) = 0 THEN 'rare' ELSE 'common' END FROM generate_series(1, %s) g", [rows],
            title=f"Bulk load {rows:,} rows, no ANALYZE (autovacuum off for this table)")

        def estimate(sql: str) -> tuple[float, float]:
            doc = explain_json(conn, sql)
            return doc["Plan"]["Plan Rows"], doc["Plan"]["Actual Rows"]

        q = "SELECT * FROM fresh WHERE kind = 'common'"
        stale = estimate(q)
        d.command(f"EXPLAIN ANALYZE {q}  -- estimated {stale[0]:,.0f} rows, actual {stale[1]:,.0f}")
        run(d, conn, "ANALYZE fresh", title="ANALYZE again")
        fresh = estimate(q)
        d.command(f"EXPLAIN ANALYZE {q}  -- estimated {fresh[0]:,.0f} rows, actual {fresh[1]:,.0f}")
        run(d, conn, "CREATE TABLE places AS SELECT g, 'city' || mod(g, 100) AS city, 'zip' || mod(g, 100) AS zip FROM generate_series(1, %s) g", [rows],
            title="Correlated columns: each zip belongs to exactly one city")
        run(d, conn, "ANALYZE places")
        q2 = "SELECT * FROM places WHERE city = 'city7' AND zip = 'zip7'"
        independent = estimate(q2)
        d.command(f"EXPLAIN ANALYZE {q2}  -- estimated {independent[0]:,.0f}, actual {independent[1]:,.0f}")
        run(d, conn, "CREATE STATISTICS places_dep (dependencies) ON city, zip FROM places", title="CREATE STATISTICS … (dependencies)",
            note="Tells ANALYZE to measure how much one column determines another, so the planner stops multiplying the two selectivities.")
        run(d, conn, "ANALYZE places")
        extended = estimate(q2)
        d.command(f"EXPLAIN ANALYZE {q2}  -- estimated {extended[0]:,.0f}, actual {extended[1]:,.0f}")
        ratio = lambda e: max(e[0], 1) / max(e[1], 1) if e[0] >= e[1] else max(e[1], 1) / max(e[0], 1)
        d.check("Stale statistics badly mis-estimated the row count", ratio(stale) > 10, f"estimated {stale[0]:,.0f} vs actual {stale[1]:,.0f}")
        d.check("After ANALYZE the estimate is within 10%", ratio(fresh) < 1.1, f"estimated {fresh[0]:,.0f} vs actual {fresh[1]:,.0f}")
        d.check("Extended statistics fixed the correlated-column estimate", ratio(extended) < ratio(independent) and ratio(extended) < 1.5,
                f"{independent[0]:,.0f} → {extended[0]:,.0f} (actual {extended[1]:,.0f})")
        d.data.update({"rows": rows, "estimates": {
            "stale": stale, "fresh": fresh, "independent": independent, "extended": extended,
        }, "mcv": mcv, "actual": actual})
    return d.result()


@router.post("/pg-stat-statements")
def pg_stat_statements(calls: int = 50) -> dict:
    calls = clamp(calls, 10, 200)
    with heavy, Demo("pg-stat-statements") as d, scratch(d, "pgss") as schema, session(schema) as conn:
        run(d, conn, f"CREATE TABLE {schema}.ev AS SELECT * FROM shop.events WHERE id <= 60000")
        run(d, conn, f"ALTER TABLE {schema}.ev ADD PRIMARY KEY (id)")
        run(d, conn, f"ANALYZE {schema}.ev")
        run(d, conn, r"SELECT count(pg_stat_statements_reset(0, 0, queryid)) AS reset FROM pg_stat_statements WHERE query ~ 'run_pgss_[0-9a-f]+\.ev '",
            title="Forget earlier runs of this demo",
            note="Postgres 18 groups queries by table name rather than table OID, so every visitor's run (each in its own schema) lands in the same entries. Reset just those.")
        workload = [
            (f"SELECT * FROM {schema}.ev WHERE id = %s", lambda i: [1 + i * 97 % 60000], calls),
            (f"SELECT count(*) FROM {schema}.ev WHERE user_id = %s", lambda i: [1 + i % 5000], max(5, calls // 5)),
            (f"SELECT kind, count(*) FROM {schema}.ev WHERE created_at > %s::timestamptz GROUP BY kind", lambda i: ["2026-01-20"], max(3, calls // 10)),
        ]
        for sql, params, n in workload:
            for i in range(n):
                conn.execute(sql, params(i))
            d.command(f"{sql}  -- run {n}× with different parameters")
        top = run(d, conn, r"""
            SELECT regexp_replace(query, 'run_pgss_[0-9a-f]+\.', '') AS query, calls,
                   round(total_exec_time::numeric, 2) AS total_ms, round(mean_exec_time::numeric, 3) AS mean_ms,
                   rows, shared_blks_hit, shared_blks_read
            FROM pg_stat_statements
            WHERE query ~ '^SELECT .*run_pgss_[0-9a-f]+\.ev '
            ORDER BY total_exec_time DESC""",
            title="pg_stat_statements: top queries by total time",
            note="Queries are normalized: constants become $1, so 50 lookups with 50 different ids are one row with calls = 50. Sort by total time to find what to optimize first.")
        by_calls = {r["calls"] for r in top}
        d.check("Each query shape is one row, however many parameter values it ran with", {calls, max(5, calls // 5)} <= by_calls, sorted(by_calls))
        d.check("Parameters were normalized to $1", all("$1" in r["query"] for r in top), [r["query"][:60] for r in top])
        d.check("The unindexed scans cost more total time than the indexed lookups",
                len(top) >= 3 and "WHERE id = $1" not in top[0]["query"], top[0]["query"][:70] if top else None)
        d.data.update({"top": top, "calls": calls})
    return d.result()
