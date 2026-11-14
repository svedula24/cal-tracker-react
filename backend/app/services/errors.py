"""What a service raises when a request cannot be done. The REST routes map these to 404 and 422 (with
`message` as the detail); the MCP tools return them as tool errors. `message` is short and safe to show:
it never echoes what the client sent."""

from __future__ import annotations


class ServiceError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class NotFound(ServiceError):
    """The thing asked for does not exist for this user (also: it is another user's)."""


class Invalid(ServiceError):
    """The request is well-formed but cannot be applied (unknown food, a row the core refuses, …)."""
