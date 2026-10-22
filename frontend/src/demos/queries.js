import { flow, queryFlow, runButton, wrongButton } from './flows.js';

const CAT = 'SQL queries';

export const QUERY_DEMOS = [
  {
    id: 'select',
    category: CAT,
    title: 'SELECT, WHERE, ORDER BY',
    tagline: 'Reading rows: filter, sort, limit, de-duplicate and compute columns',
    description: [
      'SELECT is how you read data. You list the columns you want, FROM which table, an optional WHERE to keep only matching rows, ORDER BY to sort, and LIMIT to cap how many come back. Postgres reads the table (or an index), applies the filter, sorts, and streams rows back to the client.',
      'This demo runs ten small queries against a sample shop (customers, products, orders). Click through the tabs under the visual: each one shows the exact SQL, a plain-language explanation and the rows Postgres returned. Pick a country to see a bound parameter change the result.',
      'Two habits worth forming from day one: always pair LIMIT with ORDER BY (without it the "first" rows are arbitrary), and never test for NULL with = NULL: it matches nothing. Use IS NULL.',
    ],
    keyApis: ['SELECT … FROM … WHERE', 'ORDER BY … LIMIT', 'IS NULL', 'DISTINCT ON', 'CASE WHEN', 'COALESCE', 'FETCH FIRST … WITH TIES'],
    useCases: ['Listing pages', 'Search filters', 'Reports', 'Top-N lists'],
    snippet: {
      lang: 'sql', name: 'select.sql', code: `-- Filter with a bound parameter (the app sends 'UK' separately as $1)
SELECT id, name, country FROM customers WHERE country = $1 ORDER BY name;

-- Half-open range: >= start AND < end
SELECT name, price FROM products WHERE price >= 20 AND price < 60 ORDER BY price DESC;

-- NULL tests: = NULL is never true
SELECT count(*) FROM customers WHERE referred_by IS NULL;

-- Most expensive product per category (Postgres-only DISTINCT ON)
SELECT DISTINCT ON (category) category, name, price
FROM products ORDER BY category, price DESC;

-- Computed columns
SELECT name, price, round(price * 1.2, 2) AS price_with_vat,
       CASE WHEN price < 30 THEN 'budget' WHEN price < 100 THEN 'mid' ELSE 'premium' END AS band
FROM products;`,
    },
    inputs: [
      { name: 'country', label: 'Country (WHERE country = $1)', type: 'select', default: 'UK', options: ['US', 'UK', 'NL', 'DK', 'NO', 'FI', 'CH', 'DE', 'JP', 'AT', 'HU'] },
      { name: 'limit', label: 'LIMIT', type: 'number', default: 5, min: 1, max: 20 },
    ],
    flow: queryFlow('/api/demos/select', 'SELECT … WHERE country = $1', 'scan customers, filter, sort'),
    actions: [runButton('/api/demos/select', 'Run the queries', (i) => ({ country: i.country, limit: i.limit }))],
    pitfalls: [
      {
        mistake: 'Comparing with = NULL',
        symptom: 'The query runs without error but returns 0 rows, even though rows with NULL exist.',
        why: 'NULL means "unknown". unknown = unknown is unknown (not true), and WHERE keeps only rows where the condition is true.',
        fix: 'Use IS NULL / IS NOT NULL, or IS DISTINCT FROM for null-safe comparison of two columns.',
        avoid: 'Treat NULL as "no value", not as a value. Lint for "= NULL" in code review.',
        lang: 'sql', wrongCode: 'SELECT * FROM customers WHERE referred_by = NULL;', rightCode: 'SELECT * FROM customers WHERE referred_by IS NULL;',
        reproduce: 'run',
      },
      {
        mistake: 'LIMIT without ORDER BY',
        symptom: 'Pagination shows different rows on each refresh, or rows appear on two pages.',
        why: 'Without ORDER BY Postgres returns rows in whatever order is cheapest (physical order, parallel workers, a hash), and that order changes after updates and VACUUM.',
        fix: 'Add an ORDER BY on a unique key (or a tie-breaker such as ORDER BY created_at, id).',
        avoid: 'Every LIMIT/OFFSET or FETCH FIRST gets an ORDER BY that is unique.',
        lang: 'sql', wrongCode: 'SELECT * FROM orders LIMIT 20;', rightCode: 'SELECT * FROM orders ORDER BY ordered_at DESC, id DESC LIMIT 20;',
      },
      {
        mistake: 'Using BETWEEN for timestamps or prices',
        symptom: 'Rows exactly on a boundary (midnight, 60.00) are counted in two adjacent reports.',
        why: 'BETWEEN includes both ends: BETWEEN \'2026-01-01\' AND \'2026-02-01\' also matches midnight of 1 February.',
        fix: 'Rewrite as col >= start AND col < end.',
        avoid: 'Use half-open ranges everywhere (the PostgreSQL wiki "Don\'t Do This" list).',
        lang: 'sql', wrongCode: "WHERE ordered_at BETWEEN '2026-01-01' AND '2026-02-01'", rightCode: "WHERE ordered_at >= '2026-01-01' AND ordered_at < '2026-02-01'",
      },
      {
        mistake: 'Upper-case or quoted identifiers',
        symptom: 'ERROR:  relation "users" does not exist\n(the table was created as "Users")',
        why: 'Unquoted names are folded to lower case. A table created as "Users" (quoted) can only be reached as "Users", with quotes, forever.',
        fix: 'Rename it: ALTER TABLE "Users" RENAME TO users;',
        avoid: 'Use lower_snake_case names and never quote identifiers. Watch ORMs/GUI tools that quote by default.',
      },
    ],
    visual: 'select',
  },
  {
    id: 'dml',
    category: CAT,
    title: 'INSERT, UPDATE, DELETE',
    tagline: 'Changing data, and getting the changed rows back with RETURNING',
    description: [
      'INSERT adds rows, UPDATE changes them, DELETE removes them. Postgres adds a very handy extra: RETURNING, which hands back the affected rows (generated ids, new values) in the same round trip, so you never need a follow-up SELECT.',
      'New in Postgres 18: RETURNING can show the value before and after the change with old.column and new.column. The demo creates a private inventory table, inserts single rows, many rows and rows copied from a query, cuts book prices by 10% (watch old vs new), restocks electronics through a join (UPDATE … FROM) and deletes out-of-stock items.',
      '"Do it wrong" runs the most feared mistake, an UPDATE without WHERE, but inside a transaction, so you can see every row change and then ROLLBACK save the day.',
    ],
    keyApis: ['INSERT … VALUES', 'INSERT … SELECT', 'RETURNING', 'old./new. (18)', 'UPDATE … FROM', 'DELETE … USING', 'GENERATED ALWAYS AS IDENTITY'],
    useCases: ['Creating records and getting their id', 'Bulk price changes', 'Archiving', 'Audit-friendly changes'],
    snippet: {
      lang: 'python', name: 'dml.py', code: `# psycopg 3
row = conn.execute(
    "INSERT INTO inventory (sku, name, price, stock) VALUES (%s, %s, %s, %s) RETURNING id",
    ["KB-1", "Keyboard", 129.00, 2],
).fetchone()            # {'id': 1}: no second query needed

conn.execute("""
    UPDATE inventory SET price = price * 0.9
    WHERE sku LIKE 'BK-%%'
    RETURNING sku, old.price AS old_price, new.price AS new_price   -- Postgres 18
""")

conn.execute("""
    UPDATE inventory i SET stock = i.stock + 100
    FROM shop.products p
    WHERE p.name = i.name AND p.category = 'Electronics'
""")

conn.execute("DELETE FROM inventory WHERE stock = 0 RETURNING sku, name")`,
    },
    flow: flow('/api/demos/dml',
      ['api', 'session', 'INSERT … RETURNING id'],
      ['session', 'storage', 'write new row versions'],
      ['session', 'wal', 'log the change (WAL)'],
      ['session', 'api', 'returned rows'],
    ),
    actions: [runButton('/api/demos/dml'), wrongButton('/api/demos/dml', 'UPDATE without WHERE (in a transaction)')],
    pitfalls: [
      {
        mistake: 'UPDATE or DELETE without a WHERE clause',
        symptom: 'UPDATE 24  (every row in the table changed, when you meant one)',
        why: 'WHERE is optional, and in autocommit mode (the default for psql and most drivers) the change is permanent the moment it finishes.',
        fix: 'Restore from backup or point-in-time recovery; if you are still inside BEGIN, ROLLBACK.',
        avoid: 'Run ad-hoc changes inside BEGIN … check the row count … COMMIT. In psql: \\set AUTOCOMMIT off. Write the WHERE first, then the SET.',
        lang: 'sql', wrongCode: "UPDATE inventory SET price = 0.01;", rightCode: "BEGIN;\nUPDATE inventory SET price = 0.01 WHERE sku = 'KB-1';\n-- UPDATE 1 ✓\nCOMMIT;",
        reproduce: 'mistake',
      },
      {
        mistake: 'Inserting, then SELECTing max(id) to find the new id',
        symptom: 'Occasionally the app links data to another user\'s row.',
        why: 'Between your INSERT and SELECT max(id) another session can insert, so max(id) is theirs.',
        fix: 'Use INSERT … RETURNING id.',
        avoid: 'Always get generated values from RETURNING.',
        lang: 'sql', wrongCode: "INSERT INTO orders (...) VALUES (...);\nSELECT max(id) FROM orders;", rightCode: 'INSERT INTO orders (...) VALUES (...) RETURNING id;',
      },
      {
        mistake: 'Inserting values into a GENERATED ALWAYS identity column',
        symptom: 'ERROR:  cannot insert a non-DEFAULT value into column "id"\nDETAIL:  Column "id" is an identity column defined as GENERATED ALWAYS.\nHINT:  Use OVERRIDING SYSTEM VALUE to override.',
        why: 'GENERATED ALWAYS means Postgres owns the value.',
        fix: 'Leave the column out, or use OVERRIDING SYSTEM VALUE for one-off data migrations (then reset the sequence with setval).',
        avoid: 'Let the database generate ids; use GENERATED BY DEFAULT if you must load explicit ids regularly.',
      },
    ],
    visual: 'dml',
  },
  {
    id: 'upsert',
    category: CAT,
    title: 'Upsert & MERGE',
    tagline: 'Insert or update in one atomic statement: ON CONFLICT and MERGE',
    description: [
      'An upsert means "insert this row, or update it if it already exists". Doing it as SELECT-then-INSERT in the app is racy: two requests can both see "not there" and both insert. INSERT … ON CONFLICT does it atomically, using a unique index to detect the clash.',
      'ON CONFLICT DO NOTHING skips duplicates; ON CONFLICT DO UPDATE SET … uses EXCLUDED (the row you tried to insert) to merge values, like adding quantities. MERGE (SQL standard, Postgres 15+) goes further: one statement compares a source with a target and decides per row to UPDATE, DELETE or INSERT. Since Postgres 17 it supports RETURNING with merge_action().',
      '"Do it wrong" reproduces the two errors people hit most: an ON CONFLICT target without a matching unique index, and a batch that contains the same key twice.',
    ],
    keyApis: ['ON CONFLICT (col) DO NOTHING', 'ON CONFLICT … DO UPDATE SET', 'EXCLUDED', 'MERGE INTO … USING', 'merge_action()', 'WHEN NOT MATCHED BY SOURCE'],
    useCases: ['Counters and inventories', 'Syncing from an external feed', 'Idempotent API writes', 'Slowly changing dimensions'],
    snippet: {
      lang: 'sql', name: 'upsert.sql', code: `INSERT INTO stock VALUES ('apple', 3), ('plum', 7)
ON CONFLICT (sku) DO UPDATE SET qty = stock.qty + EXCLUDED.qty
RETURNING sku, qty, (xmax = 0) AS inserted;

MERGE INTO stock s
USING delivery d ON s.sku = d.sku
WHEN MATCHED AND d.qty = 0 THEN DELETE
WHEN MATCHED THEN UPDATE SET qty = s.qty + d.qty
WHEN NOT MATCHED THEN INSERT VALUES (d.sku, d.qty)
RETURNING merge_action() AS action, s.sku, s.qty;`,
    },
    flow: flow('/api/demos/upsert',
      ['api', 'session', 'INSERT … ON CONFLICT'],
      ['session', 'storage', 'probe unique index: exists?'],
      ['storage', 'session', 'conflict → take the UPDATE path'],
      ['session', 'api', 'RETURNING rows'],
    ),
    actions: [runButton('/api/demos/upsert'), wrongButton('/api/demos/upsert', 'Reproduce the upsert errors')],
    pitfalls: [
      {
        mistake: 'ON CONFLICT on columns without a unique index',
        symptom: 'ERROR:  there is no unique or exclusion constraint matching the ON CONFLICT specification',
        why: 'ON CONFLICT needs a unique index or constraint on exactly the listed columns (with the same WHERE for partial indexes) to detect the conflict.',
        fix: 'CREATE UNIQUE INDEX ON t (cols); or use ON CONFLICT ON CONSTRAINT name.',
        avoid: 'Design the natural key as a UNIQUE constraint first, then write the upsert against it.',
        reproduce: 'mistake',
      },
      {
        mistake: 'The same key twice in one upsert batch',
        symptom: 'ERROR:  ON CONFLICT DO UPDATE command cannot affect row a second time\nHINT:  Ensure that no rows proposed for insertion within the same command have duplicate constrained values.',
        why: 'A single statement may not update the same row twice: the result would depend on the order of the input rows.',
        fix: 'De-duplicate the batch first: GROUP BY the key and aggregate (sum, max) or DISTINCT ON.',
        avoid: 'Aggregate batches in SQL (INSERT … SELECT … GROUP BY) or in the app before upserting.',
        lang: 'sql', wrongCode: "INSERT INTO stock VALUES ('kiwi', 1), ('kiwi', 2)\nON CONFLICT (sku) DO UPDATE SET qty = stock.qty + EXCLUDED.qty;",
        rightCode: "INSERT INTO stock\nSELECT sku, sum(qty) FROM (VALUES ('kiwi', 1), ('kiwi', 2)) v(sku, qty) GROUP BY sku\nON CONFLICT (sku) DO UPDATE SET qty = stock.qty + EXCLUDED.qty;",
        reproduce: 'mistake',
      },
      {
        mistake: 'Check-then-insert in application code',
        symptom: 'ERROR:  duplicate key value violates unique constraint "stock_pkey"\n(at random, under load)',
        why: 'Two requests run SELECT at the same time, both find nothing, both INSERT.',
        fix: 'Replace with INSERT … ON CONFLICT, or catch SQLSTATE 23505 and retry as an update.',
        avoid: 'Let a unique constraint arbitrate concurrency, never an application-level check.',
      },
    ],
    visual: 'upsert',
  },
  {
    id: 'joins',
    category: CAT,
    title: 'JOINs',
    tagline: 'INNER, LEFT, RIGHT, FULL, CROSS, self, LATERAL, semi- and anti-joins',
    description: [
      'A join combines rows from two tables where a condition matches. INNER JOIN keeps only matching pairs. LEFT JOIN keeps every row of the left table and fills the right side with NULLs when nothing matches; RIGHT JOIN is the mirror image; FULL JOIN keeps unmatched rows from both sides. CROSS JOIN pairs everything with everything.',
      'The Venn diagram is computed from the real result: 40 customers on the left, a list of 8 country→region pairs on the right. Austria, Switzerland, Germany, Hungary and others are missing from the region list (left-only), while Brazil and India have no customers (right-only). Switch tabs to see each join\'s rows.',
      'Also shown: a self join (employee → manager), LATERAL (each customer\'s two latest orders, "top N per group"), and EXISTS / NOT EXISTS for "has any" / "has none" questions, which never duplicate rows the way a join can.',
    ],
    keyApis: ['INNER JOIN … ON', 'LEFT JOIN', 'FULL JOIN', 'CROSS JOIN', 'JOIN LATERAL', 'EXISTS', 'NOT EXISTS', 'USING (col)'],
    useCases: ['Orders with customer names', 'Finding orphans', 'Reports across tables', 'Top N per group'],
    snippet: {
      lang: 'sql', name: 'joins.sql', code: `SELECT c.name, c.country, r.region
FROM customers c
LEFT JOIN (VALUES ('US','Americas'), ('UK','Europe'), ('BR','Americas') /* … */) AS r(code, region)
       ON r.code = c.country;

-- Each customer's two latest orders
SELECT c.name, o.id, o.ordered_at
FROM customers c
CROSS JOIN LATERAL (
  SELECT id, ordered_at FROM orders WHERE customer_id = c.id
  ORDER BY ordered_at DESC LIMIT 2
) o;

-- Customers who never ordered (anti-join)
SELECT c.name FROM customers c
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);`,
    },
    flow: flow('/api/demos/joins',
      ['api', 'session', 'SELECT … FROM customers JOIN …'],
      ['session', 'planner', 'choose Hash / Merge / Nested Loop join'],
      ['planner', 'storage', 'scan both tables'],
      ['planner', 'planner', 'match rows on r.code = c.country'],
      ['session', 'api', 'joined rows'],
    ),
    actions: [runButton('/api/demos/joins', 'Run every join'), wrongButton('/api/demos/joins', 'Common join mistakes')],
    pitfalls: [
      {
        mistake: 'Filtering the optional side of a LEFT JOIN in WHERE',
        symptom: 'The LEFT JOIN silently behaves like an INNER JOIN: customers without paid orders vanish from the report.',
        why: 'WHERE runs after the join. NULL-padded rows have o.status = NULL, which fails o.status = \'paid\', so they are removed.',
        fix: 'Move the condition into the ON clause: LEFT JOIN orders o ON o.customer_id = c.id AND o.status = \'paid\'.',
        avoid: 'Conditions on the right table of a LEFT JOIN go in ON; conditions on the left table go in WHERE.',
        lang: 'sql', wrongCode: "SELECT c.name, count(o.id) FROM customers c\nLEFT JOIN orders o ON o.customer_id = c.id\nWHERE o.status = 'paid' GROUP BY c.name;",
        rightCode: "SELECT c.name, count(o.id) FROM customers c\nLEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'paid'\nGROUP BY c.name;",
        reproduce: 'mistake',
      },
      {
        mistake: 'A missing or wrong join condition',
        symptom: 'The query is suddenly slow and returns millions of rows; sums are multiplied.',
        why: 'FROM a, b without a condition (or joining on a non-unique column) produces a Cartesian product: every row of a with every row of b.',
        fix: 'Add the join condition; check the cardinality with count(*) before and after the join.',
        avoid: 'Use explicit JOIN … ON syntax (never comma joins) and join on keys.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Joining two one-to-many tables and then summing',
        symptom: 'Totals are too high: order revenue doubled or tripled.',
        why: 'orders ⋈ items ⋈ payments repeats each item once per payment (fan-out), so SUM counts values several times.',
        fix: 'Aggregate each child table in a subquery/CTE first, then join the aggregates.',
        avoid: 'Before summing, ask "can this join multiply rows?" and compare count(*) with count(DISTINCT key).',
      },
    ],
    visual: 'joins',
  },
  {
    id: 'aggregates',
    category: CAT,
    title: 'GROUP BY & aggregates',
    tagline: 'count, sum, avg, HAVING, FILTER, ROLLUP, string_agg, percentiles',
    description: [
      'Aggregates collapse many rows into one value: count(*), sum(), avg(), min(), max(). GROUP BY splits the rows into groups first and returns one row per group. WHERE filters rows before grouping; HAVING filters groups after.',
      'The bars show revenue per product category computed by Postgres. The tabs also show FILTER (several conditional counts in one pass, a pivot), ROLLUP (subtotals and a grand total), string_agg / array_agg (a group as a list) and ordered-set aggregates (median and 90th percentile).',
      'Move the "minimum revenue" input to watch HAVING keep fewer or more customers. "Do it wrong" shows the two classic GROUP BY errors.',
    ],
    keyApis: ['GROUP BY', 'HAVING', 'count(*) FILTER (WHERE …)', 'ROLLUP / CUBE / GROUPING SETS', 'string_agg', 'array_agg', 'percentile_cont'],
    useCases: ['Dashboards', 'Revenue reports', 'Pivot tables', 'Data quality checks'],
    snippet: {
      lang: 'sql', name: 'aggregates.sql', code: `SELECT p.category, count(*) AS lines, sum(oi.qty * oi.unit_price) AS revenue
FROM order_items oi JOIN products p ON p.id = oi.product_id
GROUP BY p.category ORDER BY revenue DESC;

SELECT c.name, sum(oi.qty * oi.unit_price) AS revenue
FROM customers c JOIN orders o ON o.customer_id = c.id JOIN order_items oi ON oi.order_id = o.id
WHERE o.status <> 'cancelled'            -- rows
GROUP BY c.id, c.name
HAVING sum(oi.qty * oi.unit_price) >= $1  -- groups
ORDER BY revenue DESC;

SELECT count(*) FILTER (WHERE status = 'paid') AS paid,
       count(*) FILTER (WHERE status = 'cancelled') AS cancelled
FROM orders;`,
    },
    inputs: [{ name: 'min_revenue', label: 'HAVING revenue ≥', type: 'number', default: 1000, min: 0, max: 50000 }],
    flow: queryFlow('/api/demos/aggregates', 'SELECT category, sum(…) GROUP BY category', 'scan order_items, hash by category'),
    actions: [
      runButton('/api/demos/aggregates', 'Run the queries', (i) => ({ min_revenue: i.min_revenue })),
      wrongButton('/api/demos/aggregates', 'Do it wrong', (i) => ({ min_revenue: i.min_revenue })),
    ],
    pitfalls: [
      {
        mistake: 'Selecting a column that is neither grouped nor aggregated',
        symptom: 'ERROR:  column "products.name" must appear in the GROUP BY clause or be used in an aggregate function',
        why: 'A group has many names; Postgres won\'t pick one at random (MySQL used to).',
        fix: 'Add the column to GROUP BY, wrap it in an aggregate (min, string_agg), or use DISTINCT ON / a window function for "the top row per group".',
        avoid: 'Group by the primary key: Postgres then lets you select any column of that table (functional dependency).',
        reproduce: 'mistake',
      },
      {
        mistake: 'Filtering on an aggregate in WHERE',
        symptom: 'ERROR:  aggregate functions are not allowed in WHERE',
        why: 'WHERE is evaluated per row, before groups exist.',
        fix: 'Move the condition to HAVING.',
        avoid: 'WHERE = filter rows, HAVING = filter groups.',
        reproduce: 'mistake',
      },
      {
        mistake: 'count(column) when you meant count(*)',
        symptom: 'Counts are lower than expected; avg() ignores some rows.',
        why: 'count(col), sum, avg and friends skip NULLs. Only count(*) counts rows.',
        fix: 'Use count(*) for rows, count(col) for non-null values, coalesce(col, 0) when NULL should count as zero.',
        avoid: 'Be deliberate about NULL in every aggregate.',
      },
    ],
    visual: 'aggregates',
  },
  {
    id: 'subqueries',
    category: CAT,
    title: 'Subqueries & set operations',
    tagline: 'Scalar, correlated and derived subqueries; UNION, INTERSECT, EXCEPT',
    description: [
      'A subquery is a query inside another query. A scalar subquery returns a single value and can be used anywhere a constant can; a correlated subquery refers to the outer row and runs per row (conceptually); a derived table is a subquery in FROM that you query like a table.',
      'Set operations stack two result sets with the same columns: UNION (either, duplicates removed), UNION ALL (either, duplicates kept, cheaper), INTERSECT (both), EXCEPT (first but not second). The Venn diagram shows the real answer for "countries that bought Books" vs "countries that bought Garden items".',
      '"Do it wrong" shows the scalar subquery that works in testing and breaks in production once a customer has two orders.',
    ],
    keyApis: ['(SELECT …) scalar', 'IN (SELECT …)', 'EXISTS', '> ALL / = ANY', 'UNION / UNION ALL', 'INTERSECT', 'EXCEPT'],
    useCases: ['Comparisons with averages', 'Combining lists', 'Finding differences between datasets', 'Data reconciliation'],
    snippet: {
      lang: 'sql', name: 'subqueries.sql', code: `-- Products priced above their own category's average (correlated)
SELECT name, category, price FROM products p
WHERE price > (SELECT avg(price) FROM products WHERE category = p.category);

-- Countries that bought Books but no Garden items
(SELECT DISTINCT c.country FROM … WHERE p.category = 'Books')
EXCEPT
(SELECT DISTINCT c.country FROM … WHERE p.category = 'Garden');`,
    },
    flow: queryFlow('/api/demos/subqueries', 'SELECT … WHERE price > (SELECT avg(price) …)', 'run inner query, then outer'),
    actions: [runButton('/api/demos/subqueries'), wrongButton('/api/demos/subqueries', 'Multi-row scalar subquery')],
    pitfalls: [
      {
        mistake: 'A scalar subquery that can return several rows',
        symptom: 'ERROR:  more than one row returned by a subquery used as an expression',
        why: 'A scalar subquery must return at most one row. It worked while every customer had one order.',
        fix: 'Aggregate (max, count), add ORDER BY … LIMIT 1, or rewrite as a JOIN / LATERAL.',
        avoid: 'Ask "is this guaranteed unique?" (a primary key or unique constraint) before using a subquery as a value.',
        reproduce: 'mistake',
      },
      {
        mistake: 'UNION when UNION ALL is meant',
        symptom: 'The query is slow (a big Sort or HashAggregate) and legitimate duplicate rows disappear.',
        why: 'UNION removes duplicates across the whole result, which costs a sort/hash of everything.',
        fix: 'Use UNION ALL unless you really want de-duplication.',
        avoid: 'Default to UNION ALL.',
      },
      {
        mistake: 'NOT IN (subquery) with NULLs',
        symptom: 'The query returns 0 rows.',
        why: 'If the subquery returns a NULL, x NOT IN (…) is never true. See the "NOT IN and NULL" demo.',
        fix: 'Use NOT EXISTS.',
        avoid: 'Never use NOT IN with a subquery.',
      },
    ],
    visual: 'subqueries',
  },
  {
    id: 'ctes',
    category: CAT,
    title: 'CTEs & recursive queries',
    tagline: 'WITH for readable steps, WITH RECURSIVE for trees and graphs',
    description: [
      'A common table expression (WITH name AS (…)) gives a subquery a name so a complex query reads as a series of steps. WITH RECURSIVE goes further: an anchor query plus a recursive part that joins to the previous step\'s rows, repeated until no new rows appear. That is how SQL walks trees (org charts, categories, bill of materials) and graphs.',
      'The visual draws the org chart Postgres built by recursion, level by level. Other tabs show a calendar generated recursively (to fill days with no orders), a data-modifying CTE that moves rows to an archive atomically, and how MATERIALIZED vs NOT MATERIALIZED changes the plan.',
      '"Do it wrong" runs a recursion over a cyclic graph that would never end (it is stopped by a 400 ms statement_timeout), then fixes it with the CYCLE clause.',
    ],
    keyApis: ['WITH name AS (…)', 'WITH RECURSIVE', 'UNION ALL', 'CYCLE … SET … USING', 'SEARCH DEPTH FIRST', 'MATERIALIZED / NOT MATERIALIZED', 'DELETE … RETURNING in WITH'],
    useCases: ['Org charts and category trees', 'Graph traversal', 'Step-by-step reports', 'Moving rows between tables'],
    snippet: {
      lang: 'sql', name: 'org_chart.sql', code: `WITH RECURSIVE org AS (
  SELECT id, name, manager_id, 1 AS depth, name::text AS path
  FROM employees WHERE manager_id IS NULL          -- anchor: the CEO
  UNION ALL
  SELECT e.id, e.name, e.manager_id, org.depth + 1, org.path || ' › ' || e.name
  FROM employees e JOIN org ON e.manager_id = org.id   -- next level
)
SELECT * FROM org ORDER BY path;

WITH gone AS (DELETE FROM tasks WHERE state = 'done' RETURNING *)
INSERT INTO tasks_archive SELECT * FROM gone;`,
    },
    flow: flow('/api/demos/ctes',
      ['api', 'session', 'WITH RECURSIVE org AS (…)'],
      ['session', 'planner', 'Recursive Union'],
      ['planner', 'storage', 'level 1: the CEO'],
      ['planner', 'storage', 'level n+1: join employees to level n'],
      ['session', 'api', 'the whole tree'],
    ),
    actions: [runButton('/api/demos/ctes'), wrongButton('/api/demos/ctes', 'Endless recursion')],
    pitfalls: [
      {
        mistake: 'Recursion on data that contains a cycle',
        symptom: 'ERROR:  canceling statement due to statement timeout\n(or the query runs until it fills memory or temp disk)',
        why: 'With UNION ALL the recursive part keeps finding the same nodes again: 1 → 2 → 3 → 1 → …',
        fix: 'Add CYCLE col SET is_cycle USING path (Postgres 14+), track visited ids in an array, or use UNION instead of UNION ALL.',
        avoid: 'Assume real-world hierarchies can contain cycles; add a depth limit (WHERE depth < 50) as a safety net, and set statement_timeout.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Expecting a CTE to be an optimization fence (or not)',
        symptom: 'After upgrading from Postgres 11, a query plan changed; or a CTE scans a whole table instead of using an index.',
        why: 'Since Postgres 12, a non-recursive CTE referenced once is inlined into the main query. MATERIALIZED forces it to be computed separately first.',
        fix: 'Write WITH x AS MATERIALIZED (…) when you want the fence, NOT MATERIALIZED to force inlining.',
        avoid: 'Check EXPLAIN when a CTE is on a hot path.',
      },
    ],
    visual: 'ctes',
  },
  {
    id: 'windows',
    category: CAT,
    title: 'Window functions',
    tagline: 'Running totals, rankings, moving averages, lag/lead: without collapsing rows',
    description: [
      'A window function computes a value across a set of related rows (the window) but, unlike GROUP BY, keeps every row. OVER (PARTITION BY …) restarts the calculation per group; OVER (ORDER BY …) makes it cumulative; a frame clause (ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) slides it.',
      'The chart shows monthly revenue with the running total and a 3-month moving average, all computed in one query by Postgres. The tabs show row_number / rank / dense_rank (look at how ties are numbered), ntile buckets, first_value, and the classic "top 2 per category".',
      'Window functions are evaluated after WHERE and GROUP BY, which is why you filter on them in an outer query, as "Do it wrong" shows.',
    ],
    keyApis: ['OVER (PARTITION BY … ORDER BY …)', 'row_number() / rank() / dense_rank()', 'lag() / lead()', 'sum() OVER', 'ROWS BETWEEN … PRECEDING', 'ntile()', 'WINDOW w AS (…)'],
    useCases: ['Running balances', 'Leaderboards', 'Month-over-month change', 'De-duplicating (keep the latest row)'],
    snippet: {
      lang: 'sql', name: 'windows.sql', code: `SELECT month, revenue,
       sum(revenue) OVER (ORDER BY month)                    AS running_total,
       revenue - lag(revenue) OVER (ORDER BY month)          AS vs_prev_month,
       avg(revenue) OVER (ORDER BY month
                          ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS moving_avg_3m
FROM monthly_revenue;

SELECT category, name, price FROM (
  SELECT *, row_number() OVER (PARTITION BY category ORDER BY price DESC) AS rn
  FROM products
) ranked WHERE rn <= 2;`,
    },
    flow: queryFlow('/api/demos/windows', 'SELECT sum(revenue) OVER (ORDER BY month)', 'aggregate per month, then WindowAgg'),
    actions: [runButton('/api/demos/windows'), wrongButton('/api/demos/windows', 'Window function in WHERE')],
    pitfalls: [
      {
        mistake: 'Using a window function in WHERE',
        symptom: 'ERROR:  window functions are not allowed in WHERE',
        why: 'Windows are computed after WHERE, GROUP BY and HAVING.',
        fix: 'Compute the window in a subquery or CTE and filter in the outer query.',
        avoid: 'Remember the logical order: FROM → WHERE → GROUP BY → HAVING → window → SELECT → ORDER BY → LIMIT.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Relying on the default frame with last_value()',
        symptom: 'last_value(price) OVER (ORDER BY price) just returns the current row\'s price.',
        why: 'With ORDER BY the default frame is RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW, so the "last" row is the current one.',
        fix: 'Add ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING, or use first_value with the reverse order.',
        avoid: 'Write the frame clause explicitly whenever the result depends on it.',
      },
      {
        mistake: 'Using rank() for "top N" with ties',
        symptom: 'WHERE rank <= 2 returns 3 rows for a category, or row_number() picks one of two tied rows at random.',
        why: 'rank() gives ties the same number; row_number() breaks ties arbitrarily.',
        fix: 'Choose deliberately, and add a tie-breaker column to ORDER BY for deterministic results.',
        avoid: 'Every ORDER BY inside OVER that feeds a filter should be unique.',
      },
    ],
    visual: 'windows',
  },
];
