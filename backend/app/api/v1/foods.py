"""/api/v1/foods: search and look up USDA foods."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from app.db.session import get_session
from app.schemas.foods import FoodDetail, FoodSearchItem, FoodSearchResponse
from app.services import foods as food_service

router = APIRouter(prefix="/api/v1/foods", tags=["foods"])

DbSession = Annotated[Session, Depends(get_session)]


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


@router.get("/{fdc_id}")
def get_food(session: DbSession, fdc_id: Annotated[int, Path(gt=0, le=2**63 - 1)]) -> FoodDetail:
    """One food with its nutrients per 100 g and its portions, smallest first."""
    food = food_service.get_food(session, fdc_id)
    if food is None:
        raise HTTPException(404, "food not found")
    return FoodDetail.of(food, food_service.get_portions(session, fdc_id))
