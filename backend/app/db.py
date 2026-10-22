"""Connections to the lab's PostgreSQL server and helpers that record every statement a demo runs.

Connection settings come from the standard libpq environment variables (PGHOST, PGUSER,
PGPASSWORD, PGDATABASE), so the empty conninfo string below picks them up.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import decimal
import os
import re
import secrets
import textwrap
import threading
import time
import uuid
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row, tuple_row
from psycopg_pool import ConnectionPool

from .lab import Demo, error_text

# Every lab session gets guard rails: a visitor can never hold a statement, lock wait or
# open transaction for long. Demos that need other values SET them locally.
SESSION_OPTIONS = (
    "-c statement_timeout=20000 -c lock_timeout=10000 "
    "-c idle_in_transaction_session_timeout=60000 -c application_name=postgres-lab"
)
CONNECT_KWARGS = {
    "autocommit": True,
    "row_factory": dict_row,
    "options": SESSION_OPTIONS,
    "prepare_threshold": None,  # no server-side prepared statements, so DISCARD ALL is safe
    "connect_timeout": 5,
}


def _reset(conn: psycopg.Connection) -> None:
    # Undo anything a demo left behind (SET ROLE, search_path, LISTEN, advisory locks)
    conn.execute("DISCARD ALL")


pool = ConnectionPool(
    "", kwargs=CONNECT_KWARGS, min_size=2, max_size=40, timeout=15, reset=_reset, open=False, name="lab"
)

# Demos that hold several connections at once take a slot here, so a burst of visitors
# cannot drain the pool.
heavy = threading.BoundedSemaphore(3)


def connect(**overrides: Any) -> psycopg.Connection:
    """A brand-new connection outside the pool (pooling demo, replica, isolated sessions)."""
    return psycopg.connect("", **{**CONNECT_KWARGS, **overrides})


def replica_host() -> str:
    return os.environ.get("REPLICA_HOST", "replica")


# ---- JSON-safe values --------------------------------------------------------------

def jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return str(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (bytes, memoryview)):
        return "\\x" + bytes(value).hex()
    return str(value)


def one_line(sql: str, limit: int = 600) -> str:
    text = re.sub(r"\s+", " ", sql).strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _clean(sql: str) -> str:
    return textwrap.dedent(sql).strip("\n").rstrip()


def display_sql(sql: str, params: Any) -> str:
    """The SQL as Postgres receives it: psycopg sends %s placeholders as $1, $2, … and %% as %."""
    if not params:
        return sql
    counter = iter(range(1, 1000))
    return re.sub(r"%%|%s", lambda m: "%" if m.group() == "%%" else f"${next(counter)}", sql)


# ---- Running and recording statements ------------------------------------------------

def run(
    d: Demo,
    conn: psycopg.Connection,
    sql: str,
    params: Any = None,
    *,
    title: str | None = None,
    note: str | None = None,
    keep: int = 60,
    label: str | None = None,
) -> list[dict[str, Any]]:
    """Executes one statement, records it in the demo's commands and, when `title` is given,
    adds it to `data.queries` with its columns and rows so the UI can show the SQL next to
    its result. Returns the rows as dicts."""
    sql = _clean(sql)
    started = time.perf_counter()
    cur = conn.cursor(row_factory=tuple_row)
    cur.execute(sql, params)
    rows = cur.fetchall() if cur.description else []
    ms = round((time.perf_counter() - started) * 1000, 2)
    columns = [c.name for c in cur.description] if cur.description else []
    count = len(rows) if cur.description else cur.rowcount
    status = cur.statusmessage or ""
    prefix = f"[{label}] " if label else ""
    shown_params = f"  -- params {jsonable(params)}" if params else ""
    shown_sql = display_sql(sql, params)
    d.command(f"{prefix}{one_line(shown_sql)}{shown_params}  -- {status or count} ({ms:.1f} ms)")
    if title:
        d.data.setdefault("queries", []).append({
            "title": title,
            "sql": shown_sql,
            "params": jsonable(params) if params else None,
            "note": note,
            "columns": columns,
            "rows": [[jsonable(v) for v in row] for row in rows[:keep]],
            "rowCount": count,
            "truncated": len(rows) > keep,
            "status": status,
            "ms": ms,
        })
    return [dict(zip(columns, row)) for row in rows]


def fail(
    d: Demo,
    conn: psycopg.Connection,
    sql: str,
    params: Any = None,
    *,
    title: str | None = None,
    note: str | None = None,
    label: str | None = None,
) -> str | None:
    """Runs a statement that is expected to fail and records the genuine error. Returns the
    error text (psql style) or None when it unexpectedly succeeded."""
    sql = _clean(sql)
    prefix = f"[{label}] " if label else ""
    started = time.perf_counter()
    error: str | None = None
    sqlstate: str | None = None
    try:
        conn.execute(sql, params)
    except psycopg.Error as exc:
        error, sqlstate = error_text(exc), exc.sqlstate
    ms = round((time.perf_counter() - started) * 1000, 2)
    d.command(f"{prefix}{one_line(display_sql(sql, params))}  -- {('-> ' + error.splitlines()[0]) if error else 'succeeded'} ({ms:.1f} ms)")
    if title:
        d.data.setdefault("queries", []).append({
            "title": title, "sql": display_sql(sql, params), "params": jsonable(params) if params else None, "note": note,
            "columns": [], "rows": [], "rowCount": 0, "error": error, "sqlstate": sqlstate, "ms": ms,
        })
    return error


def value(conn: psycopg.Connection, sql: str, params: Any = None) -> Any:
    """First column of the first row, without recording anything (used for measurements)."""
    row = conn.execute(_clean(sql), params).fetchone()
    return None if row is None else next(iter(row.values()))


# ---- Isolation between visitors -------------------------------------------------------

@contextlib.contextmanager
def scratch(d: Demo, tag: str) -> Iterator[str]:
    """A private schema for one demo run, dropped afterwards. Demos that change data work on
    copies in here, so concurrent visitors never see each other's changes and the shared
    `shop` sample data stays pristine."""
    schema = f"run_{tag.replace('-', '_')}_{secrets.token_hex(4)}"
    with pool.connection() as conn:
        conn.execute(f"CREATE SCHEMA {schema}")
    d.command(f"CREATE SCHEMA {schema}  -- private scratch schema for this run")
    try:
        yield schema
    finally:
        with pool.connection() as conn:
            conn.execute("SET lock_timeout = '30s'")
            conn.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
        d.command(f"DROP SCHEMA {schema} CASCADE  -- clean up")


@contextlib.contextmanager
def session(schema: str | None = None) -> Iterator[psycopg.Connection]:
    """A pooled connection whose search_path starts with the scratch schema."""
    with pool.connection() as conn:
        if schema:
            conn.execute(f"SET search_path = {schema}, shop, public")
        else:
            conn.execute("SET search_path = shop, public")
        yield conn


def sweep_old_scratch() -> int:
    """Drops scratch schemas a crashed run left behind. Runs only at startup, before any visitor."""
    with pool.connection() as conn:
        names = [r["nspname"] for r in conn.execute("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'run\\_%'")]
        for name in names:
            conn.execute(f"DROP SCHEMA IF EXISTS {name} CASCADE")
        return len(names)
