"""Postgres Visual Lab API. One endpoint per feature under /api/demos/*, each returning a DemoResult."""

from __future__ import annotations

import contextlib
import logging
import time

import psycopg
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import seed as seeding
from .db import pool, sweep_old_scratch
from .lab import error_text
from .demos import concurrency, features, mistakes, operations, performance, queries, schema, security, types

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("lab")

ROUTERS = [queries.router, types.router, schema.router, performance.router, concurrency.router, security.router, features.router, operations.router, mistakes.router]


def wait_for_database(seconds: int = 90) -> None:
    deadline = time.monotonic() + seconds
    while True:
        try:
            with psycopg.connect("", connect_timeout=3) as conn:
                conn.execute("SELECT 1")
            return
        except psycopg.OperationalError as exc:
            if time.monotonic() > deadline:
                raise
            log.info("waiting for Postgres: %s", str(exc).strip().splitlines()[0])
            time.sleep(2)


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    wait_for_database()
    pool.open(wait=True, timeout=30)
    log.info("seed: %s", seeding.seed())
    log.info("swept %s leftover scratch schemas", sweep_old_scratch())
    yield
    pool.close()


app = FastAPI(title="Postgres Visual Lab", docs_url="/api/docs", openapi_url="/api/openapi.json", lifespan=lifespan)
for router in ROUTERS:
    app.include_router(router)


@app.exception_handler(psycopg.Error)
async def database_error(_: Request, exc: psycopg.Error) -> JSONResponse:
    # An unexpected database error in a demo: report it in the DemoResult error shape
    return JSONResponse(status_code=500, content={"error": error_text(exc)})


@app.get("/api/health")
def health() -> dict[str, str]:
    with pool.connection() as conn:
        version = conn.execute("SHOW server_version").fetchone()["server_version"]
    return {"status": "ok", "postgres": version}
