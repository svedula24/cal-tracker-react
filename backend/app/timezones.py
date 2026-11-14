"""The IANA zone names this server knows: the host's tz database (TZPATH) plus the tzdata package,
without the host-only aliases (posix/*, right/*, posixrules, localtime) that are not zone names a
phone reports."""

from __future__ import annotations

import zoneinfo
from functools import cache

_NOT_ZONES = ("posix/", "right/")


@cache
def _timezones() -> frozenset[str]:
    # Reads the tz database (about 600 names), so once per process.
    return frozenset(
        name
        for name in zoneinfo.available_timezones()
        if not name.startswith(_NOT_ZONES) and name not in ("posixrules", "localtime", "Factory")
    )


def known_timezone(name: str) -> bool:
    """Whether `name` is an IANA zone this server knows ("America/Los_Angeles", "UTC")."""
    return name in _timezones()
