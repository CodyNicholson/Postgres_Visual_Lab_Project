import { flow, queryFlow, runButton, wrongButton } from './flows.js';

const CAT = 'Data types';

export const TYPE_DEMOS = [
  {
    id: 'types',
    category: CAT,
    title: 'Core types: numbers, time, uuid',
    tagline: 'numeric vs float, timestamptz and DST, uuidv7, identity, generated columns, enums, domains',
    description: [
      'Picking the right column type prevents whole classes of bugs. numeric is exact decimal math (money, quantities); float8 is fast binary approximation (measurements). timestamptz stores an absolute moment and displays it in the session time zone; plain timestamp stores wall-clock digits with no zone at all.',
      'Postgres 18 adds uuidv7(): UUIDs that start with a timestamp, so they sort in creation order and index far better than random v4 UUIDs. Generated columns are now VIRTUAL by default (computed when read) unless you say STORED. Identity columns replace serial. Enums give a fixed, ordered set of labels; domains are reusable types with a CHECK built in.',
      'The visual compares 0.1 + 0.2 in both number types, shows "+1 day" vs "+24 hours" across the 2026 daylight-saving change in Berlin, and lists the size of each type. "Do it wrong" writes a timestamp in New York and reads it in Tokyo.',
    ],
    keyApis: ['numeric(p,s)', 'float8', 'timestamptz', 'AT TIME ZONE', 'interval', 'uuidv7() (18)', 'GENERATED ALWAYS AS (…) [STORED]', 'CREATE TYPE … AS ENUM', 'CREATE DOMAIN'],
    useCases: ['Money', 'Event timestamps across time zones', 'Public ids', 'Status columns'],
    snippet: {
      lang: 'sql', name: 'types.sql', code: `SELECT 0.1::float8 + 0.2::float8 = 0.3;   -- false
SELECT 0.1::numeric + 0.2::numeric = 0.3; -- true

CREATE TABLE tickets (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),        -- time-ordered (Postgres 18)
  n          integer GENERATED ALWAYS AS IDENTITY,
  price      numeric(10,2) NOT NULL,
  qty        integer NOT NULL,
  total      numeric GENERATED ALWAYS AS (price * qty),          -- virtual (18 default)
  total_tax  numeric GENERATED ALWAYS AS (price * qty * 1.2) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
CREATE DOMAIN email AS text CHECK (VALUE ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$');`,
    },
    flow: flow('/api/demos/types',
      ['api', 'session', 'SELECT 0.1::float8 + 0.2::float8 …'],
      ['session', 'planner', 'type input/output functions'],
      ['session', 'storage', 'CREATE TABLE tickets (uuidv7, generated)'],
      ['session', 'api', 'typed values'],
    ),
    actions: [runButton('/api/demos/types'), wrongButton('/api/demos/types', 'timestamp without time zone')],
    pitfalls: [
      {
        mistake: 'Storing money in float / real / double precision',
        symptom: '0.1 + 0.2 = 0.30000000000000004, and totals are off by a cent.',
        why: 'Binary floating point cannot represent most decimal fractions exactly.',
        fix: 'ALTER TABLE t ALTER COLUMN amount TYPE numeric(12,2) USING round(amount::numeric, 2);',
        avoid: 'numeric for money, with a separate currency column. Also avoid the money type: it depends on the lc_monetary locale.',
        reproduce: 'run',
      },
      {
        mistake: 'Using timestamp (without time zone) for moments in time',
        symptom: 'Times are off by several hours after a server, container or user changes time zone, or around DST changes.',
        why: 'timestamp stores only wall-clock digits; the zone they were meant in is lost.',
        fix: "ALTER TABLE t ALTER COLUMN at TYPE timestamptz USING at AT TIME ZONE 'UTC'; (with the zone the values were actually written in)",
        avoid: 'Use timestamptz for every point in time (PostgreSQL wiki "Don\'t Do This"). Keep timestamp only for "9:00 local, wherever you are" schedules.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Choosing varchar(n) "to be safe"',
        symptom: 'ERROR:  value too long for type character varying(3)',
        why: 'Arbitrary limits fail when real data turns out longer. In Postgres, text and varchar have the same performance.',
        fix: 'ALTER TABLE t ALTER COLUMN c TYPE text; (cheap, no rewrite)',
        avoid: 'Use text, plus a CHECK (length(c) <= n) only when the limit is a real business rule. Avoid char(n): it pads with spaces.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Random UUIDv4 primary keys on big, write-heavy tables',
        symptom: 'Inserts slow down and the primary-key index grows larger than expected as the table grows.',
        why: 'Random keys land on random index pages, so every insert touches a different page (poor cache locality, more WAL, page splits).',
        fix: 'Use uuidv7() (Postgres 18) or bigint identity for new tables.',
        avoid: 'Prefer time-ordered ids for anything indexed and inserted at high rates.',
      },
    ],
    visual: 'types',
  },
  {
    id: 'jsonb',
    category: CAT,
    title: 'JSONB',
    tagline: 'Documents in a relational database: operators, JSON path, JSON_TABLE, GIN indexes',
    description: [
      'jsonb stores JSON in a parsed binary form, so Postgres can index it and query inside it. -> returns a JSON value, ->> returns text, @> asks "does this document contain that sub-document?", ? checks for a key, and SQL/JSON path (@@, jsonb_path_query) filters inside nested structures.',
      'Pick a colour and run: the @> query finds products whose attrs contain {"color": …}. Other tabs modify documents (||, jsonb_set, -), build JSON for an API response (jsonb_build_object, jsonb_agg), and use JSON_TABLE (Postgres 17+) to turn a JSON array into rows. The last two tabs prove that @> uses a GIN index while ->> = cannot.',
      'jsonb is great for genuinely variable attributes. It is a poor replacement for real columns: no types, no foreign keys, and worse statistics for the planner.',
    ],
    keyApis: ['->', '->>', '#>>', '@>', '?', '@@ / jsonb_path_query', 'jsonb_set', 'jsonb_agg', 'JSON_TABLE (17)', 'GIN jsonb_path_ops'],
    useCases: ['Product attributes', 'Event payloads', 'Settings', 'API responses built in SQL'],
    snippet: {
      lang: 'sql', name: 'jsonb.sql', code: `SELECT name, attrs ->> 'color' AS color FROM products WHERE attrs @> '{"color": "black"}';
SELECT name FROM products WHERE attrs ? 'wireless';
SELECT name FROM products WHERE attrs @@ '$.pages > 400';
UPDATE products SET attrs = jsonb_set(attrs, '{color}', '"purple"') WHERE id = 5;

CREATE INDEX ON products USING gin (attrs jsonb_path_ops);   -- serves @>, @@

SELECT jt.* FROM JSON_TABLE(
  '{"cart": [{"sku": "KB-1", "qty": 1}, {"sku": "MS-1", "qty": 2}]}'::jsonb,
  '$.cart[*]' COLUMNS (sku text PATH '$.sku', qty int PATH '$.qty')) jt;`,
    },
    inputs: [{ name: 'color', label: 'attrs @> {"color": …}', type: 'select', default: 'black', options: ['black', 'white', 'grey', 'green', 'red', 'steel'] }],
    flow: queryFlow('/api/demos/jsonb', "SELECT … WHERE attrs @> '{\"color\": …}'", 'GIN index → matching rows'),
    actions: [
      runButton('/api/demos/jsonb', 'Run the queries', (i) => ({ color: i.color })),
      wrongButton('/api/demos/jsonb', 'Compare -> with a string', (i) => ({ color: i.color })),
    ],
    pitfalls: [
      {
        mistake: "Comparing -> (jsonb) with a plain string",
        symptom: 'ERROR:  invalid input syntax for type json\nDETAIL:  Token "black" is invalid.',
        why: "attrs -> 'color' is jsonb, so 'black' is parsed as JSON, and a bare word isn't valid JSON.",
        fix: "Use ->> for text: attrs ->> 'color' = 'black', or compare JSON: attrs -> 'color' = '\"black\"'.",
        avoid: 'Use -> to navigate, ->> at the last step to get a value.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Expecting a GIN index to speed up ->> equality',
        symptom: 'EXPLAIN shows Seq Scan for WHERE attrs ->> \'color\' = \'white\' even though a GIN index exists.',
        why: 'GIN on jsonb supports @>, ?, ?|, ?& and @@, not ->> comparisons.',
        fix: "Query with @> '{\"color\": \"white\"}', or create an expression index: CREATE INDEX ON products ((attrs ->> 'color'));",
        avoid: 'Write the query first, then choose the index that supports that operator.',
        reproduce: 'run',
      },
      {
        mistake: 'Putting everything in one jsonb column',
        symptom: 'Bad row estimates and slow queries; no way to enforce types or foreign keys; huge rows rewritten on every small change.',
        why: 'The planner has no per-key statistics, and every update rewrites the whole document (plus TOAST).',
        fix: 'Promote frequently queried or joined keys to real columns (a generated column can extract them).',
        avoid: 'Columns for known structure, jsonb for the genuinely variable rest.',
      },
    ],
    visual: 'jsonb',
  },
  {
    id: 'arrays-ranges',
    category: CAT,
    title: 'Arrays & range types',
    tagline: 'Arrays, ranges, exclusion constraints and Postgres 18 temporal keys',
    description: [
      'Arrays hold several values in one column (tags, small lists): test membership with = ANY, containment with @>, overlap with &&, and turn them into rows with unnest. Range types hold an interval of values with explicit bounds: [10,20) includes 10 and excludes 20. They support contains, overlaps, intersection and merging (range_agg).',
      'The killer feature is the exclusion constraint: "no two rows may have the same room AND overlapping times". A UNIQUE constraint cannot express that. The timeline shows the bookings that went in, and the overlapping one Postgres rejected. Postgres 18 also adds temporal keys: PRIMARY KEY (sku, valid_at WITHOUT OVERLAPS).',
      '"Do it wrong" shows the naive design: UNIQUE (room, check_in) happily accepts a double booking.',
    ],
    keyApis: ['= ANY(array)', '@> / &&', 'unnest … WITH ORDINALITY', 'array_sort (18)', 'int4range / tstzrange / daterange', 'range_agg', 'EXCLUDE USING gist', 'WITHOUT OVERLAPS (18)'],
    useCases: ['Room and resource booking', 'Price validity periods', 'Tags', 'Shift scheduling'],
    snippet: {
      lang: 'sql', name: 'bookings.sql', code: `CREATE EXTENSION IF NOT EXISTS btree_gist;   -- lets GiST handle "room WITH ="

CREATE TABLE bookings (
  room   text NOT NULL,
  guest  text NOT NULL,
  during tstzrange NOT NULL,
  EXCLUDE USING gist (room WITH =, during WITH &&)
);

CREATE TABLE prices (
  sku text, price numeric, valid_at daterange,
  PRIMARY KEY (sku, valid_at WITHOUT OVERLAPS)   -- Postgres 18
);

SELECT name FROM products WHERE 'usb' = ANY(tags) OR tags && ARRAY['steel','iron'];`,
    },
    flow: flow('/api/demos/arrays-ranges',
      ['api', 'session', 'INSERT INTO bookings …'],
      ['session', 'storage', 'GiST index: any overlapping range for room 101?'],
      ['storage', 'session', 'conflict found → reject'],
      ['session', 'api', 'error 23P01'],
    ),
    actions: [runButton('/api/demos/arrays-ranges'), wrongButton('/api/demos/arrays-ranges', 'Double booking with UNIQUE')],
    pitfalls: [
      {
        mistake: 'Preventing overlaps with UNIQUE or an application check',
        symptom: 'Two guests booked into the same room on the same night (no error at all).',
        why: 'UNIQUE compares equality only, and app-side "is it free?" checks race with each other.',
        fix: 'Add EXCLUDE USING gist (room WITH =, during WITH &&) (needs btree_gist), or WITHOUT OVERLAPS on Postgres 18.',
        avoid: 'Model periods as range types and let the database enforce non-overlap.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Expecting the exclusion error to be a unique violation',
        symptom: 'ERROR:  conflicting key value violates exclusion constraint "bookings_room_during_excl"\nDETAIL:  Key (room, during)=(101, ["2026-11-02 14:00:00+00","2026-11-04 11:00:00+00")) conflicts with existing key …',
        why: 'Exclusion violations have SQLSTATE 23P01, not 23505, so handlers that catch only unique violations miss them.',
        fix: 'Handle 23P01 (psycopg.errors.ExclusionViolation) and show "already booked".',
        avoid: 'Map each constraint to a user-facing message by constraint name.',
        reproduce: 'run',
      },
      {
        mistake: 'Big or ever-growing arrays instead of a child table',
        symptom: 'Updates get slower as the array grows; you cannot add a foreign key to array elements.',
        why: 'Every change rewrites the whole array value; elements can\'t be referenced or constrained individually.',
        fix: 'Move the elements to a child table with a foreign key.',
        avoid: 'Arrays for small, read-mostly lists; tables for relationships.',
      },
    ],
    visual: 'ranges',
  },
  {
    id: 'fulltext',
    category: CAT,
    title: 'Full-text search',
    tagline: 'tsvector, tsquery, ranking and highlighting, with a GIN index',
    description: [
      'Full-text search finds documents by meaning-ish word matches rather than exact substrings. to_tsvector turns text into lexemes: lower-cased, stop words dropped, words stemmed (running → run, indexes → index). A tsquery describes what to find; @@ tests a match; ts_rank scores it and ts_headline highlights the matching words.',
      'Type a search and run it. The articles table has a stored tsvector column (title weighted higher than body) with a GIN index. websearch_to_tsquery accepts what people type in a search box: plain words, "quoted phrases", or, and -exclusions.',
      'Postgres search is good enough for many apps (docs, products, tickets) without running Elasticsearch, but it has no typo tolerance: combine it with pg_trgm for that (see the trigram demo).',
    ],
    keyApis: ['to_tsvector', 'websearch_to_tsquery', 'to_tsquery (& | ! <->)', '@@', 'ts_rank', 'ts_headline', 'setweight', 'GIN (tsvector)'],
    useCases: ['Site search', 'Help-center articles', 'Product search', 'Ticket search'],
    snippet: {
      lang: 'sql', name: 'search.sql', code: `ALTER TABLE articles ADD COLUMN search tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', body), 'B')
) STORED;
CREATE INDEX ON articles USING gin (search);

SELECT title, ts_rank(search, q) AS rank,
       ts_headline('english', body, q) AS headline
FROM articles, websearch_to_tsquery('english', $1) AS q
WHERE search @@ q
ORDER BY rank DESC LIMIT 8;`,
    },
    inputs: [{ name: 'q', label: 'Search (websearch syntax)', type: 'text', default: 'indexes for fast queries' }],
    flow: queryFlow('/api/demos/fulltext', 'WHERE search @@ websearch_to_tsquery($1)', 'GIN index lookup per lexeme'),
    actions: [
      runButton('/api/demos/fulltext', 'Search', (i) => ({ q: i.q })),
      wrongButton('/api/demos/fulltext', 'Raw input into to_tsquery', (i) => ({ q: i.q })),
    ],
    pitfalls: [
      {
        mistake: 'Passing user input to to_tsquery',
        symptom: 'ERROR:  syntax error in tsquery: "fast queries"',
        why: 'to_tsquery expects operator syntax (fast & queries). Two plain words, a stray & or a quote is a syntax error.',
        fix: 'Use websearch_to_tsquery (search-box syntax) or plainto_tsquery (all words AND-ed).',
        avoid: 'to_tsquery only for queries your code builds.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Computing to_tsvector in the WHERE clause on every query',
        symptom: 'Search is slow and EXPLAIN shows a Seq Scan, even with "an index on body".',
        why: "WHERE to_tsvector(body) @@ q can only use an index on exactly that expression, including the same configuration ('english').",
        fix: 'Add a STORED generated tsvector column with a GIN index (as here), or CREATE INDEX … USING gin (to_tsvector(\'english\', body)).',
        avoid: 'Always pass the configuration explicitly so the expression matches the index.',
      },
      {
        mistake: 'Expecting LIKE-style substring or typo matches',
        symptom: "Searching 'postgr' or 'serch' finds nothing.",
        why: 'Full-text search matches whole lexemes. Prefixes need :* (postgr:*); typos need trigram similarity.',
        fix: "Use to_tsquery('postgr:*') for prefixes and pg_trgm for fuzzy matching.",
        avoid: 'Choose the tool by the question: FTS for words, trigram for fuzzy, LIKE for exact substrings.',
      },
    ],
    visual: 'fulltext',
  },
];
