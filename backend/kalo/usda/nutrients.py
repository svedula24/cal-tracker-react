"""Pure mapping from a USDA FoodData Central food record to one `foods` row.

All three generic datasets (Foundation, SR Legacy, FNDDS) report nutrients per
100 g, so the normalization is choosing the right nutrient record for each
column and keeping what the source does not report as None (NULL), never 0.
A reported negative value is 0 (same as scripts/usda/map.mjs, the app's mapper).
"""

from __future__ import annotations

import math
from dataclasses import astuple, dataclass, fields
from typing import Any

KCAL_PER_KJ = 1 / 4.184

# (nutrient id, unit the record must carry), in order of preference.
# Energy: 1008 "Energy" in kcal, which SR Legacy and FNDDS report. Foundation
# foods often report only the Atwater values; Specific Factors is USDA's more
# accurate figure, General Factors the fallback. kJ (1062) alone is rare and is
# converted.
ENERGY = ((1008, "KCAL"), (2048, "KCAL"), (2047, "KCAL"), (1062, "kJ"))
PROTEIN = ((1003, "G"),)
CARBS = ((1005, "G"),)  # carbohydrate, by difference
FAT = ((1004, "G"),)

DATA_TYPES = ("Foundation", "SR Legacy", "Survey (FNDDS)")


class RecordError(ValueError):
    """One USDA record cannot be mapped to a row. The loader collects these and reports them all."""

    def __init__(self, fdc_id: int | str, message: str) -> None:
        # fdc_id is the record's id, or "record #N" (its position) when the id itself is missing or invalid.
        super().__init__(f"fdc_id {fdc_id}: {message}")
        self.fdc_id = fdc_id
        self.message = message


class UnitMismatch(RecordError):
    """A nutrient record carries a unit other than the one its id is defined in."""


@dataclass(frozen=True)
class FoodRow:
    fdc_id: int
    description: str
    data_type: str
    brand_name: str | None
    calories_per_100g: float | None
    protein_per_100g: float | None
    carbs_per_100g: float | None
    fat_per_100g: float | None

    @classmethod
    def columns(cls) -> tuple[str, ...]:
        return tuple(f.name for f in fields(cls))

    def values(self) -> tuple[Any, ...]:
        return astuple(self)


def _amounts(record: dict[str, Any]) -> dict[int, tuple[float, str]]:
    """nutrient id → (amount, unit) for every nutrient the record reports a number for."""
    out: dict[int, tuple[float, str]] = {}
    for item in record.get("foodNutrients") or ():
        nutrient = item.get("nutrient") or {}
        nutrient_id = nutrient.get("id")
        amount = item.get("amount")
        if not isinstance(nutrient_id, int) or isinstance(amount, bool) or not isinstance(amount, int | float):
            continue  # no id, or no numeric amount: not reported
        if not math.isfinite(amount):
            continue  # json.load accepts NaN/Infinity; neither is a measurement
        out[nutrient_id] = (float(amount), str(nutrient.get("unitName") or ""))
    return out


def pick(amounts: dict[int, tuple[float, str]], candidates: tuple[tuple[int, str], ...], fdc_id: int) -> float | None:
    """The first candidate the record reports in the expected unit, converted to the column's unit.

    None when it reports none. A candidate in the wrong unit is skipped when a later one is usable
    (one odd record must not block a whole release); it is an error only when nothing else is.
    """
    mismatch: UnitMismatch | None = None
    for nutrient_id, unit in candidates:
        if nutrient_id not in amounts:
            continue
        amount, got = amounts[nutrient_id]
        if got.casefold() != unit.casefold():  # datasets differ in case: "KCAL" (SR Legacy), "kcal" (Foundation)
            mismatch = mismatch or UnitMismatch(fdc_id, f"nutrient {nutrient_id} is in {got!r}, expected {unit!r}")
            continue
        value = amount * KCAL_PER_KJ if unit == "kJ" else amount
        # USDA's "carbohydrate by difference" can come out slightly negative; it is 0, as in the app's mapper.
        return max(0.0, value)
    if mismatch:
        raise mismatch
    return None


def to_row(record: dict[str, Any], index: int | None = None) -> FoodRow:
    """The row for a record. A malformed field raises RecordError; `index` names the record if its id is unusable."""
    where = f"record #{index}" if index is not None else "record"
    if not isinstance(record, dict):
        raise RecordError(where, "not an object")
    fdc_id = record.get("fdcId")
    if isinstance(fdc_id, bool) or not isinstance(fdc_id, int):
        raise RecordError(where, f"missing or invalid fdcId {fdc_id!r}")
    data_type = record.get("dataType")
    if data_type not in DATA_TYPES:
        raise RecordError(fdc_id, f"unknown dataType {data_type!r}")
    description = " ".join(str(record.get("description") or "").split())
    if not description:
        raise RecordError(fdc_id, "empty description")
    amounts = _amounts(record)
    return FoodRow(
        fdc_id=fdc_id,
        description=description,
        data_type=data_type,
        brand_name=(record.get("brandName") or None),
        calories_per_100g=pick(amounts, ENERGY, fdc_id),
        protein_per_100g=pick(amounts, PROTEIN, fdc_id),
        carbs_per_100g=pick(amounts, CARBS, fdc_id),
        fat_per_100g=pick(amounts, FAT, fdc_id),
    )
