"""/api/v1/foods: search and look up USDA foods."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from pydantic import BaseModel

from . import search as food_search

router = APIRouter(prefix="/api/v1/foods", tags=["foods"])


class FoodSummary(BaseModel):
    fdc_id: int
    description: str
    data_type: str
    brand_name: str | None
    calories_per_100g: float


class Food(FoodSummary):
    protein_per_100g: float
    carbs_per_100g: float
    fat_per_100g: float


class SearchResults(BaseModel):
    results: list[FoodSummary]


def connection(request: Request) -> Iterator[psycopg.Connection]:
    """A connection from the app's pool, returned to it after the request."""
    with request.app.state.pool.connection() as conn:
        yield conn


Conn = Annotated[psycopg.Connection, Depends(connection)]


@router.get("/search")
def search(
    conn: Conn,
    q: Annotated[str, Query(min_length=1, max_length=100)],
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> SearchResults:
    """Foods matching q, best first: exact, starts with q, every word, then misspellings."""
    if not food_search.normalize(q):
        raise HTTPException(422, "q must contain text")
    return SearchResults(results=food_search.search(conn, q, limit))


@router.get("/{fdc_id}")
def get_food(conn: Conn, fdc_id: Annotated[int, Path(gt=0, le=2**63 - 1)]) -> Food:
    """One food with its macros per 100 g."""
    food = food_search.get_food(conn, fdc_id)
    if food is None:
        raise HTTPException(404, "food not found")
    return Food(**food)
