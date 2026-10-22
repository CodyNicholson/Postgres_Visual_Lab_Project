"""Seeds the shared, read-only sample data every query demo reads (schema `shop`).

Idempotent: a version marker skips the work when the data is already there, and an
advisory lock stops two starting processes from seeding at once. Bump SEED_VERSION after
changing the data and the schema is rebuilt on the next start.
"""

from __future__ import annotations

import logging

from .db import pool

log = logging.getLogger("seed")

SEED_VERSION = 3
EVENT_ROWS = 200_000

SCHEMA_SQL = r"""
DROP SCHEMA IF EXISTS shop CASCADE;
CREATE SCHEMA shop;
SET search_path = shop, public;
SELECT setseed(0.42);

CREATE TABLE customers (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL,
  email       text NOT NULL UNIQUE,
  country     text NOT NULL,
  signup_at   timestamptz NOT NULL,
  referred_by integer REFERENCES customers(id)
);

CREATE TABLE products (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL,
  category    text NOT NULL,
  price       numeric(10,2) NOT NULL CHECK (price > 0),
  tags        text[] NOT NULL DEFAULT '{}',
  attrs       jsonb NOT NULL DEFAULT '{}',
  description text NOT NULL
);

CREATE TABLE orders (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers(id),
  status      text NOT NULL CHECK (status IN ('pending','paid','shipped','cancelled')),
  ordered_at  timestamptz NOT NULL
);
CREATE INDEX orders_customer_id_idx ON orders(customer_id);

CREATE TABLE order_items (
  order_id    integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  integer NOT NULL REFERENCES products(id),
  qty         integer NOT NULL CHECK (qty > 0),
  unit_price  numeric(10,2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);
CREATE INDEX order_items_product_id_idx ON order_items(product_id);

CREATE TABLE employees (
  id          integer PRIMARY KEY,
  name        text NOT NULL,
  title       text NOT NULL,
  manager_id  integer REFERENCES employees(id),
  salary      numeric(10,2) NOT NULL
);

CREATE TABLE articles (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title       text NOT NULL,
  body        text NOT NULL,
  search      tsvector GENERATED ALWAYS AS (
                setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', body), 'B')
              ) STORED
);
CREATE INDEX articles_search_idx ON articles USING gin (search);

CREATE TABLE foods (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL,
  embedding   vector(3) NOT NULL  -- [sweet, savory, crunchy], each 0..1
);

CREATE TABLE events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     integer NOT NULL,
  kind        text NOT NULL,
  created_at  timestamptz NOT NULL,
  payload     jsonb NOT NULL
);
"""

CUSTOMERS = [
    ("Ada Lovelace", "UK"), ("Grace Hopper", "US"), ("Linus Torvalds", "FI"), ("Margaret Hamilton", "US"),
    ("Edsger Dijkstra", "NL"), ("Barbara Liskov", "US"), ("Ken Thompson", "US"), ("Sophie Wilson", "UK"),
    ("Tim Berners-Lee", "UK"), ("Frances Allen", "US"), ("Niklaus Wirth", "CH"), ("Radia Perlman", "US"),
    ("Guido van Rossum", "NL"), ("Anita Borg", "US"), ("Bjarne Stroustrup", "DK"), ("Hedy Lamarr", "AT"),
    ("Alan Kay", "US"), ("Karen Sparck Jones", "UK"), ("John Backus", "US"), ("Shafi Goldwasser", "US"),
    ("Donald Knuth", "US"), ("Leslie Lamport", "US"), ("Jean Bartik", "US"), ("Yukihiro Matsumoto", "JP"),
    ("Michael Stonebraker", "US"), ("Martina Zitterbart", "DE"), ("Ole-Johan Dahl", "NO"), ("Kristen Nygaard", "NO"),
    ("Bram Moolenaar", "NL"), ("Rasmus Lerdorf", "DK"), ("Anders Hejlsberg", "DK"), ("Monica Lam", "US"),
    ("Joan Clarke", "UK"), ("Tony Hoare", "UK"), ("Andrew Tanenbaum", "NL"),
    # The last five never order anything: LEFT JOIN, anti-join and NOT EXISTS demos find them
    ("Carol Shaw", "US"), ("Klara Dan", "HU"), ("Mary Kenneth Keller", "US"), ("Annie Easley", "US"), ("Erna Hoover", "US"),
]

PRODUCTS = [
    ("The Art of SQL", "Books", 39.90, ["sql", "database"], {"pages": 368, "format": "paperback"},
     "A practical guide to writing fast, readable SQL queries for relational databases."),
    ("Designing Data-Intensive Apps", "Books", 54.00, ["database", "distributed"], {"pages": 616, "format": "hardcover"},
     "Replication, partitioning, transactions and stream processing explained for engineers."),
    ("PostgreSQL Internals", "Books", 45.50, ["postgres", "database"], {"pages": 640, "format": "ebook"},
     "How PostgreSQL stores tuples, runs MVCC, plans queries and writes the WAL."),
    ("Cooking for Engineers", "Books", 24.99, ["cooking"], {"pages": 280, "format": "paperback"},
     "Recipes written like algorithms: precise temperatures, timings and quantities."),
    ("Mechanical Keyboard", "Electronics", 129.00, ["keyboard", "usb"], {"color": "black", "switches": "brown", "wireless": False},
     "Tactile switches, aluminium case and a detachable USB-C cable for long typing sessions."),
    ("Wireless Mouse", "Electronics", 49.00, ["mouse", "wireless"], {"color": "white", "dpi": 4000, "wireless": True},
     "Quiet clicks, silent scrolling and a battery that lasts three months."),
    ("4K Monitor", "Electronics", 399.00, ["display", "usb"], {"color": "black", "inches": 27, "hdr": True},
     "A 27 inch display with accurate colours, USB-C power delivery and a height adjustable stand."),
    ("Noise Cancelling Headphones", "Electronics", 249.00, ["audio", "wireless"], {"color": "black", "anc": True, "wireless": True},
     "Wireless over-ear headphones that silence the open office."),
    ("USB-C Hub", "Electronics", 35.00, ["usb"], {"color": "grey", "ports": 7},
     "Seven ports in one: HDMI, Ethernet, SD card and four USB connectors."),
    ("Chef's Knife", "Kitchen", 89.00, ["knife", "steel"], {"steel": "VG-10", "length_cm": 21},
     "A sharp Japanese steel blade that slices tomatoes without crushing them."),
    ("Cast Iron Pan", "Kitchen", 59.00, ["pan", "iron"], {"diameter_cm": 26, "preseasoned": True},
     "Heavy, pre-seasoned and almost indestructible; goes from stove to oven."),
    ("Espresso Machine", "Kitchen", 499.00, ["coffee"], {"bar": 15, "color": "steel", "milk_frother": True},
     "Fifteen bar pump, steam wand and a grinder for fresh coffee every morning."),
    ("Pour-over Kettle", "Kitchen", 69.00, ["coffee", "kettle"], {"litres": 1.0, "color": "black"},
     "A gooseneck kettle with precise temperature control for slow coffee."),
    ("Sourdough Starter Kit", "Kitchen", 19.00, ["baking"], {"jars": 2},
     "Everything you need to grow a starter and bake crusty bread at home."),
    ("Garden Hose", "Garden", 29.00, ["water"], {"length_m": 25, "color": "green"},
     "Kink-resistant hose with a brass connector and seven spray patterns."),
    ("Tomato Seeds", "Garden", 4.50, ["seeds", "tomato"], {"variety": "San Marzano", "count": 50},
     "Heirloom tomato seeds for rich sauces; plant them after the last frost."),
    ("Pruning Shears", "Garden", 32.00, ["tools", "steel"], {"steel": "carbon", "color": "red"},
     "Sharp bypass shears for roses, shrubs and small branches."),
    ("Raised Garden Bed", "Garden", 149.00, ["wood"], {"wood": "cedar", "length_cm": 180},
     "A cedar planter box that keeps weeds out and your back happy."),
    ("Board Game: Ticket to Ride", "Games", 44.00, ["family", "strategy"], {"players": "2-5", "minutes": 60},
     "Collect cards, claim railway routes and connect cities across the map."),
    ("Chess Set", "Games", 79.00, ["strategy", "wood"], {"material": "walnut", "players": "2"},
     "Hand-carved walnut pieces and a folding board with felt-lined storage."),
    ("Jigsaw Puzzle 1000", "Games", 18.00, ["family"], {"pieces": 1000},
     "A thousand pieces of a sunset harbour; perfect for rainy weekends."),
    ("Card Game: Codenames", "Games", 22.00, ["family", "party"], {"players": "4-8", "minutes": 15},
     "A party word game of clues and secret agents for big groups."),
    ("Retro Game Console", "Games", 119.00, ["video", "usb"], {"games": 400, "controllers": 2},
     "Four hundred classic games and two wired controllers in a tiny box."),
    ("Desk Lamp", "Electronics", 39.00, ["light", "usb"], {"color": "white", "lumens": 800},
     "A dimmable LED desk lamp with a USB charging port in the base."),
]

EMPLOYEES = [
    (1, "Mia Chen", "CEO", None, 250000), (2, "Leo Park", "CTO", 1, 210000), (3, "Ava Ruiz", "CFO", 1, 200000),
    (4, "Noah Kim", "Engineering Manager", 2, 160000), (5, "Zoe Patel", "Data Lead", 2, 155000),
    (6, "Eli Novak", "Backend Engineer", 4, 130000), (7, "Ivy Brooks", "Backend Engineer", 4, 128000),
    (8, "Sam Okafor", "Frontend Engineer", 4, 120000), (9, "Ruby Diaz", "DBA", 5, 140000),
    (10, "Max Weber", "Data Engineer", 5, 125000), (11, "Lily Moss", "Accountant", 3, 90000),
    (12, "Omar Haddad", "Junior Engineer", 6, 85000), (13, "Nina Rossi", "Intern", 12, 40000),
    (14, "Theo Lang", "Controller", 3, 110000), (15, "Yara Silva", "Analyst", 10, 95000),
]

ARTICLES = [
    ("Why PostgreSQL uses MVCC", "Multiversion concurrency control lets readers and writers work at the same time. "
     "Every update writes a new row version; VACUUM later removes the dead versions."),
    ("Indexing strategies for fast queries", "A B-tree index speeds up equality and range searches. GIN indexes "
     "handle arrays, JSONB and full text search, while BRIN indexes stay tiny on huge append-only tables."),
    ("Understanding EXPLAIN ANALYZE", "The query planner estimates costs and picks a plan. EXPLAIN ANALYZE runs "
     "the query and shows real timings, row counts and buffers for every node."),
    ("Transactions and isolation levels", "Read committed, repeatable read and serializable isolation decide which "
     "concurrent changes a transaction can see. Serializable may abort with a serialization failure you must retry."),
    ("Partitioning large tables", "Range partitioning splits a big table by date so queries prune partitions and "
     "old data can be dropped instantly instead of deleted row by row."),
    ("JSONB in a relational database", "JSONB stores documents in a binary format with GIN indexing, containment "
     "queries and JSON path expressions, without giving up joins and transactions."),
    ("Replication and high availability", "Streaming replication ships the write-ahead log to standby servers that "
     "can serve read-only queries and take over when the primary fails."),
    ("Connection pooling with PgBouncer", "Every PostgreSQL connection is a process. A pooler shares a few server "
     "connections between many clients and avoids running out of connections."),
    ("Running out of disk because of bloat", "Long-running transactions stop VACUUM from removing dead rows, so "
     "tables and indexes keep growing until queries slow down."),
    ("Full text search without Elasticsearch", "tsvector and tsquery give stemming, ranking and highlighting. "
     "Searching for running also finds run and runs because words are reduced to lexemes."),
    ("Locks, deadlocks and lock queues", "Row locks protect concurrent updates. When two transactions wait for each "
     "other PostgreSQL detects the deadlock and aborts one of them."),
    ("Backups with pg_dump and point in time recovery", "pg_dump writes a logical backup of one database. Physical "
     "base backups plus archived WAL let you restore to any moment in time."),
    ("Row level security for multi-tenant apps", "Policies filter rows per user or tenant inside the database, so a "
     "forgotten WHERE clause in the application cannot leak another customer's data."),
    ("Vector similarity search with pgvector", "Store embeddings next to your rows and find the nearest neighbours "
     "with cosine or Euclidean distance, accelerated by HNSW indexes."),
    ("Running a sourdough bakery", "Feeding the starter, shaping loaves and running the oven before sunrise: a "
     "baker's diary with nothing to do with databases."),
]

FOODS = [
    ("chocolate cake", [0.95, 0.05, 0.10]), ("ice cream", [0.90, 0.02, 0.05]), ("caramel popcorn", [0.80, 0.15, 0.85]),
    ("apple", [0.70, 0.05, 0.80]), ("granola", [0.60, 0.10, 0.90]), ("honey toast", [0.75, 0.25, 0.60]),
    ("potato chips", [0.05, 0.80, 0.95]), ("pretzels", [0.05, 0.75, 0.90]), ("fried chicken", [0.05, 0.90, 0.75]),
    ("pizza", [0.10, 0.90, 0.40]), ("mashed potatoes", [0.05, 0.75, 0.02]), ("tomato soup", [0.20, 0.70, 0.00]),
    ("cheese", [0.05, 0.85, 0.10]), ("carrot sticks", [0.35, 0.20, 0.90]), ("yogurt", [0.55, 0.15, 0.00]),
    ("salted caramel", [0.85, 0.55, 0.30]),
]

DATA_SQL = r"""
SET search_path = shop, public;
SELECT setseed(0.42);

-- Every customer except the first ten was referred by an earlier one, some of the time
UPDATE customers c SET referred_by = 1 + ((c.id * 7) % (c.id - 1))
WHERE c.id > 10 AND c.id % 3 = 0;

-- 360 orders over Jan–Sep 2026 from customers 1..35 (36..40 never order)
INSERT INTO orders (customer_id, status, ordered_at)
SELECT 1 + floor(power(random(), 1.6) * 35)::int,
       (ARRAY['paid','paid','shipped','shipped','shipped','pending','cancelled'])[1 + floor(random() * 7)::int],
       timestamptz '2026-01-01 00:00+00' + random() * interval '270 days'
FROM generate_series(1, 360);

INSERT INTO order_items (order_id, product_id, qty, unit_price)
SELECT DISTINCT ON (o.id, p.pid) o.id, p.pid, 1 + floor(random() * 3)::int, pr.price
FROM orders o
CROSS JOIN LATERAL (
  SELECT 1 + floor(random() * 24)::int AS pid FROM generate_series(1, 1 + (o.id % 4)) WHERE o.id > 0
) p
JOIN products pr ON pr.id = p.pid;

-- 200k events, appended in time order (perfect for BRIN), with a skewed `kind` distribution
INSERT INTO events (user_id, kind, created_at, payload)
SELECT 1 + floor(random() * 5000)::int,
       CASE WHEN r < 0.60 THEN 'page_view' WHEN r < 0.80 THEN 'click' WHEN r < 0.92 THEN 'search'
            WHEN r < 0.97 THEN 'add_to_cart' WHEN r < 0.995 THEN 'purchase' ELSE 'refund' END,
       timestamptz '2026-01-01 00:00+00' + (g * interval '1 minute' * 270 * 24 * 60 / {rows}),
       jsonb_build_object('device', (ARRAY['mobile','desktop','tablet'])[1 + floor(random() * 3)::int],
                          'ms', floor(random() * 2000)::int)
FROM (SELECT g, random() AS r FROM generate_series(1, {rows}) g) s;
CREATE INDEX events_user_id_idx ON events(user_id);

CREATE TABLE seed_info (version integer NOT NULL, seeded_at timestamptz NOT NULL DEFAULT now());
INSERT INTO seed_info (version) VALUES ({version});
ANALYZE;
"""

ROLES_SQL = r"""
DO $$
BEGIN
  -- Roles for the security demos (cluster-wide, so created once and never dropped)
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'lab_reader') THEN CREATE ROLE lab_reader NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'lab_writer') THEN CREATE ROLE lab_writer NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'lab_app') THEN CREATE ROLE lab_app NOLOGIN; END IF;
END $$;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pageinspect;
CREATE EXTENSION IF NOT EXISTS pgstattuple;
"""


def seed() -> str:
    with pool.connection() as conn:
        conn.execute("SET statement_timeout = 0")
        conn.execute("SELECT pg_advisory_lock(424242)")
        try:
            conn.execute(ROLES_SQL)
            current = conn.execute(
                "SELECT to_regclass('shop.seed_info') IS NOT NULL AS present"
            ).fetchone()["present"]
            if current:
                version = conn.execute("SELECT max(version) AS v FROM shop.seed_info").fetchone()["v"]
                if version == SEED_VERSION:
                    return "already seeded"
            log.info("seeding schema shop (version %s)", SEED_VERSION)
            with conn.transaction():
                conn.execute(SCHEMA_SQL)
                with conn.cursor() as cur:
                    cur.executemany("INSERT INTO shop.customers (name, email, country, signup_at) VALUES "
                                    "(%s, %s, %s, timestamptz '2025-01-01 09:00+00' + %s * interval '8 days 3 hours')",
                                    [(n, n.lower().replace(' ', '.').replace("'", '') + "@example.com", c, i)
                                     for i, (n, c) in enumerate(CUSTOMERS)])
                    from psycopg.types.json import Jsonb
                    cur.executemany("INSERT INTO shop.products (name, category, price, tags, attrs, description) "
                                    "VALUES (%s, %s, %s, %s, %s, %s)",
                                    [(n, c, p, t, Jsonb(a), desc) for n, c, p, t, a, desc in PRODUCTS])
                    cur.executemany("INSERT INTO shop.employees VALUES (%s, %s, %s, %s, %s)", EMPLOYEES)
                    cur.executemany("INSERT INTO shop.articles (title, body) VALUES (%s, %s)", ARTICLES)
                    cur.executemany("INSERT INTO shop.foods (name, embedding) VALUES (%s, %s::vector)",
                                    [(n, str(v)) for n, v in FOODS])
                # Multi-statement SQL can't take bound parameters; these are trusted integer constants
                conn.execute(DATA_SQL.replace("{rows}", str(int(EVENT_ROWS))).replace("{version}", str(int(SEED_VERSION))))
                conn.execute("GRANT USAGE ON SCHEMA shop TO lab_reader, lab_writer, lab_app")
                conn.execute("GRANT SELECT ON ALL TABLES IN SCHEMA shop TO lab_reader, lab_writer, lab_app")
            conn.execute("VACUUM ANALYZE shop.events")
            return "seeded"
        finally:
            conn.execute("SELECT pg_advisory_unlock(424242)")
