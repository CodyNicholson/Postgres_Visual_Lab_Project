import { flow, queryFlow, runButton } from './flows.js';

const CAT = 'Common mistakes';

export const MISTAKE_DEMOS = [
  {
    id: 'n-plus-one',
    category: CAT,
    title: 'N+1 queries',
    tagline: 'One query per row in a loop vs one JOIN',
    description: [
      'The N+1 problem: load a list (1 query), then for each item load something related (N more queries). Each query is fast on its own, but every one pays a network round trip and the per-statement overhead. ORMs make it easy to do by accident through lazy loading (order.customer.name inside a loop).',
      'The demo loads N orders and their customer names three ways: N+1 queries, two queries with the second batched (= ANY($1)), and one JOIN. The bars show the total time and the number of round trips, measured just now. The gap is much bigger on a real network than inside one Docker host.',
      'Spot it in pg_stat_statements (a simple query with a huge calls count) or in your ORM\'s query log.',
    ],
    keyApis: ['JOIN', '= ANY($1)', 'ORM eager loading (select_related, prefetch_related, includes, joinedload)', 'pg_stat_statements.calls'],
    useCases: ['List pages', 'APIs returning nested objects', 'Reports', 'GraphQL resolvers'],
    snippet: {
      lang: 'python', name: 'n_plus_one.py', code: `# ✗ N+1: one query per order
orders = conn.execute("SELECT id, customer_id FROM orders ORDER BY id LIMIT 50").fetchall()
for o in orders:
    o["name"] = conn.execute("SELECT name FROM customers WHERE id = %s", [o["customer_id"]]).fetchone()["name"]

# ✓ One JOIN
conn.execute("""SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id
                ORDER BY o.id LIMIT 50""")

# ✓ Or two queries, the second batched
ids = list({o["customer_id"] for o in orders})
conn.execute("SELECT id, name FROM customers WHERE id = ANY(%s)", [ids])`,
    },
    inputs: [{ name: 'orders', label: 'Orders (N)', type: 'number', default: 50, min: 10, max: 150 }],
    flow: flow('/api/demos/n-plus-one',
      ['api', 'session', 'SELECT … FROM orders LIMIT N'],
      ['api', 'session', '× N: SELECT name FROM customers WHERE id = $1'],
      ['api', 'session', 'vs one: SELECT … JOIN customers'],
      ['session', 'api', 'round trips + time'],
    ),
    actions: [runButton('/api/demos/n-plus-one', 'Compare the three ways', (i) => ({ orders: i.orders }))],
    pitfalls: [
      {
        mistake: 'Lazy-loading relations inside a loop',
        symptom: 'A page runs 500 queries; the logs show the same SELECT … WHERE id = $1 over and over.',
        why: 'Each iteration triggers a separate query and round trip.',
        fix: 'Join, or eager-load: select_related/prefetch_related (Django), includes (Rails), joinedload/selectinload (SQLAlchemy), include (Prisma).',
        avoid: 'Count queries per request in tests (django-assert-num-queries, bullet gem, a query counter fixture).',
        reproduce: 'run',
      },
    ],
    visual: 'n-plus-one',
  },
  {
    id: 'not-in-null',
    category: CAT,
    title: 'NOT IN and NULL',
    tagline: 'Why NOT IN (subquery) can return nothing at all',
    description: [
      'Question: which customers never referred anyone? The natural SQL is WHERE id NOT IN (SELECT referred_by FROM customers). It returns zero rows. Not a few wrong rows: none.',
      'The referred_by column contains NULLs (customers nobody referred). id NOT IN (5, 7, NULL) means id <> 5 AND id <> 7 AND id <> NULL, and id <> NULL is unknown, so the whole condition is never true. NOT EXISTS asks a different question ("is there a matching row?") that NULLs cannot confuse, and plans as an efficient anti-join.',
      'This is the first entry on the PostgreSQL wiki\'s "Don\'t Do This" list for queries, and it bites experienced developers because it works perfectly until the first NULL appears.',
    ],
    keyApis: ['NOT EXISTS', 'NOT IN', 'IS NOT NULL', 'three-valued logic', 'Hash Anti Join'],
    useCases: ['"Never did X" reports', 'Finding orphans', 'Data cleanup'],
    snippet: {
      lang: 'sql', name: 'not_in.sql', code: `-- ✗ Returns 0 rows as soon as the subquery yields a NULL
SELECT name FROM customers
WHERE id NOT IN (SELECT referred_by FROM customers);

-- ✓ NOT EXISTS
SELECT name FROM customers c
WHERE NOT EXISTS (SELECT 1 FROM customers r WHERE r.referred_by = c.id);`,
    },
    flow: queryFlow('/api/demos/not-in-null', 'WHERE id NOT IN (SELECT referred_by …)', 'subquery yields NULLs'),
    actions: [runButton('/api/demos/not-in-null', 'Run both versions')],
    pitfalls: [
      {
        mistake: 'NOT IN with a subquery',
        symptom: 'The query returns 0 rows (or fewer than expected) without any error.',
        why: 'One NULL in the subquery result makes NOT IN unknown for every row. It is also often planned badly (no anti-join).',
        fix: 'Rewrite as NOT EXISTS (or LEFT JOIN … WHERE right.id IS NULL).',
        avoid: 'Don\'t use NOT IN with subqueries at all; NOT IN with a literal list of non-null constants is fine.',
        lang: 'sql', wrongCode: 'WHERE id NOT IN (SELECT referred_by FROM customers)', rightCode: 'WHERE NOT EXISTS (SELECT 1 FROM customers r WHERE r.referred_by = c.id)',
        reproduce: 'run',
      },
    ],
    visual: 'not-in',
  },
  {
    id: 'pagination',
    category: CAT,
    title: 'OFFSET pagination',
    tagline: 'Deep OFFSET reads everything it skips; keyset pagination doesn\'t',
    description: [
      'LIMIT 20 OFFSET 190000 looks cheap, but Postgres must produce and throw away 190,000 rows to return 20: page 9,500 is thousands of times slower than page 1. Keyset (seek) pagination remembers where the previous page ended (WHERE id > $last ORDER BY id LIMIT 20), so every page is an index seek.',
      'The chart plots both methods at increasing depths through the 200,000 events, measured with EXPLAIN ANALYZE, along with how many rows each had to read. Below, a small feed shows the other OFFSET problem: when a new post arrives between page 1 and page 2, OFFSET shows a post twice; keyset continues correctly.',
      'Keyset pagination needs a unique, indexed sort key (use (created_at, id) as a tie-breaker) and gives "next/previous" rather than "jump to page 734", which is usually what users need anyway.',
    ],
    keyApis: ['LIMIT … OFFSET', 'WHERE (created_at, id) < ($1, $2)', 'row-value comparison', 'ORDER BY … LIMIT', 'cursor-based pagination'],
    useCases: ['Infinite scroll', 'API pagination', 'Batch processing of a whole table', 'Exports'],
    snippet: {
      lang: 'sql', name: 'pagination.sql', code: `-- ✗ Reads and discards 190,000 rows
SELECT id, kind FROM events ORDER BY id LIMIT 20 OFFSET 190000;

-- ✓ Keyset: continue after the last row of the previous page
SELECT id, kind FROM events WHERE id > $1 ORDER BY id LIMIT 20;

-- ✓ With a non-unique sort key, add a tie-breaker (row-value comparison)
SELECT * FROM posts
WHERE (created_at, id) < ($1, $2)
ORDER BY created_at DESC, id DESC
LIMIT 20;`,
    },
    inputs: [{ name: 'page_size', label: 'Page size', type: 'number', default: 20, min: 10, max: 100 }],
    flow: queryFlow('/api/demos/pagination', 'ORDER BY id LIMIT 20 OFFSET 190000', 'walk 190,020 index entries'),
    actions: [runButton('/api/demos/pagination', 'Page deeper and deeper', (i) => ({ page_size: i.page_size }))],
    pitfalls: [
      {
        mistake: 'Deep OFFSET pagination on big tables',
        symptom: 'Later pages get slower and slower; bots crawling ?page=50000 drive the CPU up.',
        why: 'OFFSET n still produces the first n rows, then discards them.',
        fix: 'Switch to keyset pagination; cap the maximum page for OFFSET-based UIs.',
        avoid: 'Design APIs with an opaque cursor (the last row\'s key) from the start.',
        reproduce: 'run',
      },
      {
        mistake: 'OFFSET on data that changes',
        symptom: 'Users see the same item on two pages, or items are skipped, in a feed sorted newest-first.',
        why: 'Inserts and deletes between page loads shift every following row.',
        fix: 'Keyset pagination is stable under inserts.',
        avoid: 'Use a unique sort key (id or (created_at, id)).',
        reproduce: 'run',
      },
    ],
    visual: 'pagination',
  },
  {
    id: 'index-not-used',
    category: CAT,
    title: 'Why isn\'t my index used?',
    tagline: 'Casts, functions and arithmetic on the column hide it from the index',
    description: [
      'An index on a column helps only predicates that compare the column itself to a value: user_id = 42, created_at >= …. Wrap the column in a cast, a function or arithmetic (user_id::text = \'42\', created_at::date = …, lower(kind) = …, id + 1 = …) and the index no longer applies, because it stores user_id, not user_id::text.',
      'Four pairs run against 100,000 events with B-tree indexes on id, user_id, created_at and kind. Each card shows the plan of the wrong form (Seq Scan) and of the equivalent right form (Index Scan) with their real times.',
      'The fix is almost always to move the work to the constant side, rewrite as a range, or create an expression index that matches the expression exactly.',
    ],
    keyApis: ['sargable predicates', 'expression index', 'EXPLAIN', 'half-open range', 'implicit casts'],
    useCases: ['Slow-query reviews', 'ORM-generated SQL', 'Date filters', 'Case-insensitive lookups'],
    snippet: {
      lang: 'sql', name: 'sargable.sql', code: `-- ✗ Seq Scan                                   -- ✓ Index Scan
WHERE user_id::text = '42'                      WHERE user_id = 42
WHERE created_at::date = '2026-05-01'           WHERE created_at >= '2026-05-01' AND created_at < '2026-05-02'
WHERE lower(kind) = 'refund'                    WHERE kind = 'refund'   -- or CREATE INDEX ON ev (lower(kind))
WHERE id + 1 = 5001                             WHERE id = 5000`,
    },
    flow: queryFlow('/api/demos/index-not-used', "WHERE created_at::date = '2026-05-01'", 'cannot use the index: full scan'),
    actions: [runButton('/api/demos/index-not-used', 'Compare the plans')],
    pitfalls: [
      {
        mistake: 'Wrapping an indexed column in a function or cast',
        symptom: 'EXPLAIN shows Seq Scan on events with Filter: ((created_at)::date = \'2026-05-01\'::date) although created_at is indexed.',
        why: 'The index is ordered by the raw column value; the planner cannot invert your expression.',
        fix: 'Rewrite the predicate on the bare column, or CREATE INDEX ON events ((created_at::date)) (only if the expression is immutable: timestamptz::date depends on TimeZone and is not).',
        avoid: 'Keep the column alone on one side of the comparison.',
        reproduce: 'run',
      },
      {
        mistake: 'Comparing columns of different types',
        symptom: 'ERROR:  operator does not exist: integer = text\nHINT:  No operator matches the given name and argument types. You might need to add explicit type casts.\n(and when you add the cast to the column, the index stops being used)',
        why: 'Postgres has no implicit integer = text comparison. Casting the column side disables its index.',
        fix: 'Cast the value, not the column (user_id = $1::int), or fix the schema so join columns share a type.',
        avoid: 'Give foreign keys and the keys they reference exactly the same type.',
      },
    ],
    visual: 'index-not-used',
  },
];
