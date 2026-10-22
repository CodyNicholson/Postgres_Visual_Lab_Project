"""Query basics: SELECT, DML, upserts and MERGE, joins, aggregates, subqueries and set operations,
CTEs and window functions. Each demo runs a gallery of prepared queries against the shared
`shop` sample data (or a private copy of it when the query changes data) and returns every
statement with its explanation, columns and rows."""

from __future__ import annotations

from fastapi import APIRouter, Query

from ..db import fail, run, scratch, session, value
from ..lab import Demo, clamp, pick

router = APIRouter(prefix="/api/demos")

COUNTRIES = ["US", "UK", "NL", "DK", "NO", "FI", "CH", "DE", "JP", "AT", "HU"]


@router.post("/select")
def select_basics(country: str = "UK", limit: int = 5) -> dict:
    country = pick(country, COUNTRIES, "UK")
    limit = clamp(limit, 1, 20)
    with Demo("select") as d, session() as conn:
        run(d, conn, "SELECT id, name, country FROM customers ORDER BY id LIMIT %s", [limit],
            title="SELECT … ORDER BY … LIMIT",
            note="Pick columns, sort, and keep the first N rows. Without ORDER BY the row order is not guaranteed, so LIMIT would return arbitrary rows.")
        by_country = run(d, conn, "SELECT id, name, country FROM customers WHERE country = %s ORDER BY name", [country],
                         title="WHERE with a bound parameter",
                         note="The country travels as a parameter ($1), never pasted into the SQL text. That is what stops SQL injection.")
        run(d, conn, """
            SELECT name, price FROM products
            WHERE price >= 20 AND price < 60
            ORDER BY price DESC""",
            title="Ranges: >= and < (half-open)",
            note="Half-open ranges (>= start AND < end) never double-count a boundary value, unlike BETWEEN, which includes both ends.")
        run(d, conn, "SELECT name, category FROM products WHERE category IN ('Books', 'Games') ORDER BY category, name",
            title="IN (list)", note="IN is shorthand for several OR'ed equality tests. `= ANY(%s)` does the same with an array parameter.")
        run(d, conn, "SELECT name, description FROM products WHERE description ILIKE '%usb%' ORDER BY name",
            title="Pattern matching: LIKE / ILIKE",
            note="ILIKE is case-insensitive LIKE. % matches any run of characters, _ exactly one. A leading % cannot use a B-tree index (see the trigram demo).")
        eq_null = run(d, conn, "SELECT count(*) AS n FROM customers WHERE referred_by = NULL",
                      title="WRONG: = NULL", note="NULL means 'unknown', and unknown = unknown is not true, so this matches nothing. Always.")
        is_null = run(d, conn, "SELECT count(*) AS n FROM customers WHERE referred_by IS NULL",
                      title="RIGHT: IS NULL", note="IS NULL / IS NOT NULL (or IS DISTINCT FROM) are the only reliable NULL tests.")
        run(d, conn, "SELECT DISTINCT country FROM customers ORDER BY country",
            title="DISTINCT", note="Removes duplicate rows from the result.")
        per_cat = run(d, conn, """
            SELECT DISTINCT ON (category) category, name, price
            FROM products
            ORDER BY category, price DESC""",
            title="DISTINCT ON (Postgres extension)",
            note="Keeps the first row of each group, as decided by ORDER BY: here the most expensive product per category. A Postgres-only shortcut for 'top 1 per group'.")
        run(d, conn, """
            SELECT name, price,
                   round(price * 1.2, 2) AS price_with_vat,
                   CASE WHEN price < 30 THEN 'budget'
                        WHEN price < 100 THEN 'mid'
                        ELSE 'premium' END AS band,
                   coalesce(attrs->>'color', 'n/a') AS color
            FROM products ORDER BY price LIMIT 8""",
            title="Expressions, CASE, COALESCE, aliases",
            note="Compute new columns on the fly. CASE is SQL's if/else; COALESCE returns the first non-NULL argument.")
        run(d, conn, """
            SELECT name, price FROM products
            ORDER BY price DESC
            FETCH FIRST 3 ROWS WITH TIES""",
            title="FETCH FIRST … WITH TIES",
            note="Standard-SQL LIMIT. WITH TIES also returns rows that tie with the last one, so equally priced products are not cut arbitrarily.")
        d.check("WHERE returned only rows for the chosen country", all(r["country"] == country for r in by_country),
                f"{len(by_country)} customers in {country}")
        d.check("`= NULL` matched nothing while IS NULL found rows", eq_null[0]["n"] == 0 and is_null[0]["n"] > 0,
                f"= NULL → {eq_null[0]['n']}, IS NULL → {is_null[0]['n']}")
        d.check("DISTINCT ON returned exactly one row per category",
                len(per_cat) == len({r["category"] for r in per_cat}), f"{len(per_cat)} categories")
        d.data.update({"country": country, "limit": limit})
    return d.result()


@router.post("/dml")
def dml(mistake: bool = False) -> dict:
    with Demo("dml") as d, scratch(d, "dml") as schema, session(schema) as conn:
        run(d, conn, """
            CREATE TABLE inventory (
              id    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
              sku   text NOT NULL UNIQUE,
              name  text NOT NULL,
              price numeric(10,2) NOT NULL,
              stock integer NOT NULL DEFAULT 0
            )""", title="CREATE TABLE (identity primary key)",
            note="GENERATED ALWAYS AS IDENTITY is the modern replacement for serial: Postgres picks the ids.")
        if mistake:
            run(d, conn, "INSERT INTO inventory (sku, name, price, stock) SELECT 'SKU-' || id, name, price, 10 FROM shop.products")
            run(d, conn, "BEGIN", label="mistake")
            wrong = run(d, conn, "UPDATE inventory SET price = 0.01 RETURNING id", label="mistake",
                        title="WRONG: UPDATE without WHERE",
                        note="Forgot the WHERE clause: every row got the new price. In autocommit mode this would be permanent.")
            run(d, conn, "ROLLBACK", label="mistake", title="Saved by the transaction: ROLLBACK",
                note="Run risky changes inside BEGIN … check the row count … COMMIT or ROLLBACK.")
            intact = value(conn, "SELECT count(*) FROM inventory WHERE price = 0.01")
            d.check("UPDATE without WHERE hit every row", len(wrong) == 24, f"{len(wrong)} rows changed")
            d.check("ROLLBACK restored them", intact == 0, f"{intact} rows still at 0.01 after ROLLBACK")
            d.data["mode"] = "mistake"
            return d.result()

        one = run(d, conn, "INSERT INTO inventory (sku, name, price, stock) VALUES ('KB-1', 'Keyboard', 129.00, 2) RETURNING id, sku, stock",
                  title="INSERT … RETURNING", note="RETURNING hands back the generated id in the same round trip; no second SELECT needed.")
        run(d, conn, """
            INSERT INTO inventory (sku, name, price, stock) VALUES
              ('MS-1', 'Mouse', 49.00, 5),
              ('HUB-1', 'USB-C Hub', 35.00, 12),
              ('SD-1', 'Tomato Seeds', 4.50, 0)""",
            title="Multi-row INSERT", note="One statement, many rows: far faster than one INSERT per row.")
        copied = run(d, conn, """
            INSERT INTO inventory (sku, name, price, stock)
            SELECT 'BK-' || id, name, price, 3 FROM shop.products WHERE category = 'Books'
            RETURNING sku""", title="INSERT … SELECT", note="Copy rows from a query straight into a table.")
        changed = run(d, conn, """
            UPDATE inventory SET price = price * 0.9
            WHERE sku LIKE 'BK-%'
            RETURNING sku, old.price AS old_price, new.price AS new_price""",
            title="UPDATE … RETURNING old/new (Postgres 18)",
            note="New in Postgres 18: RETURNING can show both the value before (old.) and after (new.) the change.")
        run(d, conn, """
            UPDATE inventory i SET stock = i.stock + 100
            FROM shop.products p
            WHERE p.name = i.name AND p.category = 'Electronics'
            RETURNING i.sku, i.stock""",
            title="UPDATE … FROM (update with a join)", note="Joins another table to decide which rows to change and with what.")
        deleted = run(d, conn, "DELETE FROM inventory WHERE stock = 0 RETURNING sku, name",
                      title="DELETE … RETURNING", note="See exactly what was removed (handy for audit logs and undo).")
        run(d, conn, "SELECT sku, name, price, stock FROM inventory ORDER BY id", title="Final table")
        d.check("INSERT … RETURNING gave back a generated id", one and one[0]["id"] == 1, one)
        d.check("RETURNING old/new shows a 10% price cut", changed and all(
            round(float(r["old_price"]) * 0.9, 2) == float(r["new_price"]) for r in changed), f"{len(changed)} books updated")
        d.check("DELETE removed only the out-of-stock row", [r["sku"] for r in deleted] == ["SD-1"], deleted)
        d.data["copied"] = len(copied)
    return d.result()


@router.post("/upsert")
def upsert(mistake: bool = False) -> dict:
    with Demo("upsert") as d, scratch(d, "upsert") as schema, session(schema) as conn:
        run(d, conn, "CREATE TABLE stock (sku text PRIMARY KEY, qty integer NOT NULL)")
        run(d, conn, "INSERT INTO stock VALUES ('apple', 10), ('pear', 5)", title="Starting stock")
        if mistake:
            run(d, conn, "CREATE TABLE stock_nokey (sku text, qty integer)")
            e1 = fail(d, conn, "INSERT INTO stock_nokey VALUES ('apple', 1) ON CONFLICT (sku) DO NOTHING",
                      title="WRONG: ON CONFLICT without a unique index",
                      note="ON CONFLICT needs a unique index or constraint on exactly those columns to detect the conflict.")
            e2 = fail(d, conn, """
                INSERT INTO stock VALUES ('kiwi', 1), ('kiwi', 2)
                ON CONFLICT (sku) DO UPDATE SET qty = stock.qty + EXCLUDED.qty""",
                title="WRONG: the same key twice in one upsert",
                note="One statement may not update the same row twice. De-duplicate the batch first (GROUP BY / DISTINCT ON).")
            run(d, conn, """
                INSERT INTO stock
                SELECT sku, sum(qty) FROM (VALUES ('kiwi', 1), ('kiwi', 2)) v(sku, qty) GROUP BY sku
                ON CONFLICT (sku) DO UPDATE SET qty = stock.qty + EXCLUDED.qty
                RETURNING sku, qty""", title="RIGHT: aggregate the batch, then upsert")
            d.check("ON CONFLICT without a matching unique index fails", e1 and "no unique or exclusion constraint" in e1, e1)
            d.check("A batch with a duplicate key fails", e2 and "cannot affect row a second time" in e2, e2)
            d.check("De-duplicated batch upserts fine", value(conn, "SELECT qty FROM stock WHERE sku = 'kiwi'") == 3)
            d.data["mode"] = "mistake"
            return d.result()

        nothing = run(d, conn, "INSERT INTO stock VALUES ('apple', 99) ON CONFLICT (sku) DO NOTHING RETURNING sku",
                      title="ON CONFLICT DO NOTHING", note="Insert if new, silently skip if the key exists. RETURNING shows nothing for skipped rows.")
        ups = run(d, conn, """
            INSERT INTO stock VALUES ('apple', 3), ('plum', 7)
            ON CONFLICT (sku) DO UPDATE SET qty = stock.qty + EXCLUDED.qty
            RETURNING sku, qty, (xmax = 0) AS inserted""",
            title="ON CONFLICT DO UPDATE (upsert)",
            note="EXCLUDED is the row that failed to insert. apple existed, so its qty was increased; plum is new. xmax = 0 is a known trick to tell inserts from updates.")
        run(d, conn, "CREATE TABLE delivery (sku text PRIMARY KEY, qty integer NOT NULL)")
        run(d, conn, "INSERT INTO delivery VALUES ('apple', 0), ('pear', 20), ('grape', 4)")
        merged = run(d, conn, """
            MERGE INTO stock s
            USING delivery d ON s.sku = d.sku
            WHEN MATCHED AND d.qty = 0 THEN DELETE
            WHEN MATCHED THEN UPDATE SET qty = s.qty + d.qty
            WHEN NOT MATCHED THEN INSERT VALUES (d.sku, d.qty)
            RETURNING merge_action() AS action, s.sku, s.qty""",
            title="MERGE … RETURNING merge_action()",
            note="MERGE (SQL standard) applies a delivery file in one statement: delete, update or insert per row. RETURNING merge_action() arrived in Postgres 17.")
        run(d, conn, "SELECT * FROM stock ORDER BY sku", title="Stock after MERGE")
        d.check("DO NOTHING skipped the existing key", nothing == [])
        d.check("Upsert updated apple (10+3) and inserted plum",
                {r["sku"]: (r["qty"], r["inserted"]) for r in ups} == {"apple": (13, False), "plum": (7, True)}, ups)
        d.check("MERGE did one DELETE, one UPDATE and one INSERT",
                sorted(r["action"] for r in merged) == ["DELETE", "INSERT", "UPDATE"], [r["action"] for r in merged])
    return d.result()


REGIONS = "(VALUES ('US', 'Americas'), ('UK', 'Europe'), ('NL', 'Europe'), ('DK', 'Europe'), ('FI', 'Europe'), " \
          "('JP', 'Asia'), ('BR', 'Americas'), ('IN', 'Asia')) AS r(code, region)"


@router.post("/joins")
def joins(mistake: bool = False) -> dict:
    with Demo("joins") as d, session() as conn:
        counts = {}
        for kind in ["INNER", "LEFT", "RIGHT", "FULL"]:
            rows = run(d, conn, f"""
                SELECT c.name, c.country, r.code, r.region
                FROM customers c
                {kind} JOIN {REGIONS} ON r.code = c.country
                ORDER BY r.code NULLS FIRST, c.name NULLS FIRST""",
                title=f"{kind} JOIN", keep=50,
                note={
                    "INNER": "Only pairs that match on both sides: customers whose country is in the region list.",
                    "LEFT": "Every customer, matched or not. Customers from countries missing in the list get NULL region columns.",
                    "RIGHT": "Every region, matched or not. BR and IN have no customers, so their customer columns are NULL.",
                    "FULL": "Everything from both sides: matches, plus unmatched rows from either side padded with NULLs.",
                }[kind])
            counts[kind] = {
                "both": sum(1 for r in rows if r["name"] is not None and r["code"] is not None),
                "leftOnly": sum(1 for r in rows if r["code"] is None),
                "rightOnly": sum(1 for r in rows if r["name"] is None),
            }
        cross = run(d, conn, "SELECT s.size, c.color FROM (VALUES ('S'), ('M'), ('L')) s(size) CROSS JOIN (VALUES ('red'), ('blue')) c(color)",
                    title="CROSS JOIN", note="Every combination: 3 sizes × 2 colors = 6 rows. Accidental cross joins (a missing join condition) explode row counts.")
        run(d, conn, """
            SELECT e.name AS employee, e.title, m.name AS manager
            FROM employees e LEFT JOIN employees m ON m.id = e.manager_id
            ORDER BY e.id""", title="Self join", note="A table joined to itself: each employee next to their manager.")
        run(d, conn, """
            SELECT c.name, o.id AS order_id, o.ordered_at::date AS day
            FROM customers c
            CROSS JOIN LATERAL (
              SELECT id, ordered_at FROM orders WHERE customer_id = c.id
              ORDER BY ordered_at DESC LIMIT 2
            ) o
            WHERE c.id <= 5 ORDER BY c.id, o.ordered_at DESC""",
            title="LATERAL join (top N per group)",
            note="A LATERAL subquery can reference columns of the rows to its left: here, each customer's two latest orders.")
        semi = run(d, conn, """
            SELECT c.name FROM customers c
            WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.status = 'cancelled')
            ORDER BY c.name""", title="Semi-join: EXISTS",
            note="Customers with at least one cancelled order. EXISTS stops at the first match and never duplicates customers.")
        anti = run(d, conn, """
            SELECT c.name FROM customers c
            WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)
            ORDER BY c.name""", title="Anti-join: NOT EXISTS", note="Customers who never ordered anything.")
        run(d, conn, """
            SELECT c.name, count(o.id) AS orders
            FROM customers c JOIN orders o ON o.customer_id = c.id
            GROUP BY c.id, c.name ORDER BY orders DESC LIMIT 5""",
            title="JOIN + GROUP BY", note="Join first, then aggregate: the five busiest customers.")
        if mistake:
            in_where = run(d, conn, """
                SELECT count(DISTINCT c.id) AS customers FROM customers c
                LEFT JOIN orders o ON o.customer_id = c.id
                WHERE o.status = 'paid'""", label="mistake", title="WRONG: filtering the right table in WHERE",
                note="WHERE runs after the join and throws away NULL-padded rows, so this LEFT JOIN silently became an INNER JOIN.")
            in_on = run(d, conn, """
                SELECT count(DISTINCT c.id) AS customers FROM customers c
                LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'paid'""",
                title="RIGHT: put the filter in ON", note="Conditions on the optional side belong in ON: every customer is kept.")
            exploded = value(conn, "SELECT count(*) FROM orders, order_items")
            d.command(f"SELECT count(*) FROM orders, order_items  -- forgot the join condition → {exploded} rows")
            d.check("Filter in WHERE dropped the customers without paid orders",
                    in_where[0]["customers"] < in_on[0]["customers"] == 40,
                    f"WHERE → {in_where[0]['customers']} customers, ON → {in_on[0]['customers']}")
            d.check("A missing join condition multiplies rows", exploded > 100_000, f"{exploded:,} rows")
            d.data["mode"] = "mistake"
        d.data["venn"] = counts
        d.check("INNER ⊂ LEFT ⊂ FULL", counts["INNER"]["both"] == counts["LEFT"]["both"] == counts["FULL"]["both"]
                and counts["LEFT"]["leftOnly"] == counts["FULL"]["leftOnly"] > 0, counts)
        d.check("RIGHT JOIN keeps the regions with no customers (BR, IN)", counts["RIGHT"]["rightOnly"] == 2, counts["RIGHT"])
        d.check("CROSS JOIN returned 3 × 2 rows", len(cross) == 6)
        d.check("EXISTS / NOT EXISTS split customers cleanly", len(anti) == 5 and len(semi) > 0, f"{len(semi)} with cancellations, {len(anti)} never ordered")
    return d.result()


@router.post("/aggregates")
def aggregates(min_revenue: int = 1000, mistake: bool = False) -> dict:
    min_revenue = clamp(min_revenue, 0, 50_000)
    with Demo("aggregates") as d, session() as conn:
        per_cat = run(d, conn, """
            SELECT p.category,
                   count(*)                  AS lines,
                   sum(oi.qty)               AS units,
                   sum(oi.qty * oi.unit_price) AS revenue,
                   round(avg(oi.unit_price), 2) AS avg_price,
                   min(oi.unit_price) AS min_price, max(oi.unit_price) AS max_price
            FROM order_items oi JOIN products p ON p.id = oi.product_id
            GROUP BY p.category ORDER BY revenue DESC""",
            title="GROUP BY with count / sum / avg / min / max",
            note="One output row per category. Every selected column is either in GROUP BY or inside an aggregate.")
        having = run(d, conn, """
            SELECT c.name, sum(oi.qty * oi.unit_price) AS revenue
            FROM customers c
            JOIN orders o ON o.customer_id = c.id
            JOIN order_items oi ON oi.order_id = o.id
            WHERE o.status <> 'cancelled'
            GROUP BY c.id, c.name
            HAVING sum(oi.qty * oi.unit_price) >= %s
            ORDER BY revenue DESC""", [min_revenue],
            title="HAVING filters groups",
            note="WHERE filters rows before grouping; HAVING filters the groups after. Here: customers who spent at least the threshold.")
        run(d, conn, """
            SELECT count(*) AS orders,
                   count(*) FILTER (WHERE status = 'paid')      AS paid,
                   count(*) FILTER (WHERE status = 'shipped')   AS shipped,
                   count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
                   count(DISTINCT customer_id) AS distinct_customers
            FROM orders""",
            title="FILTER and count(DISTINCT)", note="FILTER (WHERE …) turns one pass over the table into several conditional counts (a pivot).")
        rollup = run(d, conn, """
            SELECT p.category, o.status, sum(oi.qty) AS units
            FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
            WHERE p.category IN ('Books', 'Games')
            GROUP BY ROLLUP (p.category, o.status)
            ORDER BY p.category NULLS LAST, o.status NULLS LAST""",
            title="ROLLUP (subtotals and grand total)",
            note="ROLLUP adds subtotal rows (status = NULL) and a grand total (both NULL). GROUPING SETS and CUBE give other combinations.")
        run(d, conn, """
            SELECT category, string_agg(name, ', ' ORDER BY name) AS products, array_agg(price ORDER BY price) AS prices
            FROM products GROUP BY category ORDER BY category""",
            title="string_agg / array_agg", note="Collapse a group into one text or array value, in a chosen order.")
        run(d, conn, """
            SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price) AS median_price,
                   percentile_cont(0.9) WITHIN GROUP (ORDER BY price) AS p90_price,
                   mode() WITHIN GROUP (ORDER BY category) AS most_common_category
            FROM products""",
            title="Ordered-set aggregates (median, p90, mode)", note="percentile_cont interpolates; percentile_disc picks an actual value.")
        if mistake:
            e1 = fail(d, conn, "SELECT category, name, count(*) FROM products GROUP BY category", label="mistake",
                      title="WRONG: a column that is neither grouped nor aggregated",
                      note="Which product name should represent a whole category? Postgres refuses to guess.")
            e2 = fail(d, conn, "SELECT category FROM products WHERE count(*) > 4 GROUP BY category", label="mistake",
                      title="WRONG: an aggregate in WHERE", note="WHERE runs before grouping, so aggregates don't exist yet. Use HAVING.")
            d.check("Ungrouped column is rejected", e1 and "must appear in the GROUP BY clause" in e1, e1)
            d.check("Aggregate in WHERE is rejected", e2 and "aggregate functions are not allowed in WHERE" in e2, e2)
            d.data["mode"] = "mistake"
        total = value(conn, "SELECT sum(qty * unit_price) FROM order_items")
        d.check("Category revenues add up to the grand total", abs(sum(float(r["revenue"]) for r in per_cat) - float(total)) < 0.01,
                f"{float(total):,.2f}")
        d.check("HAVING kept only customers at or above the threshold", all(float(r["revenue"]) >= min_revenue for r in having),
                f"{len(having)} customers ≥ {min_revenue}")
        d.check("ROLLUP produced a grand-total row", any(r["category"] is None and r["status"] is None for r in rollup))
        d.data["minRevenue"] = min_revenue
    return d.result()


@router.post("/subqueries")
def subqueries(mistake: bool = False) -> dict:
    with Demo("subqueries") as d, session() as conn:
        run(d, conn, """
            SELECT name, price, round(price - (SELECT avg(price) FROM products), 2) AS vs_average
            FROM products ORDER BY vs_average DESC LIMIT 6""",
            title="Scalar subquery", note="A subquery that returns exactly one value can be used like a constant.")
        run(d, conn, """
            SELECT name, category, price FROM products p
            WHERE price > (SELECT avg(price) FROM products WHERE category = p.category)
            ORDER BY category, price""",
            title="Correlated subquery", note="The inner query refers to the outer row (p.category), so it runs per category: products priced above their own category's average.")
        run(d, conn, """
            SELECT name FROM products
            WHERE id IN (SELECT product_id FROM order_items GROUP BY product_id HAVING sum(qty) > 60)
            ORDER BY name""", title="IN (subquery)", note="Products that sold more than 60 units.")
        run(d, conn, """
            SELECT category, round(avg(revenue), 2) AS avg_revenue_per_product FROM (
              SELECT p.category, p.id, sum(oi.qty * oi.unit_price) AS revenue
              FROM products p JOIN order_items oi ON oi.product_id = p.id
              GROUP BY p.category, p.id
            ) per_product
            GROUP BY category ORDER BY avg_revenue_per_product DESC""",
            title="Derived table (subquery in FROM)", note="Aggregate twice: revenue per product first, then the average per category.")
        run(d, conn, "SELECT name, price FROM products WHERE price > ALL (SELECT price FROM products WHERE category = 'Garden') ORDER BY price",
            title="> ALL (subquery)", note="Pricier than every garden product. `= ANY` is the same as IN.")
        sets = {}
        books = "SELECT DISTINCT c.country FROM customers c JOIN orders o ON o.customer_id = c.id JOIN order_items oi ON oi.order_id = o.id JOIN products p ON p.id = oi.product_id WHERE p.category = 'Books'"
        games = books.replace("'Books'", "'Garden'")
        for op, note in [
            ("UNION", "Countries that bought Books OR Garden items; duplicates removed."),
            ("UNION ALL", "Same, but keeps duplicates (and skips the costly de-duplication). Prefer it when duplicates can't occur."),
            ("INTERSECT", "Countries that bought both."),
            ("EXCEPT", "Countries that bought Books but no Garden items."),
        ]:
            rows = run(d, conn, f"({books})\n{op}\n({games})\nORDER BY 1", title=op, note=note)
            sets[op] = [r["country"] for r in rows]
        sets["books"] = [r["country"] for r in run(d, conn, books)]
        sets["garden"] = [r["country"] for r in run(d, conn, games)]
        if mistake:
            e = fail(d, conn, "SELECT name, (SELECT id FROM orders WHERE customer_id = c.id) AS order_id FROM customers c",
                     label="mistake", title="WRONG: scalar subquery that returns many rows",
                     note="Works in testing with one order per customer, breaks in production. Aggregate it, add LIMIT 1 with ORDER BY, or use a join/LATERAL.")
            d.check("Postgres refuses a multi-row scalar subquery", e and "more than one row returned by a subquery" in e, e)
            d.data["mode"] = "mistake"
        b, g = set(sets["books"]), set(sets["garden"])
        d.check("UNION = Books ∪ Garden", set(sets["UNION"]) == b | g, sets["UNION"])
        d.check("INTERSECT = Books ∩ Garden", set(sets["INTERSECT"]) == b & g, sets["INTERSECT"])
        d.check("EXCEPT = Books − Garden", set(sets["EXCEPT"]) == b - g, sets["EXCEPT"])
        d.check("UNION ALL keeps duplicates", len(sets["UNION ALL"]) == len(b) + len(g))
        d.data["sets"] = sets
    return d.result()


@router.post("/ctes")
def ctes(mistake: bool = False) -> dict:
    with Demo("ctes") as d, scratch(d, "ctes") as schema, session(schema) as conn:
        run(d, conn, """
            WITH monthly AS (
              SELECT date_trunc('month', o.ordered_at)::date AS month, sum(oi.qty * oi.unit_price) AS revenue
              FROM orders o JOIN order_items oi ON oi.order_id = o.id
              GROUP BY 1
            ), best AS (
              SELECT max(revenue) AS top FROM monthly
            )
            SELECT month, revenue, revenue = (SELECT top FROM best) AS best_month
            FROM monthly ORDER BY month""",
            title="WITH (common table expressions)",
            note="Name intermediate results and build the query step by step. Each CTE reads like a temporary view.")
        tree = run(d, conn, """
            WITH RECURSIVE org AS (
              SELECT id, name, title, manager_id, 1 AS depth, name::text AS path
              FROM employees WHERE manager_id IS NULL
              UNION ALL
              SELECT e.id, e.name, e.title, e.manager_id, org.depth + 1, org.path || ' › ' || e.name
              FROM employees e JOIN org ON e.manager_id = org.id
            )
            SELECT id, name, title, manager_id, depth, path FROM org ORDER BY path""",
            title="WITH RECURSIVE: walk a tree",
            note="The first SELECT is the anchor (the CEO); the second joins the previous level to find the next, until no rows come back.")
        run(d, conn, """
            WITH RECURSIVE days(day) AS (
              SELECT date '2026-03-01'
              UNION ALL
              SELECT day + 1 FROM days WHERE day < date '2026-03-07'
            )
            SELECT day, to_char(day, 'Dy') AS weekday,
                   (SELECT count(*) FROM orders WHERE ordered_at::date = day) AS orders
            FROM days""",
            title="Recursive sequence (fill gaps in a calendar)",
            note="Generates every day, so days with zero orders still appear. generate_series() does the same in one call.")
        run(d, conn, "CREATE TABLE tasks AS SELECT g AS id, (ARRAY['done','open'])[1 + g % 2] AS state FROM generate_series(1, 10) g")
        run(d, conn, "CREATE TABLE tasks_archive (LIKE tasks)")
        moved = run(d, conn, """
            WITH gone AS (
              DELETE FROM tasks WHERE state = 'done' RETURNING *
            )
            INSERT INTO tasks_archive SELECT * FROM gone RETURNING id""",
            title="Data-modifying CTE (move rows atomically)",
            note="DELETE … RETURNING feeds the INSERT in the same statement: rows are moved to the archive with no window where they are lost or doubled.")
        plans = {}
        for hint in ["MATERIALIZED", "NOT MATERIALIZED"]:
            plan = run(d, conn, f"""
                EXPLAIN (COSTS OFF)
                WITH recent AS {hint} (SELECT * FROM shop.events)
                SELECT * FROM recent WHERE user_id = 42""",
                title=f"WITH … AS {hint}",
                note="Since Postgres 12 a CTE used once is inlined (NOT MATERIALIZED), so filters push down into it. MATERIALIZED forces the old fence: compute it all first." if hint == "NOT MATERIALIZED" else
                     "MATERIALIZED computes the whole CTE first (every event!), then filters: no index can be used.")
            plans[hint] = "\n".join(r["QUERY PLAN"] for r in plan)
        if mistake:
            run(d, conn, "CREATE TABLE links (src int, dst int)")
            run(d, conn, "INSERT INTO links VALUES (1, 2), (2, 3), (3, 1)", title="A graph with a cycle 1 → 2 → 3 → 1")
            run(d, conn, "SET statement_timeout = '400ms'", label="mistake")
            e = fail(d, conn, """
                WITH RECURSIVE walk AS (
                  SELECT src, dst FROM links WHERE src = 1
                  UNION ALL
                  SELECT l.src, l.dst FROM links l JOIN walk w ON l.src = w.dst
                )
                SELECT count(*) FROM walk""", label="mistake", title="WRONG: recursion that never ends",
                note="The cycle feeds itself forever. Only the 400 ms timeout stops it (without one it runs until memory or disk runs out).")
            run(d, conn, "RESET statement_timeout", label="mistake")
            fixed = run(d, conn, """
                WITH RECURSIVE walk AS (
                  SELECT src, dst FROM links WHERE src = 1
                  UNION ALL
                  SELECT l.src, l.dst FROM links l JOIN walk w ON l.src = w.dst
                ) CYCLE dst SET is_cycle USING path
                SELECT src, dst, is_cycle, path FROM walk""",
                title="RIGHT: CYCLE clause (Postgres 14+)", note="CYCLE tracks visited nodes and stops at the first repeat. UNION (not ALL) also stops duplicates.")
            d.check("The unbounded recursion was cancelled by statement_timeout", e and "statement timeout" in e, e)
            d.check("CYCLE stops the walk", len(fixed) == 4 and fixed[-1]["is_cycle"], f"{len(fixed)} rows")
            d.data["mode"] = "mistake"
        d.check("Recursive CTE reached every employee", len(tree) == 15 and max(r["depth"] for r in tree) >= 5,
                f"{len(tree)} employees, depth {max(r['depth'] for r in tree)}")
        d.check("Data-modifying CTE moved the 5 done tasks",
                len(moved) == 5 and value(conn, "SELECT count(*) FROM tasks WHERE state = 'done'") == 0)
        d.check("Inlined CTE uses the index; MATERIALIZED scans everything",
                "Index" in plans["NOT MATERIALIZED"] and "CTE Scan" in plans["MATERIALIZED"], plans["NOT MATERIALIZED"].splitlines()[0])
        d.data["tree"] = tree
    return d.result()


@router.post("/windows")
def windows(mistake: bool = False) -> dict:
    with Demo("windows") as d, session() as conn:
        ranks = run(d, conn, """
            SELECT category, name, price,
                   row_number() OVER w AS row_number,
                   rank()       OVER w AS rank,
                   dense_rank() OVER w AS dense_rank
            FROM products
            WINDOW w AS (PARTITION BY category ORDER BY price DESC)
            ORDER BY category, price DESC""",
            title="row_number / rank / dense_rank",
            note="A window function computes over related rows without collapsing them. PARTITION BY restarts the numbering per category.")
        monthly = run(d, conn, """
            SELECT month, revenue,
                   sum(revenue) OVER (ORDER BY month) AS running_total,
                   revenue - lag(revenue) OVER (ORDER BY month) AS vs_prev_month,
                   round(avg(revenue) OVER (ORDER BY month ROWS BETWEEN 2 PRECEDING AND CURRENT ROW), 2) AS moving_avg_3m,
                   round(100 * revenue / sum(revenue) OVER (), 1) AS pct_of_total
            FROM (
              SELECT date_trunc('month', o.ordered_at)::date AS month, sum(oi.qty * oi.unit_price) AS revenue
              FROM orders o JOIN order_items oi ON oi.order_id = o.id
              WHERE o.status <> 'cancelled'
              GROUP BY 1
            ) m ORDER BY month""",
            title="Running total, lag, moving average, % of total",
            note="ORDER BY inside OVER makes a running window; ROWS BETWEEN sets the frame; an empty OVER () spans every row.")
        run(d, conn, """
            SELECT name, salary, ntile(4) OVER (ORDER BY salary) AS quartile,
                   first_value(name) OVER (ORDER BY salary DESC) AS top_earner,
                   round(percent_rank() OVER (ORDER BY salary)::numeric, 2) AS pct_rank
            FROM employees ORDER BY salary DESC""",
            title="ntile, first_value, percent_rank", note="Buckets, the top of the window, and relative position.")
        top2 = run(d, conn, """
            SELECT category, name, price FROM (
              SELECT category, name, price, row_number() OVER (PARTITION BY category ORDER BY price DESC) AS rn
              FROM products
            ) ranked WHERE rn <= 2 ORDER BY category, price DESC""",
            title="Top N per group (filter on a window in a subquery)",
            note="Window functions run after WHERE, so filter on them one level up.")
        if mistake:
            e = fail(d, conn, "SELECT name FROM products WHERE row_number() OVER (ORDER BY price) <= 3", label="mistake",
                     title="WRONG: a window function in WHERE", note="Windows are computed after WHERE; wrap the query and filter outside.")
            d.check("Window function in WHERE is rejected", e and "window functions are not allowed in WHERE" in e, e)
            d.data["mode"] = "mistake"
        running = 0.0
        ok = True
        for r in monthly:
            running += float(r["revenue"])
            ok = ok and abs(running - float(r["running_total"])) < 0.01
        d.check("Running total accumulates month by month", ok, f"{len(monthly)} months, total {running:,.2f}")
        d.check("Top-2 per category returned 2 rows per category", len(top2) == 2 * len({r["category"] for r in top2}))
        d.check("rank() leaves gaps after ties, dense_rank() does not",
                all(r["dense_rank"] <= r["rank"] <= r["row_number"] for r in ranks))
    return d.result()
