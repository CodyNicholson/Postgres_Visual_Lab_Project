"""Calls every demo endpoint against a real Postgres. Without one (the image build's test
stage) the database tests are skipped and only the pure helpers run.

Full run against the isolated stack:
  docker build --target test -t postgres-lab-backend-test backend
  docker run --rm --network postgres-visual-lab-project-test_default \
    -e PGHOST=db -e PGUSER=lab -e PGDATABASE=lab -e PGPASSWORD=... postgres-lab-backend-test python -m pytest -q
"""

import os

import psycopg
import pytest

from app.lab import clamp, pick


def test_clamp_and_pick():
    assert clamp(10_000, 1, 50) == 50
    assert clamp(-3, 1, 50) == 1
    assert pick("DROP TABLE x", ["a", "b"], "a") == "a"


def _database_available() -> bool:
    if not os.environ.get("PGHOST"):
        return False
    try:
        with psycopg.connect("", connect_timeout=3):
            return True
    except psycopg.OperationalError:
        return False


needs_db = pytest.mark.skipif(not _database_available(), reason="no Postgres server reachable")


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:
        yield c


@needs_db
def test_health(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["postgres"].startswith("18")


def _api_routes():
    # FastAPI wraps included routers lazily, so read the lab's own routers rather than app.routes
    from app.main import ROUTERS

    return [r for router in ROUTERS for r in router.routes if r.path.startswith("/api/demos/")]


def _demo_routes():
    return [(sorted(r.methods)[0], r.path) for r in _api_routes()]


def test_every_demo_route_is_registered():
    assert len(_demo_routes()) >= 40


@needs_db
@pytest.mark.parametrize("method,path", _demo_routes())
def test_every_demo_passes_its_own_checks(client, method, path):
    """Mirrors the UI's "Run all demos": every route under /api/demos must pass its self-checks."""
    response = client.request(method, path)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["checks"], path
    failed = [c for c in body["checks"] if not c["passed"]]
    assert not failed, f"{path}: {failed}"


@needs_db
@pytest.mark.parametrize("method,path", _demo_routes())
def test_mistake_mode_shows_the_real_error_and_the_fix(client, method, path):
    """Demos with a "Do it wrong" mode run the mistake for real; their checks must still pass."""
    route = next(r for r in _api_routes() if r.path == path)
    if "mistake" not in {p.name for p in route.dependant.query_params}:
        pytest.skip("no mistake mode")
    body = client.request(method, path, params={"mistake": True}).json()
    assert body["data"].get("mode") == "mistake", body
    assert all(c["passed"] for c in body["checks"]), body["checks"]
