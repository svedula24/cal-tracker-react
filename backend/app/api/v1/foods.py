"""/api/v1/foods: search and look up USDA foods, and look up packaged foods by barcode."""

from __future__ import annotations

import math
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from sqlalchemy.orm import Session

from app.api.deps import CurrentUser
from app.db.session import get_session
from app.schemas.foods import (
    BarcodeFood,
    BarcodeServing,
    FoodDetail,
    FoodSearchItem,
    FoodSearchResponse,
    NutrientsPer100g,
)
from app.schemas.log_api import RecentFood, RecentFoodsResponse
from app.services import barcodes, log_queries
from app.services import foods as food_service

router = APIRouter(prefix="/api/v1/foods", tags=["foods"])

DbSession = Annotated[Session, Depends(get_session)]

# Per user (app.state.barcode_lookups): the server shares one Open Food Facts allowance (15 reads a
# minute per IP) between every user, so one user cannot spend it all. Cached answers count too.
BARCODE_LOOKUPS_PER_HOUR = 60


# Declared before /{fdc_id}, or "search" would be parsed as an id.
@router.get("/search")
def search(
    session: DbSession,
    q: Annotated[str, Query(min_length=1, max_length=100)],
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    offset: Annotated[int, Query(ge=0, le=1000)] = 0,
) -> FoodSearchResponse:
    """Foods matching q, best first: exact, starts with q, every word, then misspellings. Each with its portions."""
    if not food_service.normalize(q):
        raise HTTPException(422, "q must contain text")
    rows, portions = food_service.search_page(session, q, limit, offset)
    foods = [FoodSearchItem.model_validate({**row, "portions": portions[row["fdc_id"]]}) for row in rows]
    return FoodSearchResponse(foods=foods, limit=limit, offset=offset)


# Declared before /{fdc_id}, or "recent" would be parsed as an id. The only foods route that needs a token.
@router.get("/recent")
def recent(
    session: DbSession, user: CurrentUser, limit: Annotated[int, Query(ge=1, le=50)] = 20
) -> RecentFoodsResponse:
    """The foods this user logged last, most recent first, each once: a search item with its portions,
    plus `grams` (the amount of the latest log) and `logged_at`. Custom entries and deleted logs do not count."""
    rows, portions = log_queries.recent_foods(session, user.id, limit)
    foods = [RecentFood.model_validate({**row, "portions": portions[row["fdc_id"]]}) for row in rows]
    return RecentFoodsResponse(foods=foods)


# Declared before /{fdc_id}, or "barcode" would be parsed as an id.
@router.get("/barcode/{code}")
def barcode(
    session: DbSession, user: CurrentUser, request: Request, code: Annotated[str, Path(max_length=40)]
) -> BarcodeFood:
    """A packaged food by its barcode, from Open Food Facts (cached: app/services/barcodes.py).

    422 for a code that is not an EAN-8, UPC-A, EAN-13 or GTIN-14 with a valid check digit. 404 with
    detail {"reason": "not_found"}, or {"reason": "incomplete", "name": ...} for a product without a
    name or one of calories, protein, carbs and fat. 429 over BARCODE_LOOKUPS_PER_HOUR. 503 when Open
    Food Facts cannot answer and nothing is cached.
    """
    normalized = barcodes.normalize(code)
    if normalized is None:
        raise HTTPException(422, "code must be an 8, 12, 13 or 14-digit barcode with a valid check digit")
    wait = request.app.state.barcode_lookups.retry_after(str(user.id))
    if wait is not None:
        raise HTTPException(
            429, "too many barcode lookups, try again later", headers={"Retry-After": str(math.ceil(wait))}
        )
    try:
        product = barcodes.lookup(session, normalized, request.app.state.settings)
    except barcodes.Unavailable:
        raise HTTPException(503, "product lookup unavailable") from None
    session.commit()
    if not product.found:
        detail = {"reason": product.reason} | ({"name": product.name} if product.reason == "incomplete" else {})
        raise HTTPException(404, detail)
    serving = None
    if product.serving_label is not None and product.serving_grams is not None:
        serving = BarcodeServing(label=product.serving_label, grams=product.serving_grams)
    return BarcodeFood(
        code=product.code,
        name=product.name,
        brand=product.brand,
        nutrients_per_100g=NutrientsPer100g(
            calories=product.calories,
            protein_g=product.protein_g,
            carbs_g=product.carbs_g,
            fat_g=product.fat_g,
            fiber_g=product.fiber_g,
            sugar_g=product.sugar_g,
            sodium_mg=product.sodium_mg,
        ),
        serving=serving,
    )


@router.get("/{fdc_id}")
def get_food(session: DbSession, fdc_id: Annotated[int, Path(gt=0, le=2**63 - 1)]) -> FoodDetail:
    """One food with its nutrients per 100 g and its portions, smallest first."""
    food = food_service.get_food(session, fdc_id)
    if food is None:
        raise HTTPException(404, "food not found")
    return FoodDetail.of(food, food_service.get_portions(session, fdc_id))
