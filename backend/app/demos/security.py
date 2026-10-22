"""Security: roles and privileges, row-level security for multi-tenant tables, and SQL
injection versus bound parameters."""

from __future__ import annotations

from fastapi import APIRouter
from psycopg import sql as pgsql

from ..db import fail, run, scratch, session, value
from ..lab import Demo, pick

router = APIRouter(prefix="/api/demos")


@router.post("/roles")
def roles() -> dict:
    with Demo("roles") as d, scratch(d, "roles") as schema, session(schema) as conn:
        run(d, conn, "CREATE TABLE salaries (name text, team text, amount numeric)")
        run(d, conn, "INSERT INTO salaries VALUES ('Ada', 'eng', 120000), ('Grace', 'eng', 125000), ('Linus', 'ops', 99000)")
        matrix = []

        def attempt(role: str, action: str, statement: str) -> None:
            run(d, conn, f"SET ROLE {role}", label=role)
            error = fail(d, conn, statement, label=role)
            conn.execute("RESET ROLE")
            matrix.append({"role": role, "action": action, "sql": statement, "allowed": error is None, "error": error})

        attempt("lab_reader", "SELECT before any grant", "SELECT name FROM salaries")
        attempt("lab_reader", "SELECT schema.table before any grant", f"SELECT name FROM {schema}.salaries")
        run(d, conn, f"GRANT USAGE ON SCHEMA {schema} TO lab_reader, lab_writer",
            title="GRANT USAGE ON SCHEMA", note="Step 1: a role must be allowed into the schema at all…")
        attempt("lab_reader", "SELECT with schema USAGE only", "SELECT name FROM salaries")
        run(d, conn, "GRANT SELECT (name, team) ON salaries TO lab_reader",
            title="GRANT SELECT (columns) ON table", note="…step 2: and to read the table. Column-level grants hide the amount column.")
        run(d, conn, "GRANT SELECT, INSERT, UPDATE ON salaries TO lab_writer", title="GRANT SELECT, INSERT, UPDATE")
        attempt("lab_reader", "SELECT name, team", "SELECT name, team FROM salaries")
        attempt("lab_reader", "SELECT amount (not granted)", "SELECT amount FROM salaries")
        attempt("lab_reader", "INSERT", "INSERT INTO salaries VALUES ('Eve', 'eng', 1)")
        attempt("lab_writer", "SELECT *", "SELECT * FROM salaries")
        attempt("lab_writer", "INSERT", "INSERT INTO salaries VALUES ('Eve', 'eng', 1)")
        attempt("lab_writer", "DELETE (not granted)", "DELETE FROM salaries WHERE name = 'Eve'")
        attempt("lab_writer", "DROP TABLE (only the owner may)", "DROP TABLE salaries")
        run(d, conn, f"REVOKE ALL ON salaries FROM lab_reader, lab_writer; REVOKE USAGE ON SCHEMA {schema} FROM lab_reader, lab_writer",
            title="REVOKE (clean up)")
        privs = run(d, conn, "SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name = 'salaries' AND grantee LIKE 'lab\\_%%'",
                    title="information_schema.role_table_grants after REVOKE")
        get = {(m["role"], m["action"]): m for m in matrix}
        d.check("No schema USAGE: the unqualified name is not even found", "does not exist" in (get[("lab_reader", "SELECT before any grant")]["error"] or ""),
                get[("lab_reader", "SELECT before any grant")]["error"])
        d.check("No schema USAGE: the qualified name says permission denied for schema",
                "permission denied for schema" in (get[("lab_reader", "SELECT schema.table before any grant")]["error"] or ""),
                get[("lab_reader", "SELECT schema.table before any grant")]["error"])
        d.check("Schema USAGE alone is not enough to read the table", "permission denied for table" in (get[("lab_reader", "SELECT with schema USAGE only")]["error"] or ""))
        d.check("Column grant: name/team readable, amount denied",
                get[("lab_reader", "SELECT name, team")]["allowed"] and not get[("lab_reader", "SELECT amount (not granted)")]["allowed"])
        d.check("Writer can INSERT but not DELETE or DROP", get[("lab_writer", "INSERT")]["allowed"]
                and not get[("lab_writer", "DELETE (not granted)")]["allowed"] and "must be owner" in (get[("lab_writer", "DROP TABLE (only the owner may)")]["error"] or ""))
        d.check("REVOKE removed every grant", privs == [])
        d.data["matrix"] = matrix
    return d.result()


@router.post("/rls")
def rls(tenant: int = 1, mistake: bool = False) -> dict:
    tenant = int(pick(str(tenant), ["1", "2", "3"], "1"))
    with Demo("rls") as d, scratch(d, "rls") as schema, session(schema) as conn:
        run(d, conn, """
            CREATE TABLE invoices (id int PRIMARY KEY, tenant_id int NOT NULL, customer text, amount numeric);
            INSERT INTO invoices VALUES
              (1, 1, 'Acme', 120), (2, 1, 'Acme', 80), (3, 2, 'Globex', 300),
              (4, 2, 'Globex', 45), (5, 3, 'Initech', 999), (6, 3, 'Initech', 10), (7, 1, 'Acme', 60)""")
        run(d, conn, "ALTER TABLE invoices ENABLE ROW LEVEL SECURITY", title="ENABLE ROW LEVEL SECURITY",
            note="With RLS on and no policy, ordinary roles see zero rows (default deny).")
        run(d, conn, """
            CREATE POLICY tenant_isolation ON invoices
              USING (tenant_id = current_setting('app.tenant_id')::int)
              WITH CHECK (tenant_id = current_setting('app.tenant_id')::int)""",
            title="CREATE POLICY … USING … WITH CHECK",
            note="USING filters rows you can see/update/delete; WITH CHECK validates rows you write. The app sets app.tenant_id per request.")
        run(d, conn, f"GRANT USAGE ON SCHEMA {schema} TO lab_app; GRANT SELECT, INSERT, UPDATE, DELETE ON invoices TO lab_app")
        run(d, conn, "SET ROLE lab_app", title="Act as the application role (not the owner)")
        run(d, conn, "SELECT set_config('app.tenant_id', %s, false)", [str(tenant)])
        visible = run(d, conn, "SELECT id, tenant_id, customer, amount FROM invoices ORDER BY id",
                      title=f"SELECT * as tenant {tenant}: no WHERE clause, still filtered")
        updated = run(d, conn, "UPDATE invoices SET amount = amount + 1 RETURNING id", title="UPDATE without WHERE touches only own rows")
        other = 2 if tenant == 1 else 1
        blocked = fail(d, conn, "INSERT INTO invoices VALUES (100, %s, 'Sneaky', 1)", [other],
                       title=f"Insert a row for tenant {other}", note="WITH CHECK rejects writing into another tenant.")
        run(d, conn, "RESET ROLE")
        all_rows = run(d, conn, "SELECT id, tenant_id, customer, amount FROM invoices ORDER BY id")
        if mistake:
            run(d, conn, "ALTER TABLE invoices OWNER TO lab_writer")
            run(d, conn, f"GRANT USAGE ON SCHEMA {schema} TO lab_writer")
            run(d, conn, "SET ROLE lab_writer", label="mistake")
            run(d, conn, "SELECT set_config('app.tenant_id', %s, false)", [str(tenant)], label="mistake")
            owner_sees = run(d, conn, "SELECT count(*) AS n FROM invoices", label="mistake",
                             title="WRONG: the app connects as the table owner",
                             note="Owners (and superusers, and BYPASSRLS roles) skip RLS policies, so every tenant's rows leak.")
            conn.execute("RESET ROLE")
            run(d, conn, "ALTER TABLE invoices FORCE ROW LEVEL SECURITY", title="RIGHT: FORCE ROW LEVEL SECURITY (or a separate app role)")
            run(d, conn, "SET ROLE lab_writer")
            forced = run(d, conn, "SELECT count(*) AS n FROM invoices", title="The owner is now filtered too")
            conn.execute("RESET ROLE")
            run(d, conn, f"REVOKE USAGE ON SCHEMA {schema} FROM lab_writer")
            d.check("The table owner bypassed RLS and saw all 7 rows", owner_sees[0]["n"] == 7, owner_sees)
            d.check("FORCE ROW LEVEL SECURITY filtered the owner", forced[0]["n"] == len(visible), forced)
            d.data["mode"] = "mistake"
        run(d, conn, f"REVOKE ALL ON invoices FROM lab_app; REVOKE USAGE ON SCHEMA {schema} FROM lab_app")
        d.check(f"Tenant {tenant} saw only its own rows", visible and all(r["tenant_id"] == tenant for r in visible), f"{len(visible)} of 7 rows")
        d.check("UPDATE without WHERE changed only the tenant's rows", len(updated) == len(visible))
        d.check("WITH CHECK blocked writing another tenant's row", blocked and "violates row-level security policy" in blocked, blocked)
        d.data.update({"tenant": tenant, "visible": [r["id"] for r in visible], "rows": all_rows})
    return d.result()


@router.post("/sql-injection")
def sql_injection(payload: str = "' OR '1'='1") -> dict:
    # Only prepared payloads ever reach the unsafe path: the lab never runs visitor-written SQL
    payloads = {
        "' OR '1'='1": "Classic: turns the WHERE into always-true",
        "x' UNION SELECT username, password_hash FROM users --": "UNION: reads another table's columns",
        "alice": "A normal value",
    }
    payload = pick(payload, payloads, "' OR '1'='1")
    with Demo("sql-injection") as d, scratch(d, "sqli") as schema, session(schema) as conn:
        run(d, conn, """
            CREATE TABLE users (username text PRIMARY KEY, password_hash text, is_admin boolean DEFAULT false);
            CREATE TABLE notes (owner text, body text);
            INSERT INTO users VALUES ('alice', 'scrypt$…a1', false), ('bob', 'scrypt$…b2', false), ('root', 'scrypt$…r0', true);
            INSERT INTO notes VALUES ('alice', 'buy milk'), ('bob', 'call mum'), ('root', 'backup keys are in vault 7')""")
        unsafe_sql = "SELECT owner, body FROM notes WHERE owner = '" + payload + "'"
        unsafe = run(d, conn, unsafe_sql, label="UNSAFE", title="UNSAFE: string concatenation",
                     note=f"The input is glued into the SQL text, so its quotes become SQL syntax. Payload: {payloads[payload]}.")
        safe = run(d, conn, "SELECT owner, body FROM notes WHERE owner = %s", [payload], label="SAFE",
                   title="SAFE: bound parameter ($1)", note="The SQL text and the value travel separately; the value can never become SQL. psycopg sends it as $1.")
        table = "notes"
        ident = pgsql.SQL("SELECT count(*) AS n FROM {}").format(pgsql.Identifier(table))
        safe_ident = run(d, conn, ident.as_string(conn), title="Dynamic identifiers: psycopg.sql.Identifier",
                         note="Table and column names cannot be parameters. Quote them with sql.Identifier (format('%I') in SQL), or pick from an allow-list.")
        leaked = len(unsafe) > 1
        if payload == "alice":
            d.check("A normal value gives the same result both ways", unsafe == safe and len(safe) == 1)
        else:
            d.check("Concatenation let the payload rewrite the query", leaked, f"{len(unsafe)} rows returned")
            d.check("The bound parameter treated the payload as plain text (no rows)", safe == [], payload)
        d.check("sql.Identifier quoted the table name safely", safe_ident[0]["n"] == 3)
        d.data.update({"payload": payload, "unsafeSql": unsafe_sql, "unsafe": unsafe, "safe": safe, "payloads": payloads})
    return d.result()
