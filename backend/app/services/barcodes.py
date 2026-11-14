"""Barcode lookups through Open Food Facts (OFF), cached in barcode_products.

A code is normalised first (`normalize`): digits only, a valid GS1 check digit, and one spelling per
product (UPC-A and a GTIN-14 with a leading 0 become the EAN-13), so every spelling shares one cache
row. A found product is kept 30 days, a miss (not on OFF, or no usable nutrition) 1 day. When OFF
cannot be reached, a stale row is better than nothing; without one the lookup is `Unavailable`.

OFF allows 15 product reads a minute per IP and asks for a User-Agent naming the app
(settings.off_user_agent). Its data is under the Open Database License: credit "Open Food Facts".

Nothing here commits; the route commits once.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta

import httpx2
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.models.barcodes import BarcodeProduct
from app.settings import Settings

FOUND_FRESH = timedelta(days=30)
MISS_FRESH = timedelta(days=1)
TIMEOUT = 5.0  # seconds, for the whole OFF request
FIELDS = "code,product_name,brands,serving_size,serving_quantity,serving_quantity_unit,nutriments"
KJ_PER_KCAL = 4.184
LENGTHS = (8, 12, 13, 14)
DIGITS = frozenset("0123456789")
# A serving_size such as "52 g" or "1 bar (40g)": with no serving_quantity_unit, its quantity is grams.
GRAMS_IN_LABEL = re.compile(r"\d\s*g\b", re.IGNORECASE)


class Unavailable(Exception):
    """OFF could not answer (down, timed out, rate limited, or an unreadable reply), or the server's own
    budget of OFF calls is spent (`retry_after`: seconds until it has room again)."""

    def __init__(self, message: str = "", retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


@dataclass(frozen=True)
class Product:
    """One lookup's result, as stored in barcode_products. found = false: `reason` is 'not_found' or
    'incomplete', and only name and brand may be set. Nutrients per 100 g, sodium in mg."""

    code: str
    found: bool
    reason: str | None = None
    name: str | None = None
    brand: str | None = None
    calories: float | None = None
    protein_g: float | None = None
    carbs_g: float | None = None
    fat_g: float | None = None
    fiber_g: float | None = None
    sugar_g: float | None = None
    sodium_mg: float | None = None
    serving_label: str | None = None
    serving_grams: float | None = None


COLUMNS = tuple(f for f in Product.__dataclass_fields__)


def _check_digit_ok(digits: str) -> bool:
    """The GS1 check digit (the last one): weights 3, 1, 3, ... from the right, over the others."""
    body = digits[:-1]
    total = sum(int(d) * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(body)))
    return (10 - total % 10) % 10 == int(digits[-1])


def normalize(code: str) -> str | None:
    """The code as stored and sent to OFF, or None when it is not a GS1 barcode.

    Whitespace is dropped; then 8 (EAN-8), 12 (UPC-A), 13 (EAN-13) or 14 (GTIN-14) digits with a valid
    check digit. UPC-A becomes EAN-13 with a leading 0, and a GTIN-14 with a leading 0 drops it (the
    check digit is unchanged either way). UPC-E (the 8-digit short form of a UPC-A) is not expanded.
    """
    digits = "".join(code.split())
    if len(digits) not in LENGTHS or not set(digits) <= DIGITS or not _check_digit_ok(digits):
        return None
    if len(digits) == 12:
        return "0" + digits
    if len(digits) == 14 and digits[0] == "0":
        return digits[1:]
    return digits


def _number(value: object) -> float | None:
    """A nutriment as OFF sends it (a number or a numeric string) as a float >= 0, or None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        try:
            value = float(value.strip())
        except ValueError:
            return None
    if not isinstance(value, int | float):
        return None
    value = float(value)
    if not math.isfinite(value):
        return None
    return max(value, 0.0)


def _text(value: object) -> str | None:
    return (value.strip() or None) if isinstance(value, str) else None


def _serving(product: dict) -> tuple[str | None, float | None]:
    """(label, grams) from serving_quantity in g or ml (ml counted as g), or (None, None).

    With no serving_quantity_unit, the quantity is taken as grams when serving_size reads like grams
    ("52 g", "1 bar (40g)").
    """
    grams = _number(product.get("serving_quantity"))
    if not grams:
        return None, None
    label = _text(product.get("serving_size"))
    unit = _text(product.get("serving_quantity_unit"))
    if unit is None:
        if label is None or not GRAMS_IN_LABEL.search(label):
            return None, None
    elif unit.lower() not in ("g", "ml"):
        return None, None
    return label or f"{grams:g} g", grams


def map_product(code: str, product: object) -> Product:
    """An OFF `product` object as a Product: found when it has a name and the four main nutrients."""
    if not isinstance(product, dict):
        product = {}
    name = _text(product.get("product_name"))
    brands = product.get("brands")
    brand = _text(brands.split(",")[0]) if isinstance(brands, str) else None
    nutriments = product.get("nutriments")
    if not isinstance(nutriments, dict):
        nutriments = {}
    calories = _number(nutriments.get("energy-kcal_100g"))
    if calories is None:
        kj = _number(nutriments.get("energy-kj_100g"))
        calories = None if kj is None else round(kj / KJ_PER_KCAL, 1)
    main = {
        "calories": calories,
        "protein_g": _number(nutriments.get("proteins_100g")),
        "carbs_g": _number(nutriments.get("carbohydrates_100g")),
        "fat_g": _number(nutriments.get("fat_100g")),
    }
    if name is None or None in main.values():
        return Product(code=code, found=False, reason="incomplete", name=name, brand=brand)
    sodium_g = _number(nutriments.get("sodium_100g"))
    label, grams = _serving(product)
    return Product(
        code=code,
        found=True,
        name=name,
        brand=brand,
        **main,
        fiber_g=_number(nutriments.get("fiber_100g")),
        sugar_g=_number(nutriments.get("sugars_100g")),
        sodium_mg=None if sodium_g is None else round(sodium_g * 1000, 3),
        serving_label=label,
        serving_grams=grams,
    )


def _fetch_off(code: str, settings: Settings | None = None) -> Product:
    """GET the product from OFF (API v2) and map it. Raises Unavailable when OFF cannot answer."""
    settings = settings or Settings()
    url = f"{settings.off_base_url}/api/v2/product/{code}"
    try:
        with httpx2.Client(timeout=TIMEOUT) as http:
            response = http.get(url, params={"fields": FIELDS}, headers={"User-Agent": settings.off_user_agent})
    except httpx2.HTTPError as exc:
        raise Unavailable(f"Open Food Facts unreachable: {type(exc).__name__}") from exc
    if response.status_code == 404:
        return Product(code=code, found=False, reason="not_found")
    if response.status_code != 200:  # 5xx, or 429 when over OFF's rate limit
        raise Unavailable(f"Open Food Facts answered {response.status_code}")
    try:
        body = response.json()
    except ValueError as exc:
        raise Unavailable("Open Food Facts sent a body that is not JSON") from exc
    if not isinstance(body, dict):
        raise Unavailable("Open Food Facts sent a body that is not an object")
    if body.get("status") != 1:
        return Product(code=code, found=False, reason="not_found")
    return map_product(code, body.get("product"))


# Tests replace this.
fetch_off: Callable[[str, Settings], Product] = _fetch_off


def _of_row(row: BarcodeProduct) -> Product:
    return Product(**{column: getattr(row, column) for column in COLUMNS})


def lookup(
    session: Session,
    code: str,
    settings: Settings,
    now: datetime | None = None,
    fetch: Callable[[str, Settings], Product] | None = None,
    budget: Callable[[], float | None] | None = None,
) -> Product:
    """The product for a normalised `code`: the cached row while fresh, else OFF's answer (stored).

    OFF unavailable: the stale row if there is one, else Unavailable. Ends the session's read
    transaction before calling OFF, so no pooled connection is held for up to TIMEOUT; the caller must
    have nothing pending in it. Upserts (a concurrent lookup of the same code just overwrites).
    `budget`, asked only when OFF would be called: None when a call fits, else the seconds to wait; a
    spent budget is treated like OFF being unavailable (the stale row, else Unavailable).
    """
    now = now or datetime.now(UTC)
    row = session.get(BarcodeProduct, code)
    if row is not None and now - row.fetched_at < (FOUND_FRESH if row.found else MISS_FRESH):
        return _of_row(row)
    stale = None if row is None else _of_row(row)
    session.rollback()  # nothing was written: this only returns the connection to the pool
    try:
        wait = budget() if budget is not None else None
        if wait is not None:
            raise Unavailable("over the server's Open Food Facts budget", retry_after=wait)
        product = (fetch or fetch_off)(code, settings)
    except Unavailable:
        if stale is None:
            raise
        return stale
    product = replace(product, code=code)
    values = {column: getattr(product, column) for column in COLUMNS} | {"fetched_at": now}
    statement = insert(BarcodeProduct).values(values)
    session.execute(
        statement.on_conflict_do_update(
            index_elements=[BarcodeProduct.code],
            set_={column: statement.excluded[column] for column in values if column != "code"},
        )
    )
    return product
