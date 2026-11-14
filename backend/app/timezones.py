"""The IANA zone names this server knows (the tzdata package, so not the host's own tz data)."""

from __future__ import annotations

import zoneinfo
from functools import cache


@cache
def _timezones() -> frozenset[str]:
    # Reads the tz database (about 600 names), so once per process.
    return frozenset(zoneinfo.available_timezones())


def known_timezone(name: str) -> bool:
    """Whether `name` is an IANA zone this server knows ("America/Los_Angeles", "UTC")."""
    return name in _timezones()
