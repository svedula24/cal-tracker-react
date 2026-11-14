"""How /mcp knows who is calling: the SDK's bearer middleware asks `KaloVerifier` about each token.

A token is an OAuth access token issued by app/api/oauth.py for this server's resource
(PUBLIC_URL + "/mcp"); a device token never works here (app/services/oauth.py). The verified token
carries the user id in `subject` and the grant id in `claims`, which the tools read
(app/mcp/tools.py `caller`). Tests pass their own verifier to `create_app(token_verifier=...)`.
"""

from __future__ import annotations

from collections.abc import Callable

import anyio
from mcp.server.auth.provider import AccessToken
from sqlalchemy.orm import Session

from app.services import oauth


class KaloVerifier:
    """A `mcp.server.auth.provider.TokenVerifier`: resolves the token in the database (on a worker
    thread, so the event loop is not blocked), committing the grant's `last_used_at` touch."""

    def __init__(self, sessions: Callable[[], Session], resource: str) -> None:
        self.sessions = sessions  # read on each call: the app's sessionmaker exists only once it has started
        self.resource = resource

    async def verify_token(self, token: str) -> AccessToken | None:
        return await anyio.to_thread.run_sync(self._verify, token)

    def _verify(self, token: str) -> AccessToken | None:
        with self.sessions() as session:
            grant = oauth.resolve_access_token(session, token, self.resource)
            session.commit()
        if grant is None:
            return None
        return AccessToken(
            token=token,
            client_id=grant.client_id,
            scopes=sorted(grant.scopes),
            expires_at=int(grant.expires_at.timestamp()),
            resource=grant.resource,
            subject=str(grant.user_id),
            claims={"grant_id": str(grant.grant_id)},
        )
