"""The DemoResult contract every demo endpoint returns, and a recorder that builds it."""

from __future__ import annotations

import time
from typing import Any, Callable

import psycopg


def error_text(exc: BaseException) -> str:
    """Formats an error the way psql prints it, so it matches what people search for."""
    if isinstance(exc, psycopg.Error) and exc.diag.message_primary:
        text = f"ERROR:  {exc.diag.message_primary}"
        if exc.diag.message_detail:
            text += f"\nDETAIL:  {exc.diag.message_detail}"
        if exc.diag.message_hint:
            text += f"\nHINT:  {exc.diag.message_hint}"
        return text
    return f"{type(exc).__name__}: {exc}".strip()


class Demo:
    """Collects the commands a demo ran and the checks it verified, then renders the result.

    with Demo("hello") as d:
        d.command("SELECT 1")
        d.check("Returned 1", value == 1, f"got {value!r}")
        d.data["value"] = value
    return d.result()
    """

    def __init__(self, name: str) -> None:
        self.name = name
        self.commands: list[str] = []
        self.checks: list[dict[str, Any]] = []
        self.data: dict[str, Any] = {}
        self._started = time.perf_counter()

    def __enter__(self) -> "Demo":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def command(self, text: str) -> None:
        self.commands.append(text)

    def check(self, name: str, passed: bool, detail: Any = "") -> None:
        self.checks.append({"name": name, "passed": bool(passed), "detail": str(detail)})

    def attempt(self, command: str, fn: Callable[[], Any]) -> tuple[Any, str | None]:
        """Run a step that may fail on purpose (a pitfall demo) and record the real error it raises.

        value, error = d.attempt("INSERT ... duplicate", lambda: conn.execute(...))
        d.check("The wrong way fails with the documented error", error and "duplicate key" in error, error)
        """
        self.command(command)
        try:
            return fn(), None
        except Exception as exc:  # the error is the lesson: show it, don't hide it
            error = error_text(exc)
            self.command(f"  -> {error.splitlines()[0]}")
            return None, error

    def ms(self) -> float:
        return round((time.perf_counter() - self._started) * 1000, 2)

    def result(self) -> dict[str, Any]:
        return {
            "demo": self.name,
            "commands": self.commands,
            "data": self.data,
            "checks": self.checks,
            "elapsedMs": self.ms(),
        }


def clamp(value: int, low: int, high: int) -> int:
    """The site is public through the tunnel: bound every size, count and duration a visitor can pick."""
    return max(low, min(high, value))


def pick(value: str, allowed: dict[str, Any] | list[str], default: str) -> str:
    """Visitors choose among prepared scenarios; anything else falls back to the default."""
    return value if value in allowed else default
