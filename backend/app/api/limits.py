"""Request limits: a rate limit for the one endpoint anyone can call without a token, and a cap on body size."""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

SWEEP_EVERY = 60.0  # seconds between sweeps of keys that have gone quiet


class SlidingWindow:
    """At most `limit` events per key in any `per_seconds`. Kept in this process's memory.

    Enough to stop one address from filling the database through a loop. Each process counts on its
    own, so a deployment with several workers or instances should also limit at the proxy. Safe to
    call from several threads (sync routes run in a threadpool).
    """

    def __init__(self, limit: int, per_seconds: float, clock: Callable[[], float] = time.monotonic) -> None:
        self.limit = limit
        self.per_seconds = per_seconds
        self.clock = clock
        self._events: dict[str, deque[float]] = {}
        self._lock = threading.Lock()
        self._swept = clock()

    def retry_after(self, key: str) -> float | None:
        """Record an event for `key` and return None, or (the event is refused) the seconds until one is allowed."""
        with self._lock:
            now = self.clock()
            oldest_kept = now - self.per_seconds
            if now - self._swept >= SWEEP_EVERY:
                # Forget every key whose events have all aged out, so the table cannot grow without bound.
                self._events = {k: events for k, events in self._events.items() if events[-1] > oldest_kept}
                self._swept = now
            events = self._events.setdefault(key, deque())
            while events and events[0] <= oldest_kept:
                events.popleft()
            if len(events) >= self.limit:
                return events[0] + self.per_seconds - now
            events.append(now)
            return None


class BodyLimit:
    """Refuses (413) a request whose declared Content-Length is over `max_bytes`, before reading any of it.

    Plain ASGI, not BaseHTTPMiddleware: that one streams every response, which would cost the gzip
    middleware its Content-Length. A body sent without a Content-Length (chunked) is not caught
    here: cap that at the proxy.
    """

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            declared = dict(scope["headers"]).get(b"content-length", b"").decode("latin-1")
            if declared.isdigit() and int(declared) > self.max_bytes:
                refusal = JSONResponse({"detail": f"request body over {self.max_bytes} bytes"}, status_code=413)
                await refusal(scope, receive, send)
                return
        await self.app(scope, receive, send)

