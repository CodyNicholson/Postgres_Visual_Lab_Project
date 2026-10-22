import { flow, runButton, wrongButton } from './flows.js';

const CAT = 'Transactions & concurrency';

const twoSessions = (path, a, b, end = 'timeline of both sessions') => flow(path,
  ['api', 'session', a],
  ['api', 'session2', b],
  ['session', 'storage', 'row versions + locks'],
  ['session2', 'storage', 'sees its snapshot / waits'],
  ['session', 'api', end],
);

export const CONCURRENCY_DEMOS = [
  {
    id: 'transactions',
    category: CAT,
    title: 'Transactions & savepoints',
    tagline: 'All or nothing: BEGIN, COMMIT, ROLLBACK, SAVEPOINT',
    description: [
      'A transaction groups statements so they succeed or fail together (atomicity), and nobody else sees the changes until COMMIT. Moving money is the classic example: the debit and the credit must both happen, or neither.',
      'The ladder diagram shows two real sessions. Session A moves money from alice to bob; session B looks in the middle and still sees the old balances. Then A attempts a transfer that violates CHECK (balance >= 0): the credit that already happened is undone too, and every further statement is refused until ROLLBACK. Finally, a SAVEPOINT lets A undo just the failing part and continue.',
      'Most drivers, psql included, run in autocommit mode: every statement is its own transaction unless you say BEGIN.',
    ],
    keyApis: ['BEGIN / START TRANSACTION', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'ROLLBACK TO SAVEPOINT', 'conn.transaction() (psycopg)'],
    useCases: ['Money transfers', 'Multi-table writes', 'Batch imports', 'Partial retries'],
    snippet: {
      lang: 'python', name: 'transfer.py', code: `with conn.transaction():          # BEGIN … COMMIT, or ROLLBACK on exception
    conn.execute("UPDATE accounts SET balance = balance - %s WHERE name = 'alice'", [amount])
    conn.execute("UPDATE accounts SET balance = balance + %s WHERE name = 'bob'", [amount])

with conn.transaction():
    conn.execute("INSERT INTO notes VALUES ('first')")
    try:
        with conn.transaction():      # nested = SAVEPOINT
            conn.execute("INSERT INTO notes VALUES (NULL)")
    except psycopg.errors.NotNullViolation:
        pass                          # ROLLBACK TO SAVEPOINT; the outer transaction lives on
    conn.execute("INSERT INTO notes VALUES ('second')")`,
    },
    inputs: [{ name: 'amount', label: 'Transfer amount', type: 'number', default: 30, min: 1, max: 100 }],
    flow: twoSessions('/api/demos/transactions', 'A: BEGIN; UPDATE alice; UPDATE bob', 'B: SELECT balances (sees old values)', 'COMMIT → both changes visible'),
    actions: [runButton('/api/demos/transactions', 'Run the transfers', (i) => ({ amount: i.amount }))],
    pitfalls: [
      {
        mistake: 'Continuing after an error inside a transaction',
        symptom: 'ERROR:  current transaction is aborted, commands ignored until end of transaction block',
        why: 'After any error the whole transaction is marked failed; Postgres refuses every statement until ROLLBACK.',
        fix: 'ROLLBACK (or ROLLBACK TO SAVEPOINT) and retry the work.',
        avoid: 'Wrap risky statements in a savepoint (a nested conn.transaction() in psycopg) if you want to recover and continue.',
        reproduce: 'run',
      },
      {
        mistake: 'Leaving transactions open (idle in transaction)',
        symptom: 'pg_stat_activity shows state = \'idle in transaction\' for minutes; other queries wait on locks; tables bloat.',
        why: 'An open transaction holds its locks and its snapshot, so VACUUM cannot remove dead rows newer than it.',
        fix: 'SELECT pg_terminate_backend(pid) for the offender; then fix the code path that forgets to COMMIT.',
        avoid: 'Keep transactions short, never wait for user input or HTTP calls inside one, and set idle_in_transaction_session_timeout.',
      },
      {
        mistake: 'Thinking each statement in a script is protected',
        symptom: 'A migration script failed halfway and left the schema half-changed.',
        why: 'In autocommit mode each statement commits on its own.',
        fix: 'Repair by hand, then rerun.',
        avoid: 'Run scripts with psql --single-transaction -v ON_ERROR_STOP=1 (DDL is transactional in Postgres).',
      },
    ],
    visual: 'transactions',
  },
  {
    id: 'isolation',
    category: CAT,
    title: 'Isolation levels',
    tagline: 'READ COMMITTED, REPEATABLE READ, SERIALIZABLE, and write skew',
    description: [
      'Isolation decides what a transaction can see of other transactions running at the same time. READ COMMITTED (the default) takes a fresh snapshot for every statement, so two reads in one transaction can disagree. REPEATABLE READ takes one snapshot for the whole transaction. SERIALIZABLE additionally guarantees the result is as if the transactions ran one after another.',
      'Four real scenarios, each with two sessions. Watch the ladder: a non-repeatable read under READ COMMITTED; a stable snapshot and an update conflict under REPEATABLE READ; write skew under REPEATABLE READ (two doctors both go off call, breaking the "at least one on call" rule); and SERIALIZABLE detecting the same pattern and aborting one transaction.',
      'Higher isolation means your code must handle serialization failures (SQLSTATE 40001) by retrying the whole transaction.',
    ],
    keyApis: ['BEGIN ISOLATION LEVEL …', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE (SSI)', 'SQLSTATE 40001', 'default_transaction_isolation'],
    useCases: ['Consistent reports', 'Invariants across rows', 'Booking and inventory rules', 'Financial logic'],
    snippet: {
      lang: 'python', name: 'retry.py', code: `def run_serializable(conn, work, attempts=5):
    for attempt in range(attempts):
        try:
            with conn.transaction():
                conn.execute("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
                return work(conn)
        except psycopg.errors.SerializationFailure:   # SQLSTATE 40001
            time.sleep(0.01 * 2 ** attempt)            # back off, then rerun everything
    raise RuntimeError("gave up after retries")`,
    },
    flow: twoSessions('/api/demos/isolation', 'A: BEGIN ISOLATION LEVEL …; SELECT', 'B: UPDATE + COMMIT in between', 'per-scenario timelines'),
    actions: [runButton('/api/demos/isolation', 'Run all four scenarios')],
    pitfalls: [
      {
        mistake: 'Checking a rule and writing in separate statements under READ COMMITTED / REPEATABLE READ',
        symptom: 'The rule "at least one doctor on call" is broken although every transaction checked it.',
        why: 'Each transaction read a snapshot where the rule held, then updated a different row: write skew. Neither saw the other\'s change.',
        fix: 'Use SERIALIZABLE (and retry on 40001), or lock the rows you read: SELECT … FOR UPDATE.',
        avoid: 'Any invariant that spans several rows needs SERIALIZABLE, explicit locks, or a constraint.',
        reproduce: 'run',
      },
      {
        mistake: 'Not retrying serialization failures',
        symptom: 'ERROR:  could not serialize access due to read/write dependencies among transactions\nDETAIL:  Reason code: Canceled on identification as a pivot, during commit attempt.\nHINT:  The transaction might succeed if retried.',
        why: 'SERIALIZABLE (and REPEATABLE READ on conflicting updates) aborts a transaction instead of producing an anomaly.',
        fix: 'Catch SQLSTATE 40001 and rerun the entire transaction, including its reads.',
        avoid: 'Write a retry wrapper once and use it for every serializable transaction.',
        reproduce: 'run',
      },
      {
        mistake: 'Updating a row changed by someone else under REPEATABLE READ',
        symptom: 'ERROR:  could not serialize access due to concurrent update',
        why: 'Your snapshot is older than the row\'s latest version; applying your change would lose theirs.',
        fix: 'Retry the transaction.',
        avoid: 'Keep REPEATABLE READ for read-only reports, or be ready to retry.',
        reproduce: 'run',
      },
    ],
    visual: 'isolation',
  },
  {
    id: 'row-locks',
    category: CAT,
    title: 'Row locks & lost updates',
    tagline: 'Read-modify-write races, SELECT … FOR UPDATE, atomic updates, NOWAIT',
    description: [
      'The lost update is the most common concurrency bug: two workers read a counter (10), both add 1 in application code, both write 11. One increment is gone. Nothing errors; the number is just wrong.',
      'Several workers increment one counter at the same time, three ways. The read-modify-write way loses updates (the red bar falls short of the expected total). SELECT … FOR UPDATE locks the row so the others wait their turn. An atomic UPDATE counter SET n = n + 1 needs no explicit lock: the database applies each increment to the latest value.',
      'Below: one session holds a row lock and another asks with NOWAIT (fails immediately) and SKIP LOCKED (skips the row).',
    ],
    keyApis: ['SELECT … FOR UPDATE', 'FOR NO KEY UPDATE / FOR SHARE', 'NOWAIT', 'SKIP LOCKED', 'UPDATE … SET n = n + 1', 'lock_timeout'],
    useCases: ['Counters and balances', 'Inventory decrements', 'Seat reservations', 'Any read-then-write'],
    snippet: {
      lang: 'sql', name: 'locks.sql', code: `-- ✗ Lost updates: read in the app, write back
SELECT n FROM counter WHERE id = 1;          -- both workers read 10
UPDATE counter SET n = 11 WHERE id = 1;      -- both write 11

-- ✓ Lock the row while you think
BEGIN;
SELECT n FROM counter WHERE id = 1 FOR UPDATE;   -- others wait here
UPDATE counter SET n = 11 WHERE id = 1;
COMMIT;

-- ✓✓ Or let the database do the arithmetic
UPDATE counter SET n = n + 1 WHERE id = 1;`,
    },
    inputs: [
      { name: 'workers', label: 'Concurrent workers', type: 'number', default: 4, min: 2, max: 6 },
      { name: 'increments', label: 'Increments each', type: 'number', default: 20, min: 5, max: 50 },
    ],
    flow: twoSessions('/api/demos/row-locks', 'worker 1: SELECT n … FOR UPDATE', 'worker 2: SELECT n … FOR UPDATE (waits)', 'final counter vs expected'),
    actions: [runButton('/api/demos/row-locks', 'Race the workers', (i) => ({ workers: i.workers, increments: i.increments }))],
    pitfalls: [
      {
        mistake: 'Read, compute in the app, write back',
        symptom: 'Counters and stock levels are slightly too low/high, with no errors anywhere.',
        why: 'Between your read and your write another transaction wrote; READ COMMITTED does not prevent that.',
        fix: 'Use an atomic UPDATE … SET n = n + 1, or SELECT … FOR UPDATE inside a transaction, or optimistic locking (UPDATE … WHERE version = $old and check the row count).',
        avoid: 'Never compute a new value from an old one outside the database without a lock or version check.',
        reproduce: 'run',
      },
      {
        mistake: 'Waiting forever for a lock',
        symptom: 'Requests hang until the HTTP timeout; pg_stat_activity shows wait_event_type = \'Lock\'.',
        why: 'Another transaction holds the row lock and is slow or idle in transaction.',
        fix: 'Find and end the blocker (pg_blocking_pids, see Monitoring).',
        avoid: "SET lock_timeout = '2s' for interactive requests, or use NOWAIT and handle:\nERROR:  could not obtain lock on row in relation \"counter\"",
        reproduce: 'run',
      },
      {
        mistake: 'FOR UPDATE when FOR NO KEY UPDATE is enough',
        symptom: 'Inserts into child tables block while the parent row is locked.',
        why: 'FOR UPDATE also blocks foreign-key checks (which take FOR KEY SHARE) from other transactions.',
        fix: 'Use FOR NO KEY UPDATE when you won\'t change the key.',
        avoid: 'Pick the weakest lock that protects your invariant.',
      },
    ],
    visual: 'row-locks',
  },
  {
    id: 'skip-locked',
    category: CAT,
    title: 'Job queue with SKIP LOCKED',
    tagline: 'Many workers, one table, no job processed twice',
    description: [
      'A table makes a perfectly good job queue if workers claim jobs safely. SELECT … FOR UPDATE SKIP LOCKED LIMIT 1 locks one queued job and skips any job another worker has already locked, so workers never wait for each other and never get the same job.',
      'Each lane in the Gantt chart is a real worker connection; each bar is a job, coloured by worker. With SKIP LOCKED the bars interleave and every job runs exactly once. "Do it wrong" drops the locking clause: workers read the same "next job" at the same moment and run it twice (red bars).',
      'For high-volume queues add an index on (state, id), keep transactions short, and delete or archive finished jobs so the table stays small.',
    ],
    keyApis: ['FOR UPDATE SKIP LOCKED', 'LIMIT 1', 'UPDATE … SET state = \'done\'', 'DELETE … RETURNING', 'LISTEN/NOTIFY (wake workers)'],
    useCases: ['Background jobs', 'Email sending', 'Outbox pattern', 'Work distribution'],
    snippet: {
      lang: 'python', name: 'worker.py', code: `while True:
    with conn.transaction():
        job = conn.execute("""
            SELECT id FROM jobs
            WHERE state = 'queued'
            ORDER BY id
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        """).fetchone()
        if job is None:
            break                      # queue empty (or every job is taken)
        do_the_work(job)
        conn.execute("UPDATE jobs SET state = 'done' WHERE id = %s", [job["id"]])`,
    },
    inputs: [
      { name: 'jobs', label: 'Jobs', type: 'number', default: 24, min: 6, max: 48 },
      { name: 'workers', label: 'Workers', type: 'number', default: 3, min: 2, max: 6 },
    ],
    flow: twoSessions('/api/demos/skip-locked', 'worker 1: lock job 1', 'worker 2: skip job 1, lock job 2', 'which worker ran which job'),
    actions: [
      runButton('/api/demos/skip-locked', 'Start the workers', (i) => ({ jobs: i.jobs, workers: i.workers })),
      wrongButton('/api/demos/skip-locked', 'Without row locks', (i) => ({ jobs: i.jobs, workers: i.workers })),
    ],
    pitfalls: [
      {
        mistake: 'Claiming jobs with a plain SELECT, then UPDATE',
        symptom: 'Customers receive the same email twice; jobs run more than once.',
        why: 'Two workers SELECT the same queued job before either marks it taken.',
        fix: 'Add FOR UPDATE SKIP LOCKED to the SELECT (inside the transaction that marks it done), or claim atomically with UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *.',
        avoid: 'Make job handlers idempotent anyway.',
        reproduce: 'mistake',
      },
      {
        mistake: 'FOR UPDATE without SKIP LOCKED',
        symptom: 'Adding workers does not increase throughput: they all queue behind the first job\'s lock.',
        why: 'Every worker tries to lock the same first row and waits.',
        fix: 'Add SKIP LOCKED.',
        avoid: 'SKIP LOCKED is meant for exactly this: queue-like tables.',
      },
      {
        mistake: 'Holding the job transaction open during long work',
        symptom: 'Bloat in the jobs table; locks held for minutes; a worker crash makes the job look "in progress" forever.',
        why: 'An open transaction holds the row lock and its snapshot.',
        fix: 'Claim with a short transaction (state = \'running\', locked_at = now()), do the work, then mark done; requeue stale running jobs.',
        avoid: 'Keep queue transactions short; use a visibility-timeout pattern for long jobs.',
      },
    ],
    visual: 'skip-locked',
  },
  {
    id: 'deadlocks',
    category: CAT,
    title: 'Deadlocks',
    tagline: 'Two sessions waiting for each other, and how Postgres breaks the cycle',
    description: [
      'A deadlock happens when session A holds a lock B needs, while B holds a lock A needs. Neither can continue. Postgres checks for this after waiting deadlock_timeout (1 s by default, 200 ms here), and aborts one of the transactions with "deadlock detected" so the other can finish.',
      'The first ladder is a real deadlock: A updates row 1 then row 2, while B updates row 2 then row 1. Watch the waits, then one session fail. The second ladder runs the same transfers with both sessions locking rows in the same order (id 1, then id 2): B just waits for A, then continues. No deadlock is possible.',
      'Deadlocks are a design problem, not a database bug: lock in a consistent order and keep transactions short.',
    ],
    keyApis: ['deadlock_timeout', 'SQLSTATE 40P01', 'log_lock_waits', 'pg_locks', 'ORDER BY id FOR UPDATE'],
    useCases: ['Transfers between accounts', 'Batch updates', 'Concurrent workers on shared rows'],
    snippet: {
      lang: 'sql', name: 'transfer.sql', code: `-- ✗ Lock order depends on the direction of the transfer
UPDATE accounts SET balance = balance - 10 WHERE id = :from;
UPDATE accounts SET balance = balance + 10 WHERE id = :to;

-- ✓ Always lock the lower id first
BEGIN;
SELECT id FROM accounts WHERE id IN (:from, :to) ORDER BY id FOR UPDATE;
UPDATE accounts SET balance = balance - 10 WHERE id = :from;
UPDATE accounts SET balance = balance + 10 WHERE id = :to;
COMMIT;`,
    },
    flow: twoSessions('/api/demos/deadlocks', 'A: lock row 1, then wants row 2', 'B: lock row 2, then wants row 1', 'deadlock detected → one aborted'),
    actions: [runButton('/api/demos/deadlocks', 'Cause a deadlock, then avoid it')],
    pitfalls: [
      {
        mistake: 'Locking the same rows in different orders',
        symptom: 'ERROR:  deadlock detected\nDETAIL:  Process 3612 waits for ShareLock on transaction 5179; blocked by process 3756.\nProcess 3756 waits for ShareLock on transaction 5178; blocked by process 3612.\nHINT:  See server log for query details.',
        why: 'Each session holds what the other needs; the wait-for graph has a cycle.',
        fix: 'Retry the aborted transaction (SQLSTATE 40P01).',
        avoid: 'Lock rows in a consistent order (ORDER BY id FOR UPDATE), update batches sorted by key, keep transactions short.',
        reproduce: 'run',
      },
      {
        mistake: 'Raising deadlock_timeout to "fix" deadlocks',
        symptom: 'Deadlocks still happen, now each one blocks both sessions for longer.',
        why: 'deadlock_timeout only controls how long Postgres waits before checking for a cycle.',
        fix: 'Fix the lock order.',
        avoid: 'Turn on log_lock_waits to see who waits for whom.',
      },
    ],
    visual: 'deadlocks',
  },
  {
    id: 'advisory-locks',
    category: CAT,
    title: 'Advisory locks',
    tagline: 'Application-defined locks: run a job on one node only',
    description: [
      'Advisory locks lock a number (a bigint you choose), not a row. Postgres does not know what it means; your application does. They are perfect for "only one instance may run the nightly report", leader election, or serializing work on an external resource.',
      'Several workers call pg_try_advisory_lock at the same moment: exactly one gets true and does the work, the others get false and move on (top chart). Then they use the blocking, transaction-scoped pg_advisory_xact_lock: they queue and run strictly one after another (bottom chart), and each lock is released automatically at COMMIT.',
      'Session-level advisory locks survive the transaction and are held until unlocked or the connection closes, which is dangerous with connection pools, as "Do it wrong" shows.',
    ],
    keyApis: ['pg_try_advisory_lock(key)', 'pg_advisory_lock(key)', 'pg_advisory_xact_lock(key)', 'pg_advisory_unlock(key)', 'hashtext(\'name\')', 'pg_locks (locktype = advisory)'],
    useCases: ['Singleton cron jobs', 'Leader election', 'Serializing per-customer work', 'Migrations on multi-node apps'],
    snippet: {
      lang: 'python', name: 'singleton.py', code: `KEY = 7_000_042   # or: SELECT hashtext('nightly-report')

with pool.connection() as conn:
    got = conn.execute("SELECT pg_try_advisory_lock(%s)", [KEY]).fetchone()[0]
    if got:
        try:
            run_nightly_report()
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", [KEY])

# Safer with pools: transaction-scoped, released at COMMIT/ROLLBACK
with conn.transaction():
    conn.execute("SELECT pg_advisory_xact_lock(%s)", [KEY])
    do_serialized_work()`,
    },
    inputs: [{ name: 'workers', label: 'Workers', type: 'number', default: 4, min: 2, max: 6 }],
    flow: twoSessions('/api/demos/advisory-locks', 'worker 1: pg_try_advisory_lock → true', 'worker 2: pg_try_advisory_lock → false', 'who ran, who skipped, who queued'),
    actions: [
      runButton('/api/demos/advisory-locks', 'Start the workers', (i) => ({ workers: i.workers })),
      wrongButton('/api/demos/advisory-locks', 'Forget to unlock', (i) => ({ workers: i.workers })),
    ],
    pitfalls: [
      {
        mistake: 'Session-level advisory locks with a connection pool',
        symptom: 'The job never runs again: pg_try_advisory_lock returns false forever; pg_locks shows the lock held by an idle pooled connection.',
        why: 'The lock belongs to the connection, which the pool keeps alive after your request ends.',
        fix: 'SELECT pg_advisory_unlock_all() on that connection, or pg_terminate_backend(pid).',
        avoid: 'Prefer pg_advisory_xact_lock; otherwise unlock in a finally block. Behind PgBouncer in transaction mode, session-level locks don\'t work at all.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Different services using the same key numbers for different things',
        symptom: 'Unrelated jobs block each other.',
        why: 'The key space is shared per database.',
        fix: 'Use the two-int form pg_advisory_lock(namespace, id) or hashtext of a namespaced string.',
        avoid: 'Document advisory-lock keys like any other shared resource.',
      },
    ],
    visual: 'advisory',
  },
  {
    id: 'mvcc',
    category: CAT,
    title: 'MVCC & VACUUM',
    tagline: 'Row versions, dead tuples, bloat, and what VACUUM really does',
    description: [
      'Postgres never overwrites a row. An UPDATE writes a new version of the row and marks the old one as dead (multiversion concurrency control, MVCC). Each version carries xmin (the transaction that created it) and xmax (the one that deleted it), so every transaction sees exactly the versions that were committed when its snapshot was taken. Readers never block writers.',
      'The demo updates row 1 twice and shows its ctid (its physical address) and xmin change. pageinspect lets you look inside page 0 at the old, dead versions. Then it updates every row: the table doubles in size, pgstattuple counts the dead versions, VACUUM makes their space reusable, and VACUUM FULL rewrites the table compactly.',
      '"Do it wrong" keeps an old REPEATABLE READ transaction open during the VACUUM: the dead rows can\'t be removed because that snapshot might still need them. That is how one forgotten transaction bloats a whole database.',
    ],
    keyApis: ['xmin / xmax / ctid', 'VACUUM', 'VACUUM (VERBOSE)', 'VACUUM FULL', 'autovacuum', 'pgstattuple', 'pageinspect', 'n_dead_tup'],
    useCases: ['Understanding bloat', 'Tuning autovacuum', 'Diagnosing slow-growing tables', 'Capacity planning'],
    snippet: {
      lang: 'sql', name: 'mvcc.sql', code: `SELECT ctid, xmin, xmax, * FROM items WHERE id = 1;    -- (0,1) xmin=1234
UPDATE items SET qty = qty + 1 WHERE id = 1;
SELECT ctid, xmin, xmax, * FROM items WHERE id = 1;    -- (0,…) new version, new xmin

SELECT tuple_count, dead_tuple_count FROM pgstattuple('items');
VACUUM (VERBOSE) items;   -- dead versions → free space (no lock against reads/writes)
VACUUM FULL items;        -- rewrite + shrink (ACCESS EXCLUSIVE lock!)`,
    },
    inputs: [{ name: 'rows', label: 'Rows', type: 'select', default: 10000, options: [1000, 10000, 25000, 50000] }],
    flow: flow('/api/demos/mvcc',
      ['api', 'session', 'UPDATE items SET qty = qty + 1'],
      ['session', 'storage', 'write new versions, mark old ones xmax'],
      ['session', 'wal', 'WAL for every new version'],
      ['session', 'storage', 'VACUUM: reclaim dead versions'],
      ['session', 'api', 'sizes + dead tuple counts'],
    ),
    actions: [
      runButton('/api/demos/mvcc', 'Update, inspect, VACUUM', (i) => ({ rows: i.rows })),
      wrongButton('/api/demos/mvcc', 'VACUUM with an old transaction open', (i) => ({ rows: i.rows })),
    ],
    pitfalls: [
      {
        mistake: 'Long-running or idle-in-transaction sessions',
        symptom: 'VACUUM (VERBOSE) reports:\ntuples: 0 removed, 20000 remain, 10000 are dead but not yet removable\n(and tables keep growing; n_dead_tup stays high)',
        why: 'VACUUM may only remove versions older than the oldest snapshot still in use (the xmin horizon). Also caused by abandoned replication slots, old prepared transactions and hot_standby_feedback on replicas (found while building this lab).',
        fix: 'Find the oldest: SELECT pid, state, xact_start FROM pg_stat_activity ORDER BY xact_start; end it, drop unused slots, then VACUUM.',
        avoid: 'idle_in_transaction_session_timeout, short transactions, monitoring of the oldest xact_start and replication slots.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Running VACUUM FULL on a live table',
        symptom: 'The application stops: every query on the table waits until VACUUM FULL finishes.',
        why: 'VACUUM FULL rewrites the table under an ACCESS EXCLUSIVE lock and needs space for a full copy.',
        fix: 'Cancel it (pg_cancel_backend). Use pg_repack or pg_squeeze to shrink online.',
        avoid: 'Plain (auto)VACUUM is enough when it keeps up; reserve VACUUM FULL for maintenance windows.',
      },
      {
        mistake: 'Mass UPDATE of a whole big table in one statement',
        symptom: 'The table (and its indexes) doubles in size; replicas lag; the transaction runs for an hour.',
        why: 'Every updated row gets a new version and new index entries; nothing can be reclaimed until the transaction ends.',
        fix: 'Let VACUUM catch up (or pg_repack).',
        avoid: 'Update in batches of a few thousand rows with commits in between (a PROCEDURE with COMMIT works well).',
      },
    ],
    visual: 'mvcc',
  },
];
