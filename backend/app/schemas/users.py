"""Request and response models for device registration and /api/v1/me."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class DeviceRegistration(BaseModel):
    """What the app says about itself when it registers. Only used to label the token."""

    platform: Literal["ios", "android", "web"] | None = None
    app_version: str | None = Field(default=None, max_length=32)

    def label(self) -> str | None:
        """The token label: `ios 1.4.0`, `web`, or None when the app sent neither."""
        return " ".join(part for part in (self.platform, self.app_version) if part) or None


class DeviceRegistered(BaseModel):
    """The only response that ever carries a token: the server keeps its hash and cannot show it again."""

    user_id: uuid.UUID
    token: str


class Me(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: uuid.UUID = Field(validation_alias="id")
    timezone: str
    created_at: datetime
