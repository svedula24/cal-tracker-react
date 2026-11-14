"""POST /api/v1/sync: apply a device's pushed rows, then return what changed since its cursor.

One transaction: the route locks the user row (so no other write of this user can interleave),
`sync` pushes and pulls, the route commits once. Nothing here commits.

Push. Every row is validated first (app/schemas/logs.py), so a bad row is put in `rejected` and
never reaches the database. Per table, the batch's stored rows and foods are then fetched in a few
queries, the rows are applied in the request's order (`app.services.logs.write_row`: last write
wins) and written together (one UPDATE and one INSERT, each an executemany), inside a SAVEPOINT.
Should the database still refuse a row (a race the lookups cannot see, e.g. another user inserting
the same id), that savepoint is rolled back and the table's rows are applied again one at a time,
each in its own SAVEPOINT, so only the refused row is lost and it is reported in `rejected`.
Rows pushed under `daily_steps` (an app from before daily_activity; key `log_date`) are applied as
daily_activity rows, before those, changing only steps (the stored day_type and workout_kcal are
kept); a pull only ever returns `daily_activity`.

Pull. `rev` comes from one sequence and this user's writes are serialised by the lock, so every row
this request wrote has a higher `rev` than every row the user had before (`before`). A page is the
rows with cursor < rev <= before, in `rev` order, at most MAX_SYNC_ROWS over the four tables: the
rows written by this request are left out exactly, and nothing else can be skipped.
- More rows than a page: `has_more`, and the cursor is the last row returned. (The rows this request
  wrote then come back on a later page, to the device that sent them: the same data, harmless.)
- Otherwise the cursor is the user's highest `rev` now, which passes over the rows just written.
- When nothing is newer the cursor is the request's own (0 for null).
A pushed row that lost to a newer stored copy is always added to `changes` (whatever its `rev`, and
beyond the page size), so the device gets the winner.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ValidationError
from sqlalchemy import func, insert, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.models.foods import Food
from app.models.user_data import DailyActivity, FoodLog, SavedFood, User, UserGoal
from app.schemas.logs import (
    MAX_SYNC_ROWS,
    DailyActivityRow,
    DailyActivityTombstone,
    FoodLogRow,
    FoodLogTombstone,
    GoalRow,
    GoalTombstone,
    RawRow,
    Rejected,
    SavedFoodRow,
    SavedFoodTombstone,
    SyncChanges,
    SyncRequest,
    SyncResponse,
    rejection_reason,
)
from app.services.logs import LogRejected, apply_food_log, food_log_row, utc, write_row

GOAL_FIELDS = (
    *("calories", "protein_g", "carbs_g", "fat_g", "fiber_g", "sugar_g", "sodium_mg", "steps", "goal"),
    *("source", "workout_kcal", "active_rest_kcal"),
)
ACTIVITY_FIELDS = ("steps", "day_type", "workout_kcal")


def _sync_fields(row: Any) -> dict[str, Any]:
    return {"updated_at": utc(row.updated_at), "deleted_at": utc(row.deleted_at)}


def saved_food_row(row: SavedFood) -> SavedFoodRow:
    return SavedFoodRow.model_construct(fdc_id=row.fdc_id, saved_at=utc(row.saved_at), **_sync_fields(row))


def goal_row(row: UserGoal) -> GoalRow:
    fields = {name: getattr(row, name) for name in GOAL_FIELDS}
    return GoalRow.model_construct(effective_date=row.effective_date, **fields, **_sync_fields(row))


def daily_activity_row(row: DailyActivity) -> DailyActivityRow:
    fields = {name: getattr(row, name) for name in ACTIVITY_FIELDS}
    return DailyActivityRow.model_construct(activity_date=row.activity_date, **fields, **_sync_fields(row))


@dataclass(frozen=True)
class Table:
    """One synced table: its wire name, its model, its key (besides user_id) and its row models."""

    name: str
    model: type
    key: str
    row: type[BaseModel]
    tombstone: type[BaseModel]
    out: Callable[[Any], BaseModel]
    fields: Callable[[Any], dict[str, Any]] = lambda row: {}
    needs_food: bool = False


TABLES = (
    Table("food_logs", FoodLog, "id", FoodLogRow, FoodLogTombstone, food_log_row, needs_food=True),
    Table(
        "saved_foods",
        SavedFood,
        "fdc_id",
        SavedFoodRow,
        SavedFoodTombstone,
        saved_food_row,
        fields=lambda row: {"saved_at": row.saved_at},
        needs_food=True,
    ),
    Table(
        "goals",
        UserGoal,
        "effective_date",
        GoalRow,
        GoalTombstone,
        goal_row,
        fields=lambda row: {name: getattr(row, name) for name in GOAL_FIELDS},
    ),
    Table(
        "daily_activity",
        DailyActivity,
        "activity_date",
        DailyActivityRow,
        DailyActivityTombstone,
        daily_activity_row,
        fields=lambda row: {name: getattr(row, name) for name in ACTIVITY_FIELDS},
    ),
)


TABLE_BY_NAME = {table.name: table for table in TABLES}

# The legacy wire name of daily_activity (an app from before it), whose rows are keyed by log_date.
LEGACY_DAILY_STEPS, LEGACY_KEY = "daily_steps", "log_date"
# Such an app knows only steps: its row changes them and keeps the stored day_type and workout_kcal.
LEGACY_ACTIVITY = replace(TABLE_BY_NAME["daily_activity"], fields=lambda row: {"steps": row.steps})


def from_legacy(raws: Iterable[RawRow]) -> list[RawRow]:
    """Rows pushed under `daily_steps` as daily_activity rows: log_date becomes activity_date. A row
    that has no log_date is left as it is, so it is rejected as a row without its key."""
    rows = []
    for raw in raws:
        row = dict(raw)
        if LEGACY_KEY in row:
            row["activity_date"] = row.pop(LEGACY_KEY)
        rows.append(row)
    return rows


def as_legacy(rejected: Rejected) -> Rejected:
    """A rejection of a row pushed under `daily_steps`, in that row's own names."""
    reason = rejected.reason.replace("activity_date", LEGACY_KEY)
    return Rejected(table=LEGACY_DAILY_STEPS, key=rejected.key, reason=reason)


def stored_row(session: Session, user_id: uuid.UUID, table_name: str, key: Any) -> Any | None:
    """This user's row of `goals` or `daily_activity` with that key, deleted or not; None when there is none."""
    model = TABLE_BY_NAME[table_name].model
    stmt = select(model).where(model.user_id == user_id, getattr(model, TABLE_BY_NAME[table_name].key) == key)
    return session.execute(stmt).scalar_one_or_none()


def _write(table: Table, user_id: uuid.UUID, row: Any, stored: Any | None, now: datetime) -> tuple[Any | None, bool]:
    """`write_row` for one validated row of `table`: its key, and its fields unless it is a tombstone."""
    fields = table.fields(row) if row.deleted_at is None else None
    key_columns = {"user_id": user_id, table.key: getattr(row, table.key)}
    return write_row(table.model, stored, key_columns, fields, row.updated_at, row.deleted_at, now)


def upsert_row(
    session: Session, user_id: uuid.UUID, table_name: str, row: Any, stored: Any | None, now: datetime
) -> tuple[Any, bool]:
    """One validated row of `goals` or `daily_activity`, applied as a push applies it (`write_row`: last
    write wins), for the REST routes. `stored` is `stored_row` for its key. Returns (stored row, applied).
    The caller has locked the user row (`lock_user`) and commits. Flushes, so `rev` is set."""
    table = TABLE_BY_NAME[table_name]
    assert not table.needs_food, "food_logs and saved_foods have their own rules"
    result, applied = _write(table, user_id, row, stored, now)
    if result is not None:
        session.add(result)  # a new row; nothing to do for a stored one
    session.flush()
    return result, applied


def _sent_key(raw: RawRow, table: Table) -> str:
    """The key as the client sent it, for `rejected` (so the device can match it); "" when missing."""
    value = raw.get(table.key)
    return str(value)[:100] if isinstance(value, str | int) and not isinstance(value, bool) else ""


@dataclass
class Pushed:
    """What pushing one table's rows came to."""

    rejected: list[Rejected]
    lost: dict[Any, Any]  # key -> the stored row that beat a pushed one
    wrote: bool


def parse(table: Table, raws: Iterable[RawRow]) -> tuple[list[tuple[str, BaseModel]], list[Rejected]]:
    """Validates each row on its own: (the key as sent, the row) for the good ones, and the rejects.
    A row with `deleted_at` set is read as a tombstone (key, updated_at, deleted_at only)."""
    rows, rejected = [], []
    for raw in raws:
        model = table.tombstone if raw.get("deleted_at") is not None else table.row
        try:
            rows.append((_sent_key(raw, table), model.model_validate(raw)))
        except ValidationError as e:
            reason = rejection_reason(e.errors(include_url=False, include_input=False, include_context=False))
            rejected.append(Rejected(table=table.name, key=_sent_key(raw, table), reason=reason))
    return rows, rejected


def _apply_all(
    session: Session, user_id: uuid.UUID, table: Table, rows: list[tuple[str, BaseModel]], now: datetime, each: bool
) -> Pushed:
    """Applies one table's validated rows in order. `each`: every row in its own SAVEPOINT."""
    key_column = getattr(table.model, table.key)
    keys = {getattr(row, table.key) for _, row in rows}
    mine = select(table.model).where(table.model.user_id == user_id, key_column.in_(keys))
    existing = {getattr(stored, table.key): stored for stored in session.execute(mine).scalars()}

    foods: dict[int, Food] = {}
    if table.needs_food:
        wanted = {row.fdc_id for _, row in rows if row.deleted_at is None and row.fdc_id is not None}
        if wanted:
            foods = {
                food.fdc_id: food for food in session.execute(select(Food).where(Food.fdc_id.in_(wanted))).scalars()
            }

    taken: set[uuid.UUID] = set()  # ids that are another user's logs: only that they exist is read
    if table.model is FoodLog and keys - existing.keys():
        others = select(FoodLog.id).where(FoodLog.id.in_(keys - existing.keys()), FoodLog.user_id != user_id)
        taken = set(session.execute(others).scalars())

    def apply(row: Any) -> tuple[Any | None, bool]:
        key = getattr(row, table.key)
        if key in taken:
            raise LogRejected("not_found")
        stored = existing.get(key)
        if table.model is FoodLog:
            food = foods.get(row.fdc_id) if row.deleted_at is None and row.fdc_id is not None else None
            # The app sends 0 for a nutrient it does not know: see app/services/logs.py.
            return apply_food_log(user_id, row, stored, food, now, zero_means_unknown=True)
        if row.deleted_at is None and table.needs_food and row.fdc_id not in foods:
            raise LogRejected("unknown_food")
        return _write(table, user_id, row, stored, now)

    def insert_rows(new: Iterable[Any]) -> None:
        # One INSERT for all of them (an executemany), not one round trip per row. The rows never
        # enter the session: nothing reads them back (the pull leaves this request's rows out).
        values = [{k: v for k, v in vars(row).items() if not k.startswith("_")} for row in new]
        if values:
            # render_nulls: a None is sent as NULL, so rows with and without a value share one statement.
            session.execute(insert(table.model).execution_options(render_nulls=True), values)

    def one(row: Any) -> tuple[Any | None, bool, bool]:
        """Applies one row: (stored row, applied, whether it is a new row). With `each`, writes it too."""
        stored, applied = apply(row)
        is_new = stored is not None and stored is not existing.get(getattr(row, table.key))
        if each and applied:
            if is_new:
                insert_rows([stored])
            else:
                session.flush()
        return stored, applied, is_new

    pushed = Pushed(rejected=[], lost={}, wrote=False)
    new: dict[Any, Any] = {}  # rows to insert, by key: a later row of the batch with the same key changes it
    written: set[Any] = set()
    for sent_key, row in rows:
        key = getattr(row, table.key)
        try:
            if each:
                # The row is changed inside its savepoint (begin_nested flushes what is pending first).
                with session.begin_nested():
                    stored, applied, is_new = one(row)
                if is_new:  # read it back as a stored row, for a later row of the batch with the same key
                    stored = session.execute(mine.where(key_column == key)).scalar_one()
            else:
                stored, applied, is_new = one(row)
        except LogRejected as e:
            pushed.rejected.append(Rejected(table=table.name, key=sent_key, reason=e.reason))
            continue
        except DBAPIError:
            # The database refused the row after all. For a log that is an id taken since the lookup.
            reason = "not_found" if table.model is FoodLog else "invalid row"
            pushed.rejected.append(Rejected(table=table.name, key=sent_key, reason=reason))
            continue
        if stored is None:
            continue  # a tombstone for a row the server never had
        existing[key] = stored
        if is_new and not each:
            new[key] = stored
        if applied:
            pushed.wrote = True
            written.add(key)
        elif key not in written:  # it lost to a row that was there before this request
            pushed.lost[key] = stored
    if not each:
        session.flush()
        insert_rows(new.values())
    return pushed


def push_table(session: Session, user_id: uuid.UUID, table: Table, raws: list[RawRow], now: datetime) -> Pushed:
    rows, rejected = parse(table, raws)
    if not rows:
        return Pushed(rejected=rejected, lost={}, wrote=False)
    try:
        with session.begin_nested():
            pushed = _apply_all(session, user_id, table, rows, now, each=False)
    except DBAPIError:
        pushed = _apply_all(session, user_id, table, rows, now, each=True)
    pushed.rejected = rejected + pushed.rejected
    return pushed


def highest_rev(session: Session, user_id: uuid.UUID) -> int:
    """The user's highest `rev` over the four tables (0 when they have no rows). One statement."""
    per_table = [
        select(func.coalesce(func.max(t.model.rev), 0)).where(t.model.user_id == user_id).scalar_subquery()
        for t in TABLES
    ]
    return max(session.execute(select(*per_table)).one())


def pull(session: Session, user_id: uuid.UUID, cursor: int, upto: int) -> tuple[list[tuple[Table, Any]], bool]:
    """The user's rows with cursor < rev <= upto in `rev` order, at most MAX_SYNC_ROWS, and whether more remain.

    One indexed range query per table (`<table>_user_rev_idx`), each limited to a page + 1, merged by `rev`.
    """
    found: list[tuple[Table, Any]] = []
    if upto > cursor:
        for table in TABLES:
            model = table.model
            stmt = (
                select(model)
                .where(model.user_id == user_id, model.rev > cursor, model.rev <= upto)
                .order_by(model.rev)
                .limit(MAX_SYNC_ROWS + 1)
            )
            found.extend((table, row) for row in session.execute(stmt).scalars())
    found.sort(key=lambda pair: pair[1].rev)
    return found[:MAX_SYNC_ROWS], len(found) > MAX_SYNC_ROWS


def sync(session: Session, user: User, request: SyncRequest) -> SyncResponse:
    """Push then pull for `user`, whose row the caller has locked. Flushes; does not commit."""
    now = datetime.now(UTC)
    cursor = request.cursor or 0
    before = highest_rev(session, user.id)

    rejected: list[Rejected] = []
    lost: list[tuple[Table, Any, Any]] = []
    wrote = False
    # Rows pushed under the legacy name go first, as daily_activity rows; a rejection names them as sent.
    legacy = request.changes.daily_steps
    pushes = [(LEGACY_ACTIVITY, from_legacy(legacy), True)] if legacy else []
    pushes += [(table, getattr(request.changes, table.name), False) for table in TABLES]
    for table, raws, is_legacy in pushes:
        pushed = push_table(session, user.id, table, raws, now)
        rejected.extend([as_legacy(r) for r in pushed.rejected] if is_legacy else pushed.rejected)
        lost.extend((table, key, row) for key, row in pushed.lost.items())
        wrote = wrote or pushed.wrote

    page, has_more = pull(session, user.id, cursor, before)
    if has_more:
        new_cursor = page[-1][1].rev
    else:
        # Everything up to `before` has been returned; what this request wrote lies above it.
        new_cursor = max(cursor, highest_rev(session, user.id) if wrote else before)

    changes = SyncChanges()
    sent = {(table.name, getattr(row, table.key)) for table, row in page}
    winners = []
    for table, key, row in lost:  # a day pushed under both names can lose twice: sent once
        if (table.name, key) not in sent:
            sent.add((table.name, key))
            winners.append((table, row))
    for table, row in [*page, *winners]:
        getattr(changes, table.name).append(table.out(row))
    return SyncResponse(cursor=new_cursor, has_more=has_more, changes=changes, rejected=rejected)
