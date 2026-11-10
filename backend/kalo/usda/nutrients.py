"""Pure mapping from a USDA FoodData Central food record to one `foods` row.

All three generic datasets (Foundation, SR Legacy, FNDDS) report nutrients per
100 g, so the normalization is choosing the right nutrient record for each
column and keeping what the source does not report as None (NULL), never 0.
"""

from __future__ import annotations

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
CARBS = ((1005, "G"),)  # carbohydrate, by difference: stored as reported
FAT = ((1004, "G"),)

DATA_TYPES = ("Foundation", "SR Legacy", "Survey (FNDDS)")


class RecordError(ValueError):
    """One USDA record cannot be mapped to a row. The loader collects these and reports them all."""

    def __init__(self, fdc_id: int, message: str) -> None:
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
        if nutrient_id is None or isinstance(amount, bool) or not isinstance(amount, int | float):
            continue
        out[int(nutrient_id)] = (float(amount), str(nutrient.get("unitName") or ""))
    return out


def pick(amounts: dict[int, tuple[float, str]], candidates: tuple[tuple[int, str], ...], fdc_id: int) -> float | None:
    """The first candidate the record reports, converted to the column's unit; None when it reports none."""
    for nutrient_id, unit in candidates:
        if nutrient_id not in amounts:
            continue
        amount, got = amounts[nutrient_id]
        if got.casefold() != unit.casefold():  # datasets differ in case: "KCAL" (SR Legacy), "kcal" (Foundation)
            raise UnitMismatch(fdc_id, f"nutrient {nutrient_id} is in {got!r}, expected {unit!r}")
        return amount * KCAL_PER_KJ if unit == "kJ" else amount
    return None


def to_row(record: dict[str, Any]) -> FoodRow:
    fdc_id = int(record["fdcId"])
    data_type = record["dataType"]
    if data_type not in DATA_TYPES:
        raise RecordError(fdc_id, f"unknown dataType {data_type!r}")
    description = " ".join(str(record["description"]).split())
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
