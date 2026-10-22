"""Built-in features and extensions: LISTEN/NOTIFY pub/sub, COPY bulk loading, fuzzy search
with pg_trgm, and vector similarity search with pgvector."""

from __future__ import annotations

import io
import json
import secrets
import time

from fastapi import APIRouter, Query

from ..db import connect, fail, heavy, run, scratch, session, value
from ..lab import Demo, clamp, pick

router = APIRouter(prefix="/api/demos")


@router.post("/listen-notify")
def listen_notify(mistake: bool = False) -> dict:
    channel = f"lab_{secrets.token_hex(4)}"
    with heavy, Demo("listen-notify") as d, scratch(d, "notify") as schema, session(schema) as sender, \
            connect() as listener:
        t0 = time.perf_counter()
        ms = lambda: round((time.perf_counter() - t0) * 1000, 1)
        received: list[dict] = []
        timeline: list[dict] = []

        def drain(timeout: float, stop_after: int | None = None) -> list:
            got = list(listener.notifies(timeout=timeout, stop_after=stop_after))
            for n in got:
                received.append({"at": ms(), "channel": n.channel, "payload": n.payload, "pid": n.pid})
                timeline.append({"at": ms(), "who": "listener", "what": f"received: {n.payload}"})
            return got

        def say(who: str, conn, sql: str, params=None) -> None:
            run(d, conn, sql, params, label=who)
            timeline.append({"at": ms(), "who": who, "what": " ".join(sql.split()) if not params else f"{' '.join(sql.split())}  {params}"})

        say("listener", listener, f"LISTEN {channel}")
        say("sender", sender, "BEGIN")
        say("sender", sender, f"NOTIFY {channel}, 'order 1 paid'")
        before_commit = drain(0.3)
        timeline.append({"at": ms(), "who": "listener", "what": f"waited 300 ms: {len(before_commit)} notifications (not committed yet)"})
        say("sender", sender, "COMMIT")
        commit_at = ms()
        after_commit = drain(2.0, stop_after=1)
        latency = round(received[-1]["at"] - commit_at, 1) if after_commit else None
        say("sender", sender, "BEGIN")
        say("sender", sender, f"NOTIFY {channel}, 'cache:products'")
        say("sender", sender, f"NOTIFY {channel}, 'cache:products'")
        say("sender", sender, "COMMIT")
        deduped = drain(0.5)
        run(d, sender, "CREATE TABLE orders (id int PRIMARY KEY, total numeric)")
        run(d, sender, f"""
            CREATE FUNCTION notify_order() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              PERFORM pg_notify('{channel}', json_build_object('op', TG_OP, 'id', NEW.id, 'total', NEW.total)::text);
              RETURN NEW;
            END $$;
            CREATE TRIGGER orders_notify AFTER INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION notify_order()""",
            title="A trigger that publishes every change with pg_notify",
            note="pg_notify(channel, payload) is the function form of NOTIFY, so the channel and payload can be computed.")
        say("sender", sender, "INSERT INTO orders VALUES (1, 19.90), (2, 5.00), (3, 42.00)")
        say("sender", sender, "UPDATE orders SET total = total * 2 WHERE id = 2")
        from_trigger = drain(2.0, stop_after=4)
        if mistake:
            e = fail(d, sender, "SELECT pg_notify(%s, repeat('x', 9000))", [channel], label="mistake",
                     title="WRONG: a big payload in NOTIFY", note="Payloads must be shorter than 8000 bytes. Send an id and let the listener SELECT the data.")
            d.check("A 9000-byte payload is rejected", e and "payload string too long" in e, e)
            d.data["mode"] = "mistake"
        run(d, listener, f"UNLISTEN {channel}")
        d.check("Nothing was delivered before COMMIT", before_commit == [])
        d.check("The notification arrived right after COMMIT", len(after_commit) == 1 and after_commit[0].payload == "order 1 paid",
                f"{latency} ms after COMMIT")
        d.check("Two identical notifications in one transaction were delivered once", len(deduped) == 1, len(deduped))
        payloads = [json.loads(n.payload) for n in from_trigger]
        d.check("The trigger published one JSON message per row change", [p["op"] for p in payloads] == ["INSERT"] * 3 + ["UPDATE"], payloads)
        d.data.update({"channel": channel, "received": received, "timeline": timeline, "latencyMs": latency})
    return d.result()


@router.post("/copy")
def copy_demo(rows: int = 20_000, mistake: bool = False) -> dict:
    rows = clamp(rows, 1_000, 100_000)
    with heavy, Demo("copy") as d, scratch(d, "copy") as schema, session(schema) as conn:
        run(d, conn, "CREATE TABLE readings (id int, sensor text, value numeric, at timestamptz)")
        data = [(i, f"s{i % 50}", round(i * 0.37 % 100, 2), f"2026-10-01T00:00:00+00:00") for i in range(rows)]
        results = []

        def timed(name: str, n: int, fn, note: str) -> None:
            conn.execute("TRUNCATE readings")
            started = time.perf_counter()
            fn(n)
            secs = time.perf_counter() - started
            loaded = value(conn, "SELECT count(*) FROM readings")
            results.append({"method": name, "rows": n, "ms": round(secs * 1000, 1), "rowsPerSec": round(n / secs), "loaded": loaded, "note": note})
            d.command(f"-- {name}: {n:,} rows in {secs * 1000:.0f} ms → {n / secs:,.0f} rows/s")

        insert = "INSERT INTO readings VALUES (%s, %s, %s, %s)"

        def autocommit_each(n: int) -> None:
            for r in data[:n]:
                conn.execute(insert, r)

        def one_tx(n: int) -> None:
            with conn.transaction():
                for r in data[:n]:
                    conn.execute(insert, r)

        def executemany(n: int) -> None:
            with conn.transaction(), conn.cursor() as cur:
                cur.executemany(insert, data[:n])

        def unnest(n: int) -> None:
            cols = list(zip(*data[:n]))
            conn.execute("INSERT INTO readings SELECT * FROM unnest(%s::int[], %s::text[], %s::numeric[], %s::timestamptz[])",
                         [list(cols[0]), list(cols[1]), list(cols[2]), list(cols[3])])

        def copy(n: int) -> None:
            with conn.cursor() as cur, cur.copy("COPY readings (id, sensor, value, at) FROM STDIN") as cp:
                for r in data[:n]:
                    cp.write_row(r)

        timed("INSERT per row, autocommit", min(rows, 60), autocommit_each, "Every row is its own transaction: one round trip and one disk flush (fsync) each.")
        timed("INSERT per row, one transaction", min(rows, 3000), one_tx, "One commit at the end, but still one network round trip per row.")
        timed("executemany (pipelined)", rows, executemany, "psycopg 3 pipelines the statements: fewer round-trip waits.")
        timed("INSERT … SELECT unnest(arrays)", rows, unnest, "One statement, the whole batch passed as arrays.")
        timed("COPY FROM STDIN", rows, copy, "The bulk-load protocol: rows stream in one go with minimal per-row overhead.")
        out = io.StringIO()
        with conn.cursor() as cur, cur.copy("COPY (SELECT * FROM readings ORDER BY id LIMIT 5) TO STDOUT WITH (FORMAT csv, HEADER)") as cp:
            for chunk in cp:
                out.write(bytes(chunk).decode())
        d.command("COPY (SELECT * FROM readings ORDER BY id LIMIT 5) TO STDOUT WITH (FORMAT csv, HEADER)")
        if mistake:
            e = fail(d, conn, "COPY readings FROM '/tmp/readings.csv' WITH (FORMAT csv)", label="mistake",
                     title="WRONG: COPY FROM a file on your machine",
                     note="COPY … FROM 'path' reads a file on the database server, as the server's OS user. From a client use COPY … FROM STDIN (psql: \\copy).")
            d.check("Server-side COPY can't see the client's file", e and "could not open file" in e, e)
            d.data["mode"] = "mistake"
        best = max(results, key=lambda r: r["rowsPerSec"])
        d.check("Every method loaded all its rows", all(r["loaded"] == r["rows"] for r in results))
        d.check("COPY beat row-by-row autocommit INSERTs by 10× or more", results[-1]["rowsPerSec"] > 10 * results[0]["rowsPerSec"],
                f"{results[-1]['rowsPerSec']:,} vs {results[0]['rowsPerSec']:,} rows/s")
        d.check("COPY TO STDOUT exported CSV with a header", out.getvalue().startswith("id,sensor,value,at"), out.getvalue().splitlines()[0])
        d.data.update({"rows": rows, "results": results, "csv": out.getvalue(), "fastest": best["method"]})
    return d.result()


@router.post("/trigram")
def trigram(q: str = Query("mecanical keybord", max_length=60), mistake: bool = False) -> dict:
    q = q.strip()[:60] or "mecanical keybord"
    with heavy, Demo("trigram") as d, scratch(d, "trgm") as schema, session(schema) as conn:
        run(d, conn, "SELECT show_trgm('keyboard') AS trigrams", title="show_trgm: a word as 3-letter pieces",
            note="Similarity is the share of trigrams two strings have in common. Typos only break a few of them.")
        hits = run(d, conn, """
            SELECT name, round(similarity(name, %s)::numeric, 3) AS similarity,
                   round(word_similarity(%s, name)::numeric, 3) AS word_similarity
            FROM shop.products
            ORDER BY word_similarity(%s, name) DESC, similarity(name, %s) DESC LIMIT 6""", [q, q, q, q],
            title="Ranked by similarity: typo-tolerant search",
            note="similarity compares whole strings; word_similarity finds the best-matching part of the longer one.")
        run(d, conn, "SELECT name FROM shop.products WHERE name %% %s", [q], title="The % operator (similarity above pg_trgm.similarity_threshold, 0.3)")
        exact = run(d, conn, "SELECT count(*) AS n FROM shop.products WHERE name ILIKE %s", [f"%{q}%"],
                    title="Compare: ILIKE finds nothing for a typo")
        run(d, conn, "CREATE TABLE codes AS SELECT g AS id, md5(g::text) || '-' || (ARRAY['alpha','beta','gamma'])[1 + g % 3] AS code FROM generate_series(1, 50000) g")
        run(d, conn, "ANALYZE codes")
        needle = "%c4ca42%"
        before = value(conn, "SELECT count(*) FROM codes WHERE code LIKE %s", [needle])
        t = time.perf_counter()
        for _ in range(3):
            conn.execute("SELECT count(*) FROM codes WHERE code LIKE %s", [needle])
        before_ms = (time.perf_counter() - t) * 1000 / 3
        d.command(f"SELECT count(*) FROM codes WHERE code LIKE '{needle}'  -- no index: {before_ms:.1f} ms")
        run(d, conn, "CREATE INDEX codes_trgm ON codes USING gin (code gin_trgm_ops)", title="CREATE INDEX … USING gin (code gin_trgm_ops)",
            note="A trigram GIN index makes LIKE/ILIKE '%anywhere%' and regex searches indexable, which a B-tree can't do.")
        plan = run(d, conn, "EXPLAIN (COSTS OFF) SELECT count(*) FROM codes WHERE code LIKE %s", [needle], title="The plan now uses the trigram index")
        t = time.perf_counter()
        for _ in range(3):
            conn.execute("SELECT count(*) FROM codes WHERE code LIKE %s", [needle])
        after_ms = (time.perf_counter() - t) * 1000 / 3
        d.command(f"SELECT count(*) FROM codes WHERE code LIKE '{needle}'  -- with trigram index: {after_ms:.1f} ms")
        if mistake:
            run(d, conn, "CREATE INDEX codes_btree ON codes (code)")
            run(d, conn, "DROP INDEX codes_trgm")
            p2 = run(d, conn, "EXPLAIN (COSTS OFF) SELECT count(*) FROM codes WHERE code LIKE %s", [needle], label="mistake",
                     title="WRONG: a B-tree index for LIKE '%…%'", note="A B-tree is sorted from the first character, so a leading wildcard can't use it: Seq Scan.")
            p2_text = " ".join(r["QUERY PLAN"] for r in p2)
            d.check("The B-tree can't serve a leading-wildcard LIKE", "Seq Scan" in p2_text, p2_text)
            d.data["mode"] = "mistake"
        plan_text = " ".join(r["QUERY PLAN"] for r in plan)
        d.check("The best match survives the typos", hits and float(hits[0]["word_similarity"]) > 0.3, hits[0] if hits else None)
        d.check("The trigram index is used for LIKE '%…%'", "codes_trgm" in plan_text, plan_text[:100])
        d.check("…and is faster than scanning", after_ms < before_ms, f"{before_ms:.1f} ms → {after_ms:.1f} ms")
        d.data.update({"q": q, "hits": hits, "ilike": exact[0]["n"], "beforeMs": round(before_ms, 2), "afterMs": round(after_ms, 2), "matches": before})
    return d.result()


@router.post("/vector")
def vector(sweet: float = 0.8, savory: float = 0.2, crunchy: float = 0.8, k: int = 4,
           metric: str = "l2", mistake: bool = False) -> dict:
    sweet, savory, crunchy = (max(0.0, min(1.0, float(v))) for v in (sweet, savory, crunchy))
    k = clamp(k, 1, 8)
    metric = pick(metric, ["l2", "cosine"], "l2")
    op = {"l2": "<->", "cosine": "<=>"}[metric]
    query = f"[{sweet:.2f},{savory:.2f},{crunchy:.2f}]"
    with heavy, Demo("vector") as d, scratch(d, "vector") as schema, session(schema) as conn:
        foods = run(d, conn, "SELECT id, name, embedding::text AS embedding FROM shop.foods ORDER BY id")
        nearest = run(d, conn, f"""
            SELECT name, embedding::text AS embedding, round((embedding {op} %s::vector)::numeric, 4) AS distance
            FROM shop.foods
            ORDER BY embedding {op} %s::vector
            LIMIT %s""", [query, query, k],
            title=f"Nearest neighbours with {op} ({'Euclidean' if metric == 'l2' else 'cosine'} distance)",
            note="Each food is a 3-number embedding [sweet, savory, crunchy]. ORDER BY distance LIMIT k returns the k most similar. Real embeddings have 384–3072 dimensions.")
        run(d, conn, "CREATE TABLE items AS SELECT g AS id, ('[' || random() || ',' || random() || ',' || random() || ']')::vector(3) AS embedding FROM generate_series(1, 10000) g")
        run(d, conn, f"CREATE INDEX ON items USING hnsw (embedding {'vector_l2_ops' if metric == 'l2' else 'vector_cosine_ops'})",
            title="CREATE INDEX … USING hnsw", note="HNSW is an approximate nearest-neighbour graph index: very fast, with a small chance of missing a true neighbour (tune hnsw.ef_search).")
        run(d, conn, "ANALYZE items")
        plan = run(d, conn, f"EXPLAIN (COSTS OFF) SELECT id FROM items ORDER BY embedding {op} %s::vector LIMIT 5", [query],
                   title="10,000 vectors: the plan walks the HNSW index")
        plan_text = " ".join(r["QUERY PLAN"] for r in plan)
        if mistake:
            e = fail(d, conn, "SELECT name FROM shop.foods ORDER BY embedding <-> '[0.5, 0.5]' LIMIT 3", label="mistake",
                     title="WRONG: a query vector with the wrong number of dimensions",
                     note="The query must be embedded with the same model (same dimensions) as the stored vectors.")
            d.check("Mismatched dimensions are rejected", e and "different vector dimensions" in e, e)
            d.data["mode"] = "mistake"
        d.check(f"Returned the {k} nearest foods in distance order",
                len(nearest) == k and all(nearest[i]["distance"] <= nearest[i + 1]["distance"] for i in range(k - 1)),
                ", ".join(r["name"] for r in nearest))
        d.check("The HNSW index serves ORDER BY distance", "hnsw" in plan_text.lower() or "items_embedding_idx" in plan_text, plan_text[:100])
        d.data.update({"query": [sweet, savory, crunchy], "metric": metric, "k": k,
                       "foods": [{"name": f["name"], "v": json.loads(f["embedding"])} for f in foods],
                       "nearest": [{"name": r["name"], "v": json.loads(r["embedding"]), "distance": float(r["distance"])} for r in nearest]})
    return d.result()
