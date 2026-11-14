"""The MCP tools: what ChatGPT can read and change in a user's Kalo data.

Each tool is a plain function the SDK runs on a worker thread (sync tools never block the event loop),
with its own database session. The user is the access token's (app/mcp/auth.py); no tool takes a user
id. The work goes through the same services as the REST routes (log_writes, goal_writes, daily,
log_queries, foods), so a change made here gets a new `rev` and reaches the phone on its next sync.
Write tools need the `nutrition:write` scope, lock the user row (inside the service) and commit once.

Every result carries `today` and `timezone` (the user's), so the model knows which day "today" is.
Numbers are rounded to 1 decimal. A refusal (unknown food, not found, invalid) is a ToolError: the
call comes back with isError and the message, never a 500.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Annotated, Any

from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations
from pydantic import Field, ValidationError
from sqlalchemy.orm import Session

from app.models.user_data import User
from app.schemas.log_api import FoodLogCreate
from app.schemas.logs import MAX_NAME, MAX_NUMBER, FoodLogOut, rejection_reason
from app.services import daily as daily_service
from app.services import foods as food_service
from app.services import goal_writes, log_queries, log_writes
from app.services import logs as log_service
from app.services.errors import ServiceError
from app.services.oauth import SCOPE_WRITE

MAX_HISTORY_DAYS = 31
MACROS = ("calories", "protein_g", "carbs_g", "fat_g")
NUTRIENTS = (*MACROS, "fiber_g", "sugar_g", "sodium_mg")
# Used for the parts of a first goal (no goal yet) that the call leaves out.
NEW_GOAL_DEFAULTS: dict[str, Any] = {
    "fiber_g": 30, "sugar_g": 50, "sodium_mg": 2300, "steps": 10000, "goal": "maintain",
}  # fmt: skip

READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
CREATE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
UPDATE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False)
DELETE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=True, openWorldHint=False)

# Input types. Dates are the user's calendar days.
DateArg = Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$", description="A day, YYYY-MM-DD.")]
OptionalDate = Annotated[
    str | None,
    Field(
        pattern=r"^\d{4}-\d{2}-\d{2}$",
        description="The day, YYYY-MM-DD, in the user's calendar. Default: today (see `today` in any result).",
    ),
]
LogId = Annotated[str, Field(description="The entry's `log_id`, from get_daily_macros (or log_food).")]
Grams = Annotated[float, Field(gt=0, le=100000)]
Amount = Annotated[float, Field(ge=0, le=MAX_NUMBER)]
Name = Annotated[str, Field(min_length=1, max_length=MAX_NAME)]


def r1(value: float | None) -> float | None:
    """Rounded to 1 decimal (None stays None)."""
    return None if value is None else round(float(value), 1)


def rounded(values: Mapping[str, Any], keys: tuple[str, ...] = NUTRIENTS) -> dict[str, float | None]:
    return {key: r1(values[key]) for key in keys}


@dataclass(frozen=True)
class Caller:
    user_id: uuid.UUID
    scopes: frozenset[str]


def caller(ctx: Context) -> Caller:
    """Who is calling, from the verified access token (app/mcp/auth.py puts the user id in `subject`)."""
    token = get_access_token()
    if token is None:  # the contextvar did not reach this thread: read the HTTP request's user instead
        request = getattr(ctx.request_context, "request", None)
        user = request.scope.get("user") if request is not None else None
        token = getattr(user, "access_token", None)
    if token is None or token.subject is None:
        raise ToolError("Not signed in to Kalo: reconnect Kalo in ChatGPT.")
    return Caller(uuid.UUID(token.subject), frozenset(token.scopes))


def require_write(who: Caller) -> None:
    if SCOPE_WRITE not in who.scopes:
        raise ToolError(
            "This Kalo connection is read-only, so it cannot log, edit or delete food or change goals. "
            "To allow it, reconnect Kalo in ChatGPT and keep 'also log, edit and delete food' checked."
        )


def parse_day(value: str, field: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as e:
        raise ToolError(f"{field} must be a real day, YYYY-MM-DD") from e


def parse_log_id(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError as e:
        raise ToolError("log_id is not a Kalo log id: take it from get_daily_macros") from e


def amount_text(quantity: float, unit: str) -> str:
    if unit == "g":
        return f"{r1(quantity):g} g"
    return f"{r1(quantity):g} serving" + ("" if r1(quantity) == 1 else "s")


def entry(log: FoodLogOut) -> dict[str, Any]:
    """A log as the model sees it: what, how much, and its totals."""
    return {
        "log_id": str(log.id),
        "date": log.log_date.isoformat(),
        "name": log.name,
        "fdc_id": log.fdc_id,
        "amount": amount_text(log.quantity, log.unit),
        "quantity": r1(log.quantity),
        "unit": log.unit,
        **rounded(log.totals.model_dump()),
    }


class Tools:
    """The tools, bound to a way of opening a database session (the app's sessionmaker, read when called)."""

    def __init__(self, sessions: Callable[[], Session]) -> None:
        self.sessions = sessions

    @contextmanager
    def user_session(self, ctx: Context, write: bool = False) -> Iterator[tuple[Session, User, dict[str, Any]]]:
        """A session, the caller's user, and the `today`/`timezone` every result starts with. A write
        tool commits the session itself; leaving without a commit rolls back. For a write, the user row
        is locked first (logs.lock_user), so what the tool reads before writing (the goal it merges
        into) cannot change under it."""
        who = caller(ctx)
        if write:
            require_write(who)
        with self.sessions() as session:
            if write:
                log_service.lock_user(session, who.user_id)
            user = session.get(User, who.user_id)
            if user is None:
                raise ToolError("This Kalo account no longer exists.")
            now = datetime.now(UTC)
            header = {"today": log_queries.local_date(user, now).isoformat(), "timezone": user.timezone}
            try:
                yield session, user, header
            except ServiceError as e:
                raise ToolError(e.message) from e

    def day_or_today(self, value: str | None, header: Mapping[str, Any], field: str = "date") -> date:
        return parse_day(value, field) if value else date.fromisoformat(header["today"])

    # --- reads -----------------------------------------------------------------------------------------

    def search_foods(
        self,
        ctx: Context,
        query: Annotated[str, Field(min_length=1, max_length=100, description="What to look for, e.g. 'banana'.")],
        limit: Annotated[int, Field(ge=1, le=20, description="How many foods to return.")] = 8,
    ) -> dict[str, Any]:
        """Search the USDA food database (generic foods). Returns each food's `fdc_id`, nutrients per
        100 g (calories in kcal, protein/carbs/fat/fiber/sugar in grams, sodium in mg; null = not
        reported) and its portions (name and grams). Use this to find the `fdc_id` and a portion name
        before calling log_food."""
        if not food_service.normalize(query):
            raise ToolError("query must contain text")
        with self.user_session(ctx) as (session, _user, header):
            rows, portions = food_service.search_page(session, query, limit)
            foods = [
                {
                    "fdc_id": row["fdc_id"],
                    "name": row["description"],
                    "per_100g": {
                        "calories": r1(row["calories_per_100g"]),
                        "protein_g": r1(row["protein_per_100g"]),
                        "carbs_g": r1(row["carbs_per_100g"]),
                        "fat_g": r1(row["fat_per_100g"]),
                        "fiber_g": r1(row["fiber_per_100g"]),
                        "sugar_g": r1(row["sugar_per_100g"]),
                        "sodium_mg": r1(row["sodium_mg_per_100g"]),
                    },
                    "portions": [{"name": p.description, "grams": r1(p.gram_weight)} for p in portions[row["fdc_id"]]],
                }
                for row in rows
            ]
            return {**header, "foods": foods}

    def get_recent_foods(
        self,
        ctx: Context,
        limit: Annotated[int, Field(ge=1, le=30, description="How many foods to return.")] = 10,
    ) -> dict[str, Any]:
        """The USDA foods this user logged most recently, each once, newest first, with the amount
        (grams) and day of the latest log, calories per 100 g and the food's portions. Useful for
        "log my usual breakfast". Custom foods are not included."""
        with self.user_session(ctx) as (session, user, header):
            rows, portions = log_queries.recent_foods(session, user.id, limit)
            foods = [
                {
                    "fdc_id": row["fdc_id"],
                    "name": row["description"],
                    "last_grams": r1(row["grams"]),
                    "last_logged_on": row["log_date"].isoformat(),
                    "calories_per_100g": r1(row["calories_per_100g"]),
                    "portions": [{"name": p.description, "grams": r1(p.gram_weight)} for p in portions[row["fdc_id"]]],
                }
                for row in rows
            ]
            return {**header, "foods": foods}

    def get_daily_macros(self, ctx: Context, date: OptionalDate = None) -> dict[str, Any]:
        """One day of the user's food log: every entry (with its `log_id`, needed to edit or delete it),
        the day's totals, the goal in force, the day's activity (steps, day type, workout kcal), the
        day's target (the goal adjusted for activity) and what remains (negative = over). Calories in
        kcal, sodium in mg, the rest in grams. target/remaining are null when the user has no goal."""
        with self.user_session(ctx) as (session, user, header):
            day = self.day_or_today(date, header)
            return {**header, **self.day_view(session, user, day)}

    def day_view(self, session: Session, user: User, day: date) -> dict[str, Any]:
        summary = daily_service.daily_summary(session, user, day)
        logs = log_queries.day_logs(session, user.id, day)
        goal = summary.goal
        return {
            "date": day.isoformat(),
            "entries": [entry(log_service.food_log_out(log)) for log in logs],
            "totals": rounded(summary.totals.model_dump()),
            "target": rounded(summary.target.model_dump()) if summary.target else None,
            "remaining": rounded(summary.remaining.model_dump()) if summary.remaining else None,
            "goal": (
                {
                    **rounded(goal.model_dump()),
                    "since": goal.effective_date.isoformat(),
                    "steps": goal.steps,
                    "goal": goal.goal,
                    "workout_kcal": r1(goal.workout_kcal),
                    "active_rest_kcal": r1(goal.active_rest_kcal),
                }
                if goal
                else None
            ),
            "activity": summary.activity.model_dump() if summary.activity else None,
            "activity_kcal": r1(summary.target.adjustment_kcal) if summary.target else None,
        }

    def get_nutrition_history(
        self,
        ctx: Context,
        start_date: Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$", description="First day, YYYY-MM-DD.")],
        end_date: Annotated[
            str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$", description="Last day, YYYY-MM-DD (inclusive).")
        ],
    ) -> dict[str, Any]:
        """Per-day totals and targets over a range of at most 31 days (both ends included), oldest
        first: each day's calories (kcal), protein, carbs, fat, fiber, sugar (g), sodium (mg), how
        many entries, and that day's target (null when no goal was in force). Days without entries
        are zeros. For one day's entries use get_daily_macros."""
        start = parse_day(start_date, "start_date")
        end = parse_day(end_date, "end_date")
        if end < start:
            raise ToolError("end_date is before start_date")
        if (end - start).days + 1 > MAX_HISTORY_DAYS:
            raise ToolError(f"at most {MAX_HISTORY_DAYS} days at a time: split the range")
        with self.user_session(ctx) as (session, user, header):
            days = daily_service.history(session, user, start, end)
            return {
                **header,
                "days": [
                    {
                        "date": d.date.isoformat(),
                        "entries": d.log_count,
                        "totals": rounded(d.totals.model_dump()),
                        "target": rounded(d.target.model_dump()) if d.target else None,
                    }
                    for d in days
                ],
            }

    # --- writes ----------------------------------------------------------------------------------------

    def log_food(
        self,
        ctx: Context,
        fdc_id: Annotated[int, Field(ge=1, description="The food's id from search_foods or get_recent_foods.")],
        grams: Annotated[Grams | None, Field(description="The amount eaten in grams. Give this OR portion.")] = None,
        portion: Annotated[
            str | None,
            Field(
                min_length=1,
                max_length=200,
                description="A portion name exactly as search_foods lists it (e.g. '1 medium'). Give this OR grams.",
            ),
        ] = None,
        quantity: Annotated[
            float, Field(gt=0, le=100, description="How many of the portion (only with portion), e.g. 2 or 0.5.")
        ] = 1,
        date: OptionalDate = None,
        name: Annotated[
            Name | None, Field(description="What to call the entry. Default: the food's USDA name.")
        ] = None,
    ) -> dict[str, Any]:
        """Log a USDA food the user ate: by `fdc_id` (call search_foods first) and an amount, either
        `grams` or a `portion` name × `quantity`. Logs for today unless `date` is given. Returns the
        new entry (with its `log_id`) and the day's new totals and remaining."""
        if (grams is None) == (portion is None):
            raise ToolError("give either grams or portion (not both)")
        if grams is not None and quantity != 1:
            raise ToolError("quantity goes with portion; with grams give the total grams")
        with self.user_session(ctx, write=True) as (session, user, header):
            day = self.day_or_today(date, header)
            food = food_service.get_food(session, fdc_id)
            if food is None:
                raise ToolError(f"no food with fdc_id {fdc_id}: call search_foods to find the id")
            if portion is not None:
                grams = self.portion_grams(session, fdc_id, portion) * quantity
            try:
                body = FoodLogCreate(fdc_id=fdc_id, quantity=grams, log_date=day, name=name)
            except ValidationError as e:
                raise ToolError(rejection_reason(e.errors())) from e
            out, _ = log_writes.create_log(session, user, body, datetime.now(UTC))
            result = {**header, "logged": entry(out), "day": self.day_totals(session, user, out.log_date)}
            session.commit()
            return result

    @staticmethod
    def portion_grams(session: Session, fdc_id: int, portion: str) -> float:
        """The grams of the food's portion called `portion` (any case, any spacing)."""
        portions = food_service.get_portions(session, fdc_id)
        wanted = " ".join(portion.lower().split())
        for candidate in portions:
            if " ".join(candidate.description.lower().split()) == wanted:
                return candidate.gram_weight
        # "medium" for "1 medium": the name without its leading count, when only one portion fits.
        loose = [p for p in portions if re.sub(r"^1\s+", "", " ".join(p.description.lower().split())) == wanted]
        if len(loose) == 1:
            return loose[0].gram_weight
        if not portions:
            raise ToolError("this food has no portions: give grams instead")
        names = "; ".join(f"{p.description} ({r1(p.gram_weight):g} g)" for p in portions)
        raise ToolError(f"no portion called {portion!r} for this food. Its portions: {names}. Or give grams.")

    def day_totals(self, session: Session, user: User, day: date) -> dict[str, Any]:
        summary = daily_service.daily_summary(session, user, day)
        return {
            "date": day.isoformat(),
            "totals": rounded(summary.totals.model_dump(), MACROS),
            "remaining": rounded(summary.remaining.model_dump(), MACROS) if summary.remaining else None,
        }

    def log_custom_food(
        self,
        ctx: Context,
        name: Annotated[Name, Field(description="What the food is, e.g. 'Homemade lasagna'.")],
        calories: Annotated[Amount, Field(description="kcal per serving.")],
        protein_g: Annotated[Amount, Field(description="Protein per serving, g.")],
        carbs_g: Annotated[Amount, Field(description="Carbohydrate per serving, g.")],
        fat_g: Annotated[Amount, Field(description="Fat per serving, g.")],
        fiber_g: Annotated[Amount | None, Field(description="Fiber per serving, g, if known.")] = None,
        sugar_g: Annotated[Amount | None, Field(description="Sugar per serving, g, if known.")] = None,
        sodium_mg: Annotated[Amount | None, Field(description="Sodium per serving, mg, if known.")] = None,
        servings: Annotated[float, Field(gt=0, le=100, description="How many servings were eaten.")] = 1,
        date: OptionalDate = None,
    ) -> dict[str, Any]:
        """Log a food that is not in the USDA database (a restaurant dish, a recipe, a packaged food)
        by its nutrition per serving and the number of servings. Prefer log_food when search_foods
        finds the food. Returns the new entry (with its `log_id`) and the day's new totals."""
        values = {
            "calories": calories,
            "protein_g": protein_g,
            "carbs_g": carbs_g,
            "fat_g": fat_g,
            "fiber_g": fiber_g,
            "sugar_g": sugar_g,
            "sodium_mg": sodium_mg,
        }
        with self.user_session(ctx, write=True) as (session, user, header):
            day = self.day_or_today(date, header)
            try:
                body = FoodLogCreate(quantity=servings, unit="serving", log_date=day, name=name, values=values)
            except ValidationError as e:
                raise ToolError(rejection_reason(e.errors())) from e
            out, _ = log_writes.create_log(session, user, body, datetime.now(UTC))
            result = {**header, "logged": entry(out), "day": self.day_totals(session, user, out.log_date)}
            session.commit()
            return result

    def update_food_log(
        self,
        ctx: Context,
        log_id: LogId,
        amount: Annotated[
            float | None,
            Field(
                gt=0,
                le=100000,
                description="The new amount in the entry's unit: grams for a USDA food, servings for a custom one.",
            ),
        ] = None,
        date: Annotated[
            str | None, Field(pattern=r"^\d{4}-\d{2}-\d{2}$", description="Move the entry to this day, YYYY-MM-DD.")
        ] = None,
        name: Annotated[Name | None, Field(description="A new name for the entry.")] = None,
    ) -> dict[str, Any]:
        """Change an entry's amount, day or name. Take `log_id` from get_daily_macros. Totals follow the
        new amount. Returns the entry as it now is."""
        changes: dict[str, Any] = {}
        if amount is not None:
            changes["quantity"] = amount
        if date is not None:
            changes["log_date"] = parse_day(date, "date")
        if name is not None:
            if not name.strip():
                raise ToolError("name must not be blank")
            changes["name"] = name
        if not changes:
            raise ToolError("nothing to change: give amount, date or name")
        log_id_value = parse_log_id(log_id)
        with self.user_session(ctx, write=True) as (session, user, header):
            out = log_writes.edit_log(session, user, log_id_value, changes, datetime.now(UTC))
            result = {**header, "updated": entry(out)}
            session.commit()
            return result

    def delete_food_log(self, ctx: Context, log_id: LogId) -> dict[str, Any]:
        """Delete an entry from the food log (take `log_id` from get_daily_macros). It disappears from
        the user's phone on its next sync. Deleting an entry that is already deleted does nothing."""
        log_id_value = parse_log_id(log_id)
        with self.user_session(ctx, write=True) as (session, user, header):
            out = log_writes.delete_log(session, user, log_id_value, datetime.now(UTC))
            gone = entry(out)
            result = {**header, "deleted": {key: gone[key] for key in ("log_id", "date", "name", "amount")}}
            session.commit()
            return result

    def update_daily_goal(
        self,
        ctx: Context,
        calories: Annotated[Amount | None, Field(description="Daily calories, kcal.")] = None,
        protein_g: Annotated[Amount | None, Field(description="Daily protein, g.")] = None,
        carbs_g: Annotated[Amount | None, Field(description="Daily carbohydrate, g.")] = None,
        fat_g: Annotated[Amount | None, Field(description="Daily fat, g.")] = None,
        fiber_g: Annotated[Amount | None, Field(description="Daily fiber, g.")] = None,
        sugar_g: Annotated[Amount | None, Field(description="Daily sugar limit, g.")] = None,
        sodium_mg: Annotated[Amount | None, Field(description="Daily sodium limit, mg.")] = None,
        steps: Annotated[int | None, Field(ge=0, le=200000, description="Daily step goal.")] = None,
    ) -> dict[str, Any]:
        """Change the user's daily targets from today on. Give only what changes: the rest is kept from
        the goal in force today. Earlier days keep their own goal. If the user has no goal yet,
        calories, protein_g, carbs_g and fat_g are required. Returns the goal now in force."""
        given = {
            "calories": calories,
            "protein_g": protein_g,
            "carbs_g": carbs_g,
            "fat_g": fat_g,
            "fiber_g": fiber_g,
            "sugar_g": sugar_g,
            "sodium_mg": sodium_mg,
            "steps": steps,
        }
        changes = {key: value for key, value in given.items() if value is not None}
        if not changes:
            raise ToolError("nothing to change: give at least one target")
        with self.user_session(ctx, write=True) as (session, user, header):
            today = date.fromisoformat(header["today"])
            current = log_queries.goal_on(session, user.id, today)
            if current is None:
                missing = [key for key in MACROS if key not in changes]
                if missing:
                    raise ToolError(
                        "there is no goal yet, so give all of calories, protein_g, carbs_g and fat_g "
                        f"(missing: {', '.join(missing)})"
                    )
                base: dict[str, Any] = {**NEW_GOAL_DEFAULTS, "workout_kcal": 0, "active_rest_kcal": 0}
            else:
                base = {
                    **{key: getattr(current, key) for key in NUTRIENTS},
                    "steps": current.steps,
                    "goal": current.goal,
                    "workout_kcal": current.workout_kcal,
                    "active_rest_kcal": current.active_rest_kcal,
                }
            values = {**base, **changes, "source": "manual"}
            goal_writes.put_goal(session, user, today, values, datetime.now(UTC))
            result = {**header, "goal": self.day_view(session, user, today)["goal"]}
            session.commit()
            return result


TOOL_SPECS: list[tuple[str, str, ToolAnnotations]] = [
    ("search_foods", "Search foods", READ),
    ("get_recent_foods", "Recent foods", READ),
    ("get_daily_macros", "Day's food log and macros", READ),
    ("get_nutrition_history", "Nutrition history", READ),
    ("log_food", "Log a food", CREATE),
    ("log_custom_food", "Log a custom food", CREATE),
    ("update_food_log", "Edit a food log entry", UPDATE),
    ("delete_food_log", "Delete a food log entry", DELETE),
    ("update_daily_goal", "Change daily goal", UPDATE),
]


def register(server: MCPServer, sessions: Callable[[], Session]) -> None:
    """Adds every tool to `server`. `sessions()` opens a database session (read when a tool runs)."""
    tools = Tools(sessions)
    for name, title, hints in TOOL_SPECS:
        server.add_tool(getattr(tools, name), name=name, title=title, annotations=hints)
