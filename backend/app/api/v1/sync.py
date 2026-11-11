"""POST /api/v1/sync: the app pushes its local changes and pulls what changed on the server."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.api.deps import CurrentUser, DbSession
from app.schemas.logs import MAX_SYNC_ROWS, SyncRequest, SyncResponse
from app.services import logs as log_service
from app.services import sync as sync_service

router = APIRouter(prefix="/api/v1", tags=["sync"])


@router.post("/sync", responses={413: {"description": f"More than {MAX_SYNC_ROWS} rows in one request"}})
def sync(session: DbSession, user: CurrentUser, body: SyncRequest) -> SyncResponse:
    """Apply the pushed rows (last write wins on `updated_at`), then return the user's rows changed
    since `cursor`, at most 500 a call: call again with the returned cursor while `has_more`.

    A row that cannot be applied is listed in `rejected` and the rest of the batch still is. The
    rows this request wrote are not sent back; a pushed row that lost to a newer copy is. The whole
    request is one transaction. See app/services/sync.py.
    """
    if body.changes.row_count() > MAX_SYNC_ROWS:
        raise HTTPException(413, f"at most {MAX_SYNC_ROWS} rows in one request")
    log_service.lock_user(session, user.id)
    result = sync_service.sync(session, user, body)
    session.commit()
    return result
