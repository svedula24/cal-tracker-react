"""Request and response models for device registration and /api/v1/me."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field

from app.services.users import INTEGRATION_LABEL
from app.timezones import known_timezone


def _check_timezone(value: str) -> str:
    if not known_timezone(value):
        raise ValueError("unknown timezone")
    return value


# An IANA name such as "America/Los_Angeles" (the longest is about 32 characters); 422 when unknown.
Timezone = Annotated[str, Field(min_length=1, max_length=64), AfterValidator(_check_timezone)]


def _not_integration(value: str | None) -> str | None:
    # The version goes into the token's label; a label with this prefix marks an integration token
    # (app/services/integrations.py), so a device must never get one.
    if value is not None and value.startswith(INTEGRATION_LABEL):
        raise ValueError(f"must not start with {INTEGRATION_LABEL!r}")
    return value


def _long_is_unknown(value: object) -> object:
    # A name longer than any IANA zone is unknown (UTC), not worth keeping, and not a 422 either.
    return None if isinstance(value, str) and len(value) > 64 else value


class DeviceRegistration(BaseModel):
    """What the app says about itself when it registers: labels the token, and sets the user's timezone."""

    platform: Literal["ios", "android", "web"] | None = None
    app_version: Annotated[str | None, Field(max_length=32), AfterValidator(_not_integration)] = None
    # An IANA name; the user's calendar day ("today") follows it. Omitted, null or a name this server
    # does not know: UTC. Not a 422, because a phone with newer tz data than the server must still register.
    timezone: Annotated[str | None, BeforeValidator(_long_is_unknown)] = None

    def label(self) -> str | None:
        """The token label: `ios 1.4.0`, `web`, or None when the app sent neither."""
        return " ".join(part for part in (self.platform, self.app_version) if part) or None


class DeviceRegistered(BaseModel):
    """The only response that ever carries a token: the server keeps its hash and cannot show it again."""

    user_id: uuid.UUID
    token: str
    timezone: str  # the zone the server stored: the one sent, or UTC when it did not know it


class Me(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: uuid.UUID = Field(validation_alias="id")
    timezone: str
    created_at: datetime


class MePatch(BaseModel):
    """PATCH /api/v1/me: the user's IANA timezone (the app sends it when the device's zone changes)."""

    model_config = ConfigDict(extra="forbid")

    timezone: Timezone
