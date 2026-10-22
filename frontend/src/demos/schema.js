import { flow, runButton, wrongButton } from './flows.js';

const CAT = 'Schema & server logic';

export const SCHEMA_DEMOS = [
  {
    id: 'constraints',
    category: CAT,
    title: 'Constraints',
    tagline: 'PRIMARY KEY, UNIQUE, NOT NULL, CHECK, FOREIGN KEY, DEFERRABLE, NOT VALID',
    description: [
      'Constraints are rules the database enforces on every write, whoever does the writing: your app, a script, a colleague in psql. They are the cheapest bug prevention there is. PRIMARY KEY identifies a row (UNIQUE + NOT NULL); UNIQUE forbids duplicates; NOT NULL forbids missing values; CHECK is any boolean rule; FOREIGN KEY makes sure a referenced row exists, and ON DELETE CASCADE / RESTRICT / SET NULL decides what happens when it is deleted.',
      'The demo creates authors and books, then attempts one violation of each kind. Each card shows the statement and the exact error Postgres raised: the error names the constraint, which is why naming constraints well pays off.',
      'Also shown: UNIQUE allows many NULLs (unless NULLS NOT DISTINCT), a DEFERRABLE constraint checked at COMMIT lets you swap two unique values, and NOT VALID + VALIDATE adds a constraint to a big table without a long lock.',
    ],
    keyApis: ['PRIMARY KEY', 'UNIQUE [NULLS NOT DISTINCT]', 'NOT NULL', 'CHECK (…)', 'REFERENCES … ON DELETE CASCADE', 'DEFERRABLE INITIALLY DEFERRED', 'NOT VALID / VALIDATE CONSTRAINT'],
    useCases: ['Data integrity', 'Business rules', 'Referential integrity', 'Safe schema changes'],
    snippet: {
      lang: 'sql', name: 'constraints.sql', code: `CREATE TABLE authors (
  id    integer PRIMARY KEY,
  email text NOT NULL UNIQUE
);
CREATE TABLE books (
  id        integer PRIMARY KEY,
  author_id integer NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  title     text NOT NULL,
  pages     integer CHECK (pages > 0),
  isbn      text UNIQUE
);

-- Add a rule to a big table without blocking it for long
ALTER TABLE books ADD CONSTRAINT short_title CHECK (length(title) < 40) NOT VALID;
ALTER TABLE books VALIDATE CONSTRAINT short_title;`,
    },
    flow: flow('/api/demos/constraints',
      ['api', 'session', 'INSERT INTO books … (pages = 0)'],
      ['session', 'storage', 'check constraints, probe unique/FK indexes'],
      ['storage', 'session', 'violation → abort statement'],
      ['session', 'api', 'ERROR 23514 + constraint name'],
    ),
    actions: [runButton('/api/demos/constraints', 'Try every violation')],
    pitfalls: [
      {
        mistake: 'Foreign keys without an index on the referencing column',
        symptom: 'Deleting one parent row takes seconds and locks; joins on the FK column are slow.',
        why: 'Postgres indexes the referenced primary key automatically, but not the referencing column (books.author_id). Each parent delete/update scans the child table.',
        fix: 'CREATE INDEX CONCURRENTLY ON books (author_id);',
        avoid: 'Index every foreign-key column unless the child table is tiny.',
        lang: 'sql', rightCode: 'CREATE INDEX CONCURRENTLY books_author_id_idx ON books (author_id);',
      },
      {
        mistake: 'Relying on application validation only',
        symptom: 'ERROR:  insert or update on table "books" violates foreign key constraint "books_author_id_fkey"\nDETAIL:  Key (author_id)=(99) is not present in table "authors".\n(or worse: no error, because there was no constraint, and orphan rows pile up)',
        why: 'Every other writer (scripts, migrations, a second service) bypasses the app\'s checks.',
        fix: 'Clean the bad rows, then add the constraint (NOT VALID first on big tables, then VALIDATE).',
        avoid: 'Put invariants in the schema; use app validation for friendly messages only.',
        reproduce: 'run',
      },
      {
        mistake: 'Swapping two UNIQUE values in one UPDATE',
        symptom: 'ERROR:  duplicate key value violates unique constraint "seats_strict_pos_key"\nDETAIL:  Key (pos)=(2) already exists.',
        why: 'A non-deferrable unique constraint is checked row by row, so the intermediate state clashes.',
        fix: 'Declare the constraint DEFERRABLE (INITIALLY DEFERRED, or SET CONSTRAINTS ALL DEFERRED in the transaction).',
        avoid: 'Make position/order columns DEFERRABLE from the start.',
        reproduce: 'run',
      },
      {
        mistake: 'Adding a constraint to a large table in one step',
        symptom: 'The app freezes during the migration: ALTER TABLE … ADD CONSTRAINT holds a lock while it scans every row.',
        why: 'A plain ADD CONSTRAINT CHECK/FOREIGN KEY validates all existing rows under a strong lock.',
        fix: 'ADD CONSTRAINT … NOT VALID (instant), then VALIDATE CONSTRAINT (weaker lock, doesn\'t block writes).',
        avoid: 'Use the two-step pattern for every constraint on a busy table.',
      },
    ],
    visual: 'constraints',
  },
  {
    id: 'views',
    category: CAT,
    title: 'Views & materialized views',
    tagline: 'Saved queries, cached results, and REFRESH … CONCURRENTLY',
    description: [
      'A view is a named query. It stores no data: selecting from it runs the query every time, so it is always up to date. Simple views are even updatable, and WITH CHECK OPTION stops you inserting rows the view could not show.',
      'A materialized view runs the query once and stores the result like a table: instant to read, but stale until you REFRESH it. The three counters show the base table, the view and the materialized view before and after a new 5,000 sale arrives: watch the materialized view lag behind until the refresh.',
      'REFRESH MATERIALIZED VIEW locks out readers while it runs; CONCURRENTLY avoids that, but needs a unique index on the materialized view, as "Do it wrong" proves.',
    ],
    keyApis: ['CREATE VIEW', 'WITH CHECK OPTION', 'CREATE MATERIALIZED VIEW', 'REFRESH MATERIALIZED VIEW [CONCURRENTLY]', 'CREATE UNIQUE INDEX ON matview'],
    useCases: ['Hiding complexity', 'Stable API over changing tables', 'Dashboards and expensive reports', 'Column-level access'],
    snippet: {
      lang: 'sql', name: 'views.sql', code: `CREATE VIEW revenue_by_status AS
SELECT status, count(*) AS lines, sum(amount) AS revenue FROM sales GROUP BY status;

CREATE MATERIALIZED VIEW revenue_snapshot AS
SELECT status, count(*) AS lines, sum(amount) AS revenue FROM sales GROUP BY status;

CREATE UNIQUE INDEX ON revenue_snapshot (status);
REFRESH MATERIALIZED VIEW CONCURRENTLY revenue_snapshot;   -- readers are not blocked`,
    },
    flow: flow('/api/demos/views',
      ['api', 'session', 'SELECT * FROM revenue_by_status'],
      ['session', 'planner', 'expand the view into its query'],
      ['planner', 'storage', 'scan sales (always current)'],
      ['session', 'storage', 'REFRESH MATERIALIZED VIEW: rewrite stored result'],
      ['session', 'api', 'totals'],
    ),
    actions: [runButton('/api/demos/views'), wrongButton('/api/demos/views', 'REFRESH CONCURRENTLY without an index')],
    pitfalls: [
      {
        mistake: 'REFRESH … CONCURRENTLY without a unique index',
        symptom: 'ERROR:  cannot refresh materialized view "…revenue_snapshot" concurrently\nHINT:  Create a unique index with no WHERE clause on one or more columns of the materialized view.',
        why: 'CONCURRENTLY computes the new result and diffs it against the old one row by row, which needs a unique key.',
        fix: 'CREATE UNIQUE INDEX ON revenue_snapshot (status); then refresh.',
        avoid: 'Create the unique index right after CREATE MATERIALIZED VIEW.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Expecting a materialized view to update itself',
        symptom: 'The dashboard shows yesterday\'s numbers.',
        why: 'Materialized views never refresh automatically.',
        fix: 'Schedule REFRESH (pg_cron, a cron job, or after the batch that loads data).',
        avoid: 'Show "data as of" timestamps on anything backed by a materialized view.',
        reproduce: 'run',
      },
      {
        mistake: 'Stacking views on views on views',
        symptom: 'A simple-looking SELECT has a 200-line plan and is slow; changing one view breaks five others.',
        why: 'Every layer is expanded into the final query; the planner can push down some but not all filters.',
        fix: 'Flatten hot paths into one query or a materialized view.',
        avoid: 'Keep views one or two levels deep.',
      },
    ],
    visual: 'views',
  },
  {
    id: 'functions',
    category: CAT,
    title: 'Functions & procedures',
    tagline: 'SQL and PL/pgSQL functions, set-returning functions, procedures, DO blocks',
    description: [
      'Functions run code inside the database, next to the data. A SQL function wraps a query or expression (the planner can even inline it). PL/pgSQL adds variables, IF, loops and RAISE for notices and errors. A function that RETURNS TABLE is used in FROM like a parameterized view.',
      'Procedures (CREATE PROCEDURE … CALL) differ in one important way: they may COMMIT inside, so a long batch job can commit as it goes instead of holding one huge transaction. A DO block runs one-off procedural code without creating anything.',
      'The console shows the NOTICE messages PL/pgSQL sent back to the client while computing fib(n). Volatility matters: mark functions IMMUTABLE / STABLE honestly, because Postgres uses that to decide where a function may be used (for example, in an index).',
    ],
    keyApis: ['CREATE FUNCTION … LANGUAGE sql', 'LANGUAGE plpgsql', 'RETURNS TABLE', 'IMMUTABLE / STABLE / VOLATILE', 'RAISE NOTICE / EXCEPTION', 'CREATE PROCEDURE / CALL', 'DO $$ … $$'],
    useCases: ['Reusable calculations', 'Batch jobs', 'Encapsulated business logic', 'Data fixes'],
    snippet: {
      lang: 'sql', name: 'functions.sql', code: `CREATE FUNCTION price_with_tax(price numeric, rate numeric DEFAULT 0.2)
RETURNS numeric LANGUAGE sql IMMUTABLE
RETURN round(price * (1 + rate), 2);

CREATE FUNCTION fib(n integer) RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE a numeric := 0; b numeric := 1; t numeric;
BEGIN
  IF n < 0 THEN RAISE EXCEPTION 'n must be >= 0, got %', n; END IF;
  FOR i IN 1..n LOOP t := a + b; a := b; b := t; END LOOP;
  RAISE NOTICE 'fib(%) computed in % steps', n, n;
  RETURN a;
END $$;

CREATE PROCEDURE fill_ledger(batches integer) LANGUAGE plpgsql AS $$
BEGIN
  FOR i IN 1..batches LOOP
    INSERT INTO ledger (note) VALUES ('batch ' || i);
    COMMIT;
  END LOOP;
END $$;
CALL fill_ledger(3);`,
    },
    inputs: [{ name: 'n', label: 'fib(n)', type: 'number', default: 10, min: 1, max: 30 }],
    flow: flow('/api/demos/functions',
      ['api', 'session', 'SELECT fib($1)'],
      ['session', 'planner', 'PL/pgSQL interpreter runs the loop'],
      ['session', 'api', 'NOTICE messages'],
      ['session', 'api', 'result'],
    ),
    actions: [
      runButton('/api/demos/functions', 'Run the functions', (i) => ({ n: i.n })),
      wrongButton('/api/demos/functions', 'Index a VOLATILE function', (i) => ({ n: i.n })),
    ],
    pitfalls: [
      {
        mistake: 'Using a function in an index without marking it IMMUTABLE',
        symptom: 'ERROR:  functions in index expression must be marked IMMUTABLE',
        why: 'Functions are VOLATILE by default. An index stores the function\'s output forever, so it must always give the same output for the same input.',
        fix: 'ALTER FUNCTION f(text) IMMUTABLE; but only if it truly is (no now(), no lookups in tables, no locale-dependent behaviour).',
        avoid: 'Declare volatility on every function you write.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Lying about volatility',
        symptom: 'Wrong query results or a corrupted index after data or settings change.',
        why: 'An "IMMUTABLE" function that reads a table or depends on TimeZone gets cached or indexed with stale values.',
        fix: 'Correct the volatility and REINDEX any index that used the function.',
        avoid: 'IMMUTABLE = pure math on the arguments. STABLE = may read tables, same within one statement. Everything else VOLATILE.',
      },
      {
        mistake: 'COMMIT inside a function',
        symptom: 'ERROR:  invalid transaction termination',
        why: 'Functions always run inside the caller\'s transaction. Only procedures, called with CALL outside an explicit transaction, may COMMIT.',
        fix: 'Turn it into a PROCEDURE and CALL it in autocommit mode.',
        avoid: 'Use procedures for batch jobs that should commit as they go.',
      },
    ],
    visual: 'functions',
  },
  {
    id: 'triggers',
    category: CAT,
    title: 'Triggers',
    tagline: 'BEFORE / AFTER, row / statement, audit logs and transition tables',
    description: [
      'A trigger runs a function automatically when rows are inserted, updated or deleted. BEFORE row triggers can modify the row about to be written (NEW) or skip it; AFTER triggers see the final result and are the place for audit logs and notifications. Statement-level triggers fire once per statement and can see every changed row at once through transition tables.',
      'The demo creates an accounts table with four triggers: one maintains updated_at, one writes an audit log with the old and new row as JSON, one blocks overdrafts by raising an error, and a statement trigger counts the changed rows. The feed shows the audit log filling up as the statements run.',
      'Triggers are invisible from the application side, which makes them powerful and surprising. Keep them small, fast and documented.',
    ],
    keyApis: ['CREATE TRIGGER … BEFORE/AFTER … FOR EACH ROW', 'FOR EACH STATEMENT', 'REFERENCING NEW TABLE AS', 'TG_OP', 'NEW / OLD', 'to_jsonb(row)', 'RETURNS trigger'],
    useCases: ['Audit logs', 'updated_at columns', 'Denormalized counters', 'Change notifications'],
    snippet: {
      lang: 'sql', name: 'triggers.sql', code: `CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := clock_timestamp(); RETURN NEW; END $$;
CREATE TRIGGER accounts_touch BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION touch();

CREATE FUNCTION audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log (op, row_id, old_row, new_row)
  VALUES (TG_OP, coalesce(NEW.id, OLD.id),
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
  RETURN NULL;
END $$;
CREATE TRIGGER accounts_audit AFTER INSERT OR UPDATE OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION audit();`,
    },
    flow: flow('/api/demos/triggers',
      ['api', 'session', 'UPDATE accounts SET balance = …'],
      ['session', 'planner', 'BEFORE trigger: touch(), no_overdraft()'],
      ['session', 'storage', 'write row'],
      ['planner', 'storage', 'AFTER trigger: INSERT INTO audit_log'],
      ['session', 'api', 'UPDATE 2'],
    ),
    actions: [runButton('/api/demos/triggers'), wrongButton('/api/demos/triggers', 'Change NEW in an AFTER trigger')],
    pitfalls: [
      {
        mistake: 'Modifying NEW in an AFTER trigger',
        symptom: 'No error, but the change never reaches the table (updated_at stays NULL).',
        why: 'AFTER triggers run once the row is already written; their return value and changes to NEW are ignored.',
        fix: 'Make it a BEFORE trigger.',
        avoid: 'BEFORE to change or reject the row; AFTER to react to it.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Returning NULL from a BEFORE row trigger by accident',
        symptom: 'INSERT 0 0 / UPDATE 0: rows silently disappear, no error.',
        why: 'A BEFORE row trigger that returns NULL tells Postgres to skip that row.',
        fix: 'RETURN NEW (or OLD for DELETE) at the end of every BEFORE row trigger.',
        avoid: 'Test triggers with the row counts the statements report.',
      },
      {
        mistake: 'Heavy work or external calls in triggers',
        symptom: 'Writes are mysteriously slow; deadlocks between triggers that update the same summary row.',
        why: 'Triggers run synchronously inside the writing transaction and hold its locks.',
        fix: 'Keep triggers to quick local writes; push slow work to a queue (an outbox table, LISTEN/NOTIFY).',
        avoid: 'Prefer statement-level triggers with transition tables for bulk changes.',
      },
    ],
    visual: 'triggers',
  },
  {
    id: 'partitioning',
    category: CAT,
    title: 'Partitioning',
    tagline: 'Split a big table by date: routing, pruning, instant retention',
    description: [
      'Declarative partitioning splits one logical table into child tables (partitions) by a key, usually time. You insert into and query the parent; Postgres routes each row to the right partition and, when the WHERE clause allows, skips (prunes) the partitions that cannot match.',
      'The demo creates one partition per month plus a DEFAULT partition, inserts 50,000 events and shows how many rows landed where. The EXPLAIN tab proves that a query for March only scans March. Dropping January is a DETACH + DROP: instant, with no DELETE, no bloat and no VACUUM.',
      'Partitioning is for very large tables (tens of millions of rows and up) with a natural key that most queries filter on. On small tables it only adds planning overhead.',
    ],
    keyApis: ['PARTITION BY RANGE / LIST / HASH', 'CREATE TABLE … PARTITION OF … FOR VALUES', 'DEFAULT partition', 'DETACH PARTITION [CONCURRENTLY]', 'partition pruning', 'tableoid::regclass'],
    useCases: ['Time-series and logs', 'Data retention', 'Multi-tenant splits', 'Archiving old data'],
    snippet: {
      lang: 'sql', name: 'partitions.sql', code: `CREATE TABLE measurements (
  id bigint GENERATED ALWAYS AS IDENTITY,
  created_at timestamptz NOT NULL,
  kind text NOT NULL,
  PRIMARY KEY (id, created_at)          -- must include the partition key
) PARTITION BY RANGE (created_at);

CREATE TABLE measurements_2026_03 PARTITION OF measurements
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE measurements_default PARTITION OF measurements DEFAULT;

-- Retention: instant
ALTER TABLE measurements DETACH PARTITION measurements_2026_01;
DROP TABLE measurements_2026_01;`,
    },
    flow: flow('/api/demos/partitioning',
      ['api', 'session', 'SELECT … WHERE created_at in March'],
      ['session', 'planner', 'prune: only measurements_2026_03 can match'],
      ['planner', 'storage', 'scan one partition of 10'],
      ['session', 'api', 'count + plan'],
    ),
    actions: [runButton('/api/demos/partitioning'), wrongButton('/api/demos/partitioning', 'Partitioning errors')],
    pitfalls: [
      {
        mistake: 'A primary key or unique constraint without the partition key',
        symptom: 'ERROR:  unique constraint on partitioned table must include all partitioning columns\nDETAIL:  PRIMARY KEY constraint on table "logs" lacks column "at" which is part of the partition key.',
        why: 'Each partition enforces uniqueness only within itself, so global uniqueness is only guaranteed when the partition key is part of the key.',
        fix: 'PRIMARY KEY (id, created_at).',
        avoid: 'Design keys with partitioning in mind before you partition.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Inserting a row with no partition to go to',
        symptom: 'ERROR:  no partition of relation "logs" found for row\nDETAIL:  Partition key of the failing row contains (at) = (2026-05-05 00:00:00+00).',
        why: 'Nobody created next month\'s partition, and there is no DEFAULT partition.',
        fix: 'Create the missing partition (and move rows out of DEFAULT if needed).',
        avoid: 'Create partitions ahead of time with pg_partman or a scheduled job; alert when the newest partition is close to full.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Queries that do not filter on the partition key',
        symptom: 'EXPLAIN shows an Append over every partition; the query is slower than on an unpartitioned table.',
        why: 'Without a predicate on the key, nothing can be pruned, and every partition\'s indexes are searched.',
        fix: 'Add the key to the WHERE clause (e.g. a date range) or choose a different partition key.',
        avoid: 'Partition by what nearly every query already filters on.',
      },
    ],
    visual: 'partitioning',
  },
];
