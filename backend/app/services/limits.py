"""Rate limits counted in Postgres (the rate_limits table, migration 0006), for a deployment with several
processes or serverless instances that share no memory (Vercel). Same interface as the in-memory
app/api/limits.py `SlidingWindow`, which stays the default (RATE_LIMITS=memory) for local runs and tests.

`make_limiter` picks one from the app's settings; app/main.py makes every limiter with it, and a module
that adds its own limiter (`app.state.<name>`) should too.

Unlike a service, a limiter commits: each call is its own short transaction on its own connection, so an
event is counted even when the request that made it fails, and the row lock is held only for that call.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

from fastapi import FastAPI
from sqlalchemy import Engine, text

from app.api.limits import SWEEP_EVERY, SlidingWindow

# Locks the key's row (creating it, empty, if it is new) and returns its events: concurrent calls for one
# key, from any instance, queue on the lock, so the limit is never exceeded.
_LOCK = text(
    "INSERT INTO rate_limits (name, key, events, last_at) VALUES (:name, :key, '{}', to_timestamp(:now))"
    " ON CONFLICT (name, key) DO UPDATE SET name = EXCLUDED.name RETURNING events"
)
_SAVE = text(
    "UPDATE rate_limits SET events = CAST(:events AS float8[]), last_at = to_timestamp(:now)"
    " WHERE name = :name AND key = :key"
)
# Keys whose events have all aged out (last_at is the newest event, or when an empty row was made). A row
# another call has locked is skipped, not waited for, so two sweeps (or a sweep and a call) never deadlock.
_SWEEP = text(
    "DELETE FROM rate_limits WHERE (name, key) IN (SELECT name, key FROM rate_limits"
    " WHERE name = :name AND last_at <= to_timestamp(:oldest) FOR UPDATE SKIP LOCKED)"
)


class DbSlidingWindow:
    """At most `limit` events per key in any `per_seconds`, counted in the rate_limits table under `name`.

    `engine` is the engine or a callable returning it (the app's engine exists only once its lifespan has
    started). Times are wall-clock seconds (`clock`, default time.time), since instances share no
    monotonic clock. Each call is two statements in one transaction; every SWEEP_EVERY seconds an
    instance also deletes this limiter's quiet keys, in a transaction of its own.
    """

    def __init__(
        self,
        engine: Engine | Callable[[], Engine],
        name: str,
        limit: int,
        per_seconds: float,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._engine = engine
        self.name = name
        self.limit = limit
        self.per_seconds = per_seconds
        self.clock = clock
        self._swept = clock()
        self._sweep_lock = threading.Lock()

    def _get_engine(self) -> Engine:
        return self._engine if isinstance(self._engine, Engine) else self._engine()

    def retry_after(self, key: str, record: bool = True) -> float | None:
        """Record an event for `key` and return None, or (the event is refused) the seconds until one is
        allowed. `record=False` only checks: the caller records later, if the event turns out to count."""
        now = self.clock()
        oldest_kept = now - self.per_seconds
        params = {"name": self.name, "key": key, "now": now}
        engine = self._get_engine()
        with engine.begin() as conn:
            stored = conn.execute(_LOCK, params).scalar_one()
            events = [at for at in stored if at > oldest_kept]
            if len(events) >= self.limit:
                wait: float | None = events[0] + self.per_seconds - now
            else:
                wait = None
                if record:
                    events.append(now)
            if events != stored:
                conn.execute(_SAVE, {**params, "events": events, "now": events[-1] if events else now})
        if self._sweep_due(now):
            with engine.begin() as conn:
                conn.execute(_SWEEP, {"name": self.name, "oldest": oldest_kept})
        return wait

    def _sweep_due(self, now: float) -> bool:
        with self._sweep_lock:
            if now - self._swept < SWEEP_EVERY:
                return False
            self._swept = now
            return True


def make_limiter(app: FastAPI, name: str, limit: int, per_seconds: float) -> SlidingWindow | DbSlidingWindow:
    """A limiter for `app.state.<name>`: in this process's memory, or in Postgres with RATE_LIMITS=db
    (`app.state.settings.rate_limits`). `name` keys its rows, so it must be unique per app."""
    if app.state.settings.rate_limits == "db":
        # Its own engine (made in the lifespan, app/db/session.py make_limits_engine), not the requests' pool.
        return DbSlidingWindow(lambda: app.state.limits_engine, name, limit, per_seconds)
    return SlidingWindow(limit, per_seconds)
