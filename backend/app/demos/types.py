"""Data types: core scalar types (numeric, time, uuid, identity, generated columns, enums,
domains), JSONB, arrays and range types (with exclusion and temporal constraints), and
full-text search."""

from __future__ import annotations

import psycopg
from fastapi import APIRouter, Query

from ..db import fail, run, scratch, session, value
from ..lab import Demo, clamp, pick

router = APIRouter(prefix="/api/demos")


@router.post("/types")
def core_types(mistake: bool = False) -> dict:
    with Demo("types") as d, scratch(d, "types") as schema, session(schema) as conn:
        money = run(d, conn, """
            SELECT 0.1::float8 + 0.2::float8 AS float_sum,
                   0.1::float8 + 0.2::float8 = 0.3 AS float_equals,
                   0.1::numeric + 0.2::numeric AS numeric_sum,
                   0.1::numeric + 0.2::numeric = 0.3 AS numeric_equals""",
            title="numeric vs float",
            note="float8 is binary floating point: fast but inexact. numeric is exact decimal arithmetic: use it for money and quantities.")
        run(d, conn, "SET TIME ZONE 'Europe/Berlin'")
        tz = run(d, conn, """
            SELECT timestamptz '2026-03-28 12:00 Europe/Berlin' AS start_berlin,
                   timestamptz '2026-03-28 12:00 Europe/Berlin' AT TIME ZONE 'UTC' AS start_utc_wall_clock,
                   timestamptz '2026-03-28 12:00 Europe/Berlin' + interval '1 day' AS plus_1_day,
                   timestamptz '2026-03-28 12:00 Europe/Berlin' + interval '24 hours' AS plus_24h""",
            title="timestamptz, AT TIME ZONE and interval across a DST change",
            note="timestamptz stores an absolute instant and shows it in the session TimeZone (Europe/Berlin here). Clocks jump forward on 29 March 2026, so '1 day' (same wall-clock time tomorrow) is 23 hours, while '24 hours' lands at 13:00.")
        run(d, conn, "SET TIME ZONE 'UTC'")
        run(d, conn, """
            SELECT date_trunc('month', timestamptz '2026-10-22 13:45+00') AS month_start,
                   extract(isodow FROM date '2026-10-22') AS iso_weekday,
                   age(date '2026-10-22', date '1996-02-29') AS age,
                   (date '2026-12-25' - date '2026-10-22') AS days_to_xmas""",
            title="date_trunc, extract, age, date arithmetic", note="Dates subtract to integers (days); timestamps subtract to intervals.")
        run(d, conn, """
            CREATE TABLE tickets (
              id         uuid PRIMARY KEY DEFAULT uuidv7(),
              n          integer GENERATED ALWAYS AS IDENTITY,
              price      numeric(10,2) NOT NULL,
              qty        integer NOT NULL,
              total      numeric GENERATED ALWAYS AS (price * qty),
              total_tax  numeric GENERATED ALWAYS AS (price * qty * 1.2) STORED,
              created_at timestamptz NOT NULL DEFAULT now()
            )""", title="uuidv7(), identity and generated columns (Postgres 18)",
            note="uuidv7() (new in 18) makes time-ordered UUIDs that index well. Generated columns are now VIRTUAL by default (computed on read); STORED writes them to disk.")
        run(d, conn, "INSERT INTO tickets (price, qty) SELECT 9.99, g FROM generate_series(1, 5) g")
        tickets = run(d, conn, "SELECT n, id, price, qty, total, total_tax FROM tickets ORDER BY id",
                      title="Rows sorted by uuidv7 come out in insert order")
        run(d, conn, "CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')", title="CREATE TYPE … AS ENUM",
            note="A fixed list of labels, stored in 4 bytes and sorted in declaration order (not alphabetically).")
        run(d, conn, "CREATE DOMAIN email AS text CHECK (VALUE ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')",
            title="CREATE DOMAIN (a type with rules)", note="A reusable type with a CHECK built in: every column of type email validates itself.")
        run(d, conn, "CREATE TABLE people (name text, m mood, contact email)")
        run(d, conn, "INSERT INTO people VALUES ('a', 'happy', 'a@x.io'), ('b', 'sad', 'b@x.io'), ('c', 'ok', 'c@x.io')")
        moods = run(d, conn, "SELECT name, m FROM people ORDER BY m", title="Enums sort by declaration order")
        bad_email = fail(d, conn, "INSERT INTO people VALUES ('d', 'ok', 'not-an-email')", title="The domain rejects a bad value")
        run(d, conn, """
            SELECT pg_column_size(1::smallint) AS smallint_bytes, pg_column_size(1::int) AS int_bytes,
                   pg_column_size(1::bigint) AS bigint_bytes, pg_column_size(1.5::numeric) AS numeric_bytes,
                   pg_column_size('hello'::text) AS text_bytes, pg_column_size(now()) AS timestamptz_bytes,
                   pg_column_size(uuidv7()) AS uuid_bytes""",
            title="How big is each type?", note="pg_column_size shows the bytes a value takes. text has no length penalty versus varchar.")
        if mistake:
            run(d, conn, "CREATE TABLE logins (at timestamp, at_tz timestamptz)")
            run(d, conn, "SET TIME ZONE 'America/New_York'", label="mistake")
            run(d, conn, "INSERT INTO logins VALUES (now(), now())", label="mistake")
            run(d, conn, "SET TIME ZONE 'Asia/Tokyo'", label="mistake")
            drift = run(d, conn, "SELECT at, at_tz, at_tz - at::timestamptz AS error FROM logins", label="mistake",
                        title="WRONG: timestamp without time zone",
                        note="Written by a session in New York, read in Tokyo: `timestamp` kept the wall-clock digits and lost the zone, so the instant is now 13–14 hours off. timestamptz is still exact.")
            run(d, conn, "SET TIME ZONE 'UTC'", label="mistake")
            e = fail(d, conn, "CREATE TABLE codes (c varchar(3)); INSERT INTO codes VALUES ('ABCD')", label="mistake",
                     title="WRONG: varchar(n) limits that turn out too small", note="Arbitrary length limits fail in production. Use text plus a CHECK only when the rule is real.")
            d.check("timestamp without time zone drifted by the zone difference",
                    drift and str(drift[0]["error"]) not in ("0:00:00", "00:00:00"), drift[0]["error"] if drift else None)
            d.check("varchar(3) rejected a 4-character value", e and "value too long" in e, e)
            d.data["mode"] = "mistake"
        d.check("float8 0.1 + 0.2 ≠ 0.3, numeric gets it exactly",
                money[0]["float_equals"] is False and money[0]["numeric_equals"] is True, money[0]["float_sum"])
        d.check("Across the DST change '1 day' ≠ '24 hours'", tz[0]["plus_1_day"] != tz[0]["plus_24h"],
                f"+1 day → {tz[0]['plus_1_day']}, +24 h → {tz[0]['plus_24h']}")
        d.check("uuidv7 order equals insert order", [r["n"] for r in tickets] == [1, 2, 3, 4, 5])
        d.check("Virtual and stored generated columns computed price × qty",
                all(float(r["total"]) == round(9.99 * r["qty"], 2) for r in tickets))
        d.check("Enum sorted sad < ok < happy and the domain rejected 'not-an-email'",
                [r["m"] for r in moods] == ["sad", "ok", "happy"] and bad_email and "violates check constraint" in bad_email, bad_email)
    return d.result()


@router.post("/jsonb")
def jsonb(color: str = "black", mistake: bool = False) -> dict:
    color = pick(color, ["black", "white", "grey", "green", "red", "steel"], "black")
    with Demo("jsonb") as d, session() as conn:
        run(d, conn, """
            SELECT name, attrs,
                   attrs -> 'color'  AS color_json,
                   attrs ->> 'color' AS color_text,
                   (attrs ->> 'wireless')::boolean AS wireless
            FROM products WHERE category = 'Electronics' ORDER BY name""",
            title="-> and ->> operators", note="-> returns jsonb (keeps quotes and type), ->> returns text. Cast ->> to compare numbers or booleans.")
        contains = run(d, conn, "SELECT name, attrs FROM products WHERE attrs @> %s::jsonb ORDER BY name",
                       [f'{{"color": "{color}"}}'],
                       title="@> containment (uses a GIN index)", note="Does the document contain this sub-document? The most index-friendly JSONB operator.")
        run(d, conn, "SELECT name, attrs FROM products WHERE attrs ? 'wireless' ORDER BY name",
            title="? key exists", note="Rows whose document has the top-level key, whatever its value.")
        run(d, conn, """
            SELECT name, jsonb_path_query_first(attrs, '$.pages') AS pages
            FROM products WHERE attrs @@ '$.pages > 400' ORDER BY name""",
            title="SQL/JSON path: @@ and jsonb_path_query", note="JSON path expressions filter and extract inside documents, like XPath for JSON.")
        run(d, conn, """
            SELECT name,
                   attrs || '{"on_sale": true}'                 AS merged,
                   jsonb_set(attrs, '{color}', '"purple"')      AS recolored,
                   attrs - 'color'                              AS without_color
            FROM products WHERE id = 5""",
            title="Modify: ||, jsonb_set, - (removes a key)", note="These return new values; wrap them in UPDATE … SET attrs = … to save.")
        run(d, conn, """
            SELECT category, jsonb_agg(jsonb_build_object('name', name, 'price', price) ORDER BY price) AS items
            FROM products WHERE category IN ('Games', 'Garden') GROUP BY category""",
            title="Build JSON: jsonb_build_object, jsonb_agg", note="Shape API responses straight in SQL.")
        table = run(d, conn, """
            SELECT jt.* FROM JSON_TABLE(
              '{"cart": [{"sku": "KB-1", "qty": 1}, {"sku": "MS-1", "qty": 2}, {"sku": "HUB-1", "qty": 3}]}'::jsonb,
              '$.cart[*]' COLUMNS (line FOR ORDINALITY, sku text PATH '$.sku', qty int PATH '$.qty')
            ) AS jt""",
            title="JSON_TABLE (Postgres 17+): JSON → rows", note="Turns a JSON array into a relational table you can join and aggregate.")
        with conn.transaction():
            conn.execute("SET LOCAL search_path = pg_temp, shop, public")
            run(d, conn, "CREATE TEMP TABLE p AS SELECT * FROM shop.products, generate_series(1, 400)")
            run(d, conn, "CREATE INDEX ON p USING gin (attrs jsonb_path_ops)")
            run(d, conn, "ANALYZE p")
            plan = run(d, conn, "EXPLAIN (COSTS OFF) SELECT count(*) FROM p WHERE attrs @> '{\"color\": \"white\"}'",
                       title="EXPLAIN: @> uses the GIN index", note="9,600 rows copied into a temp table with a GIN (jsonb_path_ops) index: the plan uses a Bitmap Index Scan.")
            plan_text = " ".join(r["QUERY PLAN"] for r in plan)
            plan2 = run(d, conn, "EXPLAIN (COSTS OFF) SELECT count(*) FROM p WHERE attrs ->> 'color' = 'white'",
                        title="EXPLAIN: ->> = cannot use that GIN index", note="Same question, different operator: GIN indexes support @>, ?, @@, not ->> equality (that needs an expression B-tree index).")
            plan2_text = " ".join(r["QUERY PLAN"] for r in plan2)
            raise psycopg.Rollback()  # drops the temp table and its index
        if mistake:
            e = fail(d, conn, "SELECT name FROM products WHERE attrs -> 'color' = 'black'", label="mistake",
                     title="WRONG: comparing -> (jsonb) with a bare string",
                     note="'black' is read as JSON, and bare black is not valid JSON. Use ->> for text, or compare with '\"black\"'.")
            d.check("Comparing jsonb to an unquoted string fails", e and "invalid input syntax for type json" in e, e)
            d.data["mode"] = "mistake"
        d.check(f"@> found only {color} products", contains and all(r["attrs"].get("color") == color for r in contains), len(contains))
        d.check("JSON_TABLE produced one row per cart line", [r["sku"] for r in table] == ["KB-1", "MS-1", "HUB-1"])
        d.check("@> query used the GIN index, ->> = did not", "Bitmap Index Scan" in plan_text and "Index" not in plan2_text,
                plan_text[:120])
        d.data["color"] = color
    return d.result()


@router.post("/arrays-ranges")
def arrays_ranges(mistake: bool = False) -> dict:
    with Demo("arrays-ranges") as d, scratch(d, "ranges") as schema, session(schema) as conn:
        run(d, conn, """
            SELECT name, tags, cardinality(tags) AS n_tags, tags[1] AS first_tag
            FROM products WHERE 'usb' = ANY(tags) ORDER BY name""",
            title="Arrays: = ANY, subscripts, cardinality", note="Arrays are 1-based. `x = ANY(arr)` tests membership.")
        run(d, conn, """
            SELECT name, tags FROM products
            WHERE tags @> ARRAY['family'] OR tags && ARRAY['steel', 'iron'] ORDER BY name""",
            title="Arrays: @> contains, && overlaps", note="Both are GIN-indexable.")
        run(d, conn, """
            SELECT tag, count(*) AS products
            FROM products, unnest(tags) WITH ORDINALITY AS t(tag, pos)
            GROUP BY tag ORDER BY products DESC, tag LIMIT 8""",
            title="unnest: array → rows", note="Explode arrays into rows to count, join or filter them.")
        run(d, conn, "SELECT array_sort(ARRAY[3, 1, 2]) AS sorted, array_reverse(ARRAY['a', 'b', 'c']) AS reversed",
            title="array_sort, array_reverse (Postgres 18)", note="New array helpers in 18.")
        run(d, conn, """
            SELECT int4range(10, 20) @> 15 AS contains_15,
                   int4range(10, 20) @> 20 AS contains_20,
                   int4range(10, 20) && int4range(19, 30) AS overlaps,
                   int4range(10, 20) * int4range(15, 30) AS intersection,
                   range_agg(r) AS merged
            FROM (VALUES (int4range(1, 5)), (int4range(3, 8)), (int4range(10, 12))) v(r)""",
            title="Range types: @>, &&, * and range_agg", note="[10,20) includes 10 and excludes 20. range_agg merges ranges into a multirange.")
        run(d, conn, "CREATE EXTENSION IF NOT EXISTS btree_gist")
        run(d, conn, """
            CREATE TABLE bookings (
              room   text NOT NULL,
              guest  text NOT NULL,
              during tstzrange NOT NULL,
              EXCLUDE USING gist (room WITH =, during WITH &&)
            )""", title="EXCLUDE constraint: no double bookings",
            note="For any two rows: same room AND overlapping time is forbidden. A UNIQUE constraint cannot express 'no overlap'.")
        run(d, conn, """
            INSERT INTO bookings VALUES
              ('101', 'Ada',   '[2026-11-01 14:00+00, 2026-11-03 11:00+00)'),
              ('101', 'Grace', '[2026-11-03 14:00+00, 2026-11-05 11:00+00)'),
              ('102', 'Linus', '[2026-11-02 14:00+00, 2026-11-06 11:00+00)')""")
        clash = fail(d, conn, "INSERT INTO bookings VALUES ('101', 'Edsger', '[2026-11-02 14:00+00, 2026-11-04 11:00+00)')",
                     title="Overlapping booking is rejected", note="Room 101 is taken on those nights, so the database refuses, even under concurrent inserts.")
        run(d, conn, """
            CREATE TABLE prices (
              sku      text NOT NULL,
              price    numeric NOT NULL,
              valid_at daterange NOT NULL,
              PRIMARY KEY (sku, valid_at WITHOUT OVERLAPS)
            )""", title="Temporal primary key: WITHOUT OVERLAPS (Postgres 18)",
            note="New in 18: a primary key that is unique per point in time, so one price per SKU per day.")
        run(d, conn, "INSERT INTO prices VALUES ('KB-1', 129, '[2026-01-01, 2026-07-01)'), ('KB-1', 119, '[2026-07-01, 2027-01-01)')")
        temporal = fail(d, conn, "INSERT INTO prices VALUES ('KB-1', 99, '[2026-06-15, 2026-08-01)')", title="Overlapping price period is rejected")
        booked = run(d, conn, """
            SELECT room, guest, lower(during) AS check_in, upper(during) AS check_out FROM bookings ORDER BY room, during""",
            title="Bookings that made it")
        if mistake:
            run(d, conn, "CREATE TABLE naive_bookings (room text, check_in timestamptz, check_out timestamptz, UNIQUE (room, check_in))")
            run(d, conn, "INSERT INTO naive_bookings VALUES ('101', '2026-11-01 14:00+00', '2026-11-03 11:00+00')")
            run(d, conn, "INSERT INTO naive_bookings VALUES ('101', '2026-11-02 14:00+00', '2026-11-04 11:00+00')", label="mistake",
                title="WRONG: UNIQUE (room, check_in) lets overlaps through",
                note="Different start times, so UNIQUE is satisfied, but the stays overlap: the room is double-booked.")
            doubled = value(conn, """
                SELECT count(*) FROM naive_bookings a JOIN naive_bookings b
                ON a.room = b.room AND a.ctid < b.ctid AND a.check_in < b.check_out AND b.check_in < a.check_out""")
            d.check("UNIQUE allowed an overlapping double booking", doubled == 1, f"{doubled} overlapping pair(s)")
            d.data["mode"] = "mistake"
        d.check("Exclusion constraint rejected the overlapping booking", clash and "conflicting key value violates exclusion constraint" in clash, clash)
        d.check("WITHOUT OVERLAPS rejected the overlapping price period", temporal and "conflicting key value" in temporal, temporal)
        d.data["bookings"] = booked
        d.data["rejected"] = {"room": "101", "guest": "Edsger", "check_in": "2026-11-02T14:00:00+00:00", "check_out": "2026-11-04T11:00:00+00:00"}
    return d.result()


@router.post("/fulltext")
def fulltext(q: str = Query("indexes for fast queries", max_length=100), mistake: bool = False) -> dict:
    q = q.strip() or "indexes for fast queries"
    with Demo("fulltext") as d, session() as conn:
        run(d, conn, "SELECT to_tsvector('english', 'The runners were running quickly to the indexes') AS tsvector",
            title="to_tsvector: text → lexemes", note="Lower-cased, stop words dropped, words stemmed: running → run, indexes → index. Numbers are word positions.")
        run(d, conn, "SELECT websearch_to_tsquery('english', %s) AS tsquery", [q],
            title="websearch_to_tsquery: user input → query",
            note="Safely parses what people type: \"quoted phrases\", or, -minus. Never raises a syntax error.")
        hits = run(d, conn, """
            SELECT id, title,
                   round(ts_rank(search, query)::numeric, 4) AS rank,
                   ts_headline('english', body, query, 'StartSel=«, StopSel=», MaxWords=18, MinWords=8') AS headline
            FROM articles, websearch_to_tsquery('english', %s) AS query
            WHERE search @@ query
            ORDER BY rank DESC LIMIT 8""", [q],
            title="@@ match, ts_rank, ts_headline",
            note="The stored tsvector (title weighted A, body B) is matched with @@, ranked and highlighted. A GIN index makes @@ fast.")
        like_hits = run(d, conn, "SELECT count(*) AS n FROM articles WHERE body ILIKE %s", [f"%{q.split()[0]}%"] if q.split() else ["%%"],
                        title="Compare: ILIKE on the first word", note="Plain pattern matching: no stemming, no ranking, and no index for a leading %.")
        run(d, conn, """
            SELECT title FROM articles
            WHERE search @@ to_tsquery('english', 'streaming <-> replication | (vacuum & !elasticsearch)')
               OR search @@ phraseto_tsquery('english', 'connection pooling')""",
            title="to_tsquery operators & phrases", note="& and, | or, ! not, <-> followed by. phraseto_tsquery builds the phrase for you.")
        stem = value(conn, "SELECT count(*) FROM articles WHERE search @@ to_tsquery('english', 'running')")
        if mistake:
            e = fail(d, conn, "SELECT title FROM articles WHERE search @@ to_tsquery('english', 'fast queries')", label="mistake",
                     title="WRONG: raw user text into to_tsquery",
                     note="to_tsquery expects operator syntax; two plain words without & is a syntax error. Use websearch_to_tsquery or plainto_tsquery for user input.")
            d.check("to_tsquery rejects plain multi-word input", e and "syntax error in tsquery" in e, e)
            d.data["mode"] = "mistake"
        d.check("Search returned ranked hits, best first", all(hits[i]["rank"] >= hits[i + 1]["rank"] for i in range(len(hits) - 1)),
                f"{len(hits)} hits for “{q}”")
        d.check("Stemming: 'running' matches articles that say 'run' or 'runs'", stem >= 1, f"{stem} article(s)")
        d.data.update({"q": q, "hits": hits, "likeCount": like_hits[0]["n"]})
    return d.result()
