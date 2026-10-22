import { flow, queryFlow, runButton, wrongButton } from './flows.js';

const CAT = 'Features & extensions';

export const FEATURE_DEMOS = [
  {
    id: 'listen-notify',
    category: CAT,
    title: 'LISTEN / NOTIFY',
    tagline: 'Built-in pub/sub between database sessions',
    description: [
      'LISTEN channel subscribes a session; NOTIFY channel, \'payload\' (or pg_notify()) publishes to every listener. Notifications are transactional: they are delivered only when the sending transaction commits, and dropped if it rolls back, so a listener never hears about a change that didn\'t happen.',
      'The message log is real: a listener connection and a sender connection. Watch nothing arrive while the sender\'s transaction is open, then the message land a few milliseconds after COMMIT. Two identical notifications in one transaction are delivered once. Finally a trigger publishes a JSON message for every insert and update.',
      'NOTIFY is great for cache invalidation and waking up workers. It is not a durable queue: a listener that is disconnected misses messages, so pair it with a table (the outbox or job queue) for anything that must not be lost.',
    ],
    keyApis: ['LISTEN channel', 'NOTIFY channel, \'payload\'', 'pg_notify(channel, payload)', 'UNLISTEN', 'conn.notifies() (psycopg)'],
    useCases: ['Cache invalidation', 'Waking job workers', 'Live dashboards', 'Change feeds to websockets'],
    snippet: {
      lang: 'python', name: 'listen.py', code: `listener = psycopg.connect(DSN, autocommit=True)
listener.execute("LISTEN orders")
for note in listener.notifies(timeout=30):
    print(note.channel, note.payload)        # {"op": "INSERT", "id": 1, …}

-- In the database: publish every change
CREATE FUNCTION notify_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('orders', json_build_object('op', TG_OP, 'id', NEW.id)::text);
  RETURN NEW;
END $$;`,
    },
    flow: flow('/api/demos/listen-notify',
      ['api', 'session2', 'listener: LISTEN lab_…'],
      ['api', 'session', 'sender: BEGIN; NOTIFY …'],
      ['session', 'session', 'queued until COMMIT'],
      ['session', 'session2', 'COMMIT → deliver notification'],
      ['session2', 'api', 'payloads + latency'],
    ),
    actions: [runButton('/api/demos/listen-notify', 'Publish & listen'), wrongButton('/api/demos/listen-notify', 'Oversized payload')],
    pitfalls: [
      {
        mistake: 'Sending big payloads',
        symptom: 'ERROR:  payload string too long',
        why: 'Payloads must be shorter than 8000 bytes (and the whole queue is limited to 8 GB).',
        fix: 'Send an id or a small JSON, and let the listener SELECT the details.',
        avoid: 'Treat NOTIFY as a doorbell, not as the parcel.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Using NOTIFY as a durable message queue',
        symptom: 'After a deploy or network blip, some events were never processed.',
        why: 'Notifications are only delivered to sessions listening at that moment; nothing is stored.',
        fix: 'Store events in a table and use NOTIFY only to wake consumers, which then read the table.',
        avoid: 'Outbox table + SKIP LOCKED workers + NOTIFY for low latency.',
      },
      {
        mistake: 'Listening through a transaction-pooling proxy',
        symptom: 'LISTEN succeeds but notifications never arrive.',
        why: 'With PgBouncer in transaction mode your LISTEN runs on whichever server connection you happened to get, and you may never see that connection again.',
        fix: 'Give listeners a direct (or session-pooled) connection.',
        avoid: 'Keep one dedicated long-lived connection per listening process.',
      },
    ],
    visual: 'notify',
  },
  {
    id: 'copy',
    category: CAT,
    title: 'COPY & bulk loading',
    tagline: 'From 50 rows per second to 100,000+: how you insert matters',
    description: [
      'How you send many rows to Postgres changes the speed by orders of magnitude. One INSERT per row in autocommit mode pays a network round trip and a disk flush (fsync) for every row. Wrapping them in one transaction removes the flushes; batching (executemany with pipelining, or one INSERT with arrays) removes most round trips; COPY streams rows in the bulk-load protocol with minimal per-row overhead.',
      'The bars are measured right now on this server, loading the same rows five ways. Autocommit inserts are capped at 60 rows and one-transaction inserts at 3,000 to keep the demo short; rows per second is what matters.',
      'COPY also exports: COPY (query) TO STDOUT WITH (FORMAT csv, HEADER) streams any query result as CSV.',
    ],
    keyApis: ['COPY … FROM STDIN', 'COPY … TO STDOUT', 'cursor.copy() (psycopg)', 'executemany', 'INSERT … SELECT unnest($1::int[], …)', '\\copy (psql)', 'synchronous_commit'],
    useCases: ['ETL and imports', 'Seeding test data', 'CSV exports', 'Migrating between databases'],
    snippet: {
      lang: 'python', name: 'bulk.py', code: `# Fastest: COPY
with conn.cursor() as cur, cur.copy("COPY readings (id, sensor, value, at) FROM STDIN") as cp:
    for row in rows:
        cp.write_row(row)

# Good: one statement, arrays as parameters
conn.execute("""INSERT INTO readings
                SELECT * FROM unnest(%s::int[], %s::text[], %s::numeric[], %s::timestamptz[])""",
             list(zip(*rows)))

# Export
with cur.copy("COPY (SELECT * FROM readings) TO STDOUT WITH (FORMAT csv, HEADER)") as cp:
    for chunk in cp: out.write(bytes(chunk).decode())`,
    },
    inputs: [{ name: 'rows', label: 'Rows to load', type: 'select', default: 20000, options: [5000, 20000, 50000, 100000] }],
    flow: flow('/api/demos/copy',
      ['api', 'session', 'COPY readings FROM STDIN'],
      ['api', 'session', 'stream rows (one message per batch)'],
      ['session', 'storage', 'append to heap pages'],
      ['session', 'wal', 'WAL'],
      ['session', 'api', 'rows/s for each method'],
    ),
    actions: [
      runButton('/api/demos/copy', 'Race the load methods', (i) => ({ rows: i.rows })),
      wrongButton('/api/demos/copy', 'COPY FROM a local path', (i) => ({ rows: i.rows })),
    ],
    pitfalls: [
      {
        mistake: 'COPY … FROM \'/path/on/my/laptop.csv\'',
        symptom: 'ERROR:  could not open file "/tmp/readings.csv" for reading: No such file or directory\nHINT:  COPY FROM instructs the PostgreSQL server process to read a file. You may want a client-side facility such as psql\'s \\copy.',
        why: 'COPY with a file name reads on the database server, as the server\'s OS user (and needs pg_read_server_files).',
        fix: 'Use \\copy in psql, or COPY … FROM STDIN from your driver.',
        avoid: 'Always stream from the client with FROM STDIN.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Inserting row by row in autocommit mode',
        symptom: 'An import of 1 million rows takes hours; the disk shows constant small writes.',
        why: 'Every row is a transaction: a round trip plus a WAL flush to disk.',
        fix: 'Batch inside one transaction, or use COPY.',
        avoid: 'Use COPY for anything bigger than a few thousand rows.',
        reproduce: 'run',
      },
      {
        mistake: 'Loading into a table with every index and foreign key in place',
        symptom: 'COPY is fast at first, then slows to a crawl.',
        why: 'Each row updates every index and checks every foreign key.',
        fix: 'For big one-off loads: load into a fresh table, then CREATE INDEX and ADD CONSTRAINT afterwards, then ANALYZE.',
        avoid: 'Plan the load order: data first, indexes after, statistics last.',
      },
    ],
    visual: 'copy',
  },
  {
    id: 'trigram',
    category: CAT,
    title: 'Fuzzy search with pg_trgm',
    tagline: 'Typo-tolerant similarity and fast LIKE \'%anywhere%\'',
    description: [
      'pg_trgm breaks text into trigrams (three-letter pieces) and measures how many two strings share. That gives typo-tolerant similarity (similarity(), word_similarity(), the % operator) and, with a GIN or GiST trigram index, makes LIKE and ILIKE with a leading wildcard indexable, which a normal B-tree cannot do.',
      'Type a misspelled product name (the default is "mecanical keybord") and run it: the ranked list shows the similarity scores; plain ILIKE finds nothing. The second part searches 50,000 codes for a substring, first without an index, then with a trigram GIN index.',
      'Trigrams work on characters, not words or meaning: for language-aware search use full-text search; for meaning, vectors.',
    ],
    keyApis: ['CREATE EXTENSION pg_trgm', 'similarity(a, b)', 'word_similarity(a, b)', 'a % b', 'show_trgm()', 'gin_trgm_ops / gist_trgm_ops', 'pg_trgm.similarity_threshold'],
    useCases: ['Search-as-you-type', 'Typo-tolerant name search', 'De-duplicating similar records', 'Substring search on big tables'],
    snippet: {
      lang: 'sql', name: 'fuzzy.sql', code: `CREATE EXTENSION IF NOT EXISTS pg_trgm;

SELECT name, word_similarity($1, name) AS score
FROM products
WHERE $1 <% name                       -- word_similarity above the threshold
ORDER BY score DESC LIMIT 5;

CREATE INDEX codes_trgm ON codes USING gin (code gin_trgm_ops);
SELECT count(*) FROM codes WHERE code LIKE '%c4ca42%';   -- now an index scan`,
    },
    inputs: [{ name: 'q', label: 'Search (try typos)', type: 'text', default: 'mecanical keybord' }],
    flow: queryFlow('/api/demos/trigram', 'ORDER BY word_similarity($1, name) DESC', 'trigram GIN index'),
    actions: [
      runButton('/api/demos/trigram', 'Fuzzy search', (i) => ({ q: i.q })),
      wrongButton('/api/demos/trigram', 'B-tree for LIKE \'%…%\'', (i) => ({ q: i.q })),
    ],
    pitfalls: [
      {
        mistake: 'Expecting a B-tree index to speed up LIKE \'%term%\'',
        symptom: 'EXPLAIN shows Seq Scan for WHERE code LIKE \'%c4ca42%\' despite an index on code.',
        why: 'A B-tree is sorted from the first character; a leading wildcard gives it nothing to seek to. (Prefix LIKE \'abc%\' works only with the C collation or text_pattern_ops.)',
        fix: 'CREATE INDEX … USING gin (code gin_trgm_ops);',
        avoid: 'Trigram index for substring search; text_pattern_ops for prefix search.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Searching for very short strings',
        symptom: 'LIKE \'%ab%\' with a trigram index is still slow.',
        why: 'Strings shorter than 3 characters produce no useful trigrams, so the index can\'t narrow the search.',
        fix: 'Require at least 3 characters in the UI.',
        avoid: 'Set a minimum query length for search-as-you-type.',
      },
    ],
    visual: 'trigram',
  },
  {
    id: 'vector',
    category: CAT,
    title: 'Vector search (pgvector)',
    tagline: 'Nearest-neighbour search on embeddings with an HNSW index',
    description: [
      'An embedding is a list of numbers that places an item in a "meaning space": similar items get nearby vectors. The pgvector extension adds a vector type, distance operators (<-> Euclidean, <=> cosine, <#> inner product) and approximate nearest-neighbour indexes (HNSW, IVFFlat), so semantic search and RAG can live next to your relational data.',
      'Here each food has a hand-made 3-number embedding: [sweet, savory, crunchy]. Move the sliders to describe a craving and Postgres returns the k nearest foods; the scatter plot shows sweet vs savory, dot size is crunchiness, and lines connect your query to its neighbours. A second table of 10,000 random vectors shows the planner walking an HNSW index.',
      'Real embeddings come from a model and have 384 to 3,072 dimensions; the SQL is exactly the same.',
    ],
    keyApis: ['CREATE EXTENSION vector', 'vector(n)', '<-> / <=> / <#>', 'ORDER BY embedding <-> $1 LIMIT k', 'USING hnsw (embedding vector_l2_ops)', 'hnsw.ef_search', 'ivfflat'],
    useCases: ['Semantic search', 'RAG for LLM apps', 'Recommendations', 'Duplicate detection'],
    snippet: {
      lang: 'sql', name: 'vector.sql', code: `CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE foods (id int PRIMARY KEY, name text, embedding vector(3));

CREATE INDEX ON foods USING hnsw (embedding vector_l2_ops);

SELECT name, embedding <-> '[0.8, 0.2, 0.8]' AS distance
FROM foods
ORDER BY embedding <-> '[0.8, 0.2, 0.8]'
LIMIT 4;`,
    },
    inputs: [
      { name: 'sweet', label: 'Sweet (0–1)', type: 'number', default: 0.8, min: 0, max: 1, step: 0.05 },
      { name: 'savory', label: 'Savory (0–1)', type: 'number', default: 0.2, min: 0, max: 1, step: 0.05 },
      { name: 'crunchy', label: 'Crunchy (0–1)', type: 'number', default: 0.8, min: 0, max: 1, step: 0.05 },
      { name: 'k', label: 'k nearest', type: 'number', default: 4, min: 1, max: 8 },
      { name: 'metric', label: 'Distance', type: 'select', default: 'l2', options: ['l2', 'cosine'] },
    ],
    flow: queryFlow('/api/demos/vector', 'ORDER BY embedding <-> $1 LIMIT k', 'HNSW graph walk'),
    actions: [
      runButton('/api/demos/vector', 'Find nearest', (i) => ({ sweet: i.sweet, savory: i.savory, crunchy: i.crunchy, k: i.k, metric: i.metric })),
      wrongButton('/api/demos/vector', 'Wrong dimensions', (i) => ({ sweet: i.sweet, savory: i.savory, crunchy: i.crunchy, k: i.k, metric: i.metric })),
    ],
    pitfalls: [
      {
        mistake: 'Query vector from a different model or dimension',
        symptom: 'ERROR:  different vector dimensions 3 and 2',
        why: 'Distances only make sense between vectors from the same embedding model.',
        fix: 'Embed the query with the same model; re-embed everything when you change models.',
        avoid: 'Store the model name/version next to the vectors.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Index operator class doesn\'t match the query operator',
        symptom: 'EXPLAIN shows Seq Scan + Sort on a large table even though an HNSW index exists.',
        why: 'An index built with vector_l2_ops serves <->, not <=> (cosine) or <#>.',
        fix: 'Create the index with the opclass for your distance (vector_cosine_ops for <=>).',
        avoid: 'Pick one distance per column and index it.',
      },
      {
        mistake: 'Filtering after the ANN search',
        symptom: 'WHERE category = … ORDER BY embedding <-> $1 LIMIT 10 returns fewer than 10 rows.',
        why: 'HNSW returns the ef_search nearest candidates first, then the filter removes most of them.',
        fix: 'Raise hnsw.ef_search, enable iterative scans (hnsw.iterative_scan, pgvector 0.8+), or use partial indexes per category.',
        avoid: 'Test filtered vector queries for recall, not just speed.',
      },
    ],
    visual: 'vector',
  },
];
