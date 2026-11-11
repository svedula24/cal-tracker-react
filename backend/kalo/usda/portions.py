"""Pure mapping from a USDA FoodData Central food record to its `food_portions` rows.

The label rules are those of `portionsOf` in scripts/usda/map.mjs (the app's mapper), so the API
and the bundled list name a portion the same way. Not ported, because they are the client's
choices: putting a default first, the list of poor defaults, the cap of 8, and gram rounding
(the raw gram weight is stored). A portion that cannot be used is skipped, never an error.
"""

from __future__ import annotations

import math
import re
from dataclasses import astuple, dataclass, fields
from typing import Any

NO_SEQUENCE = 99  # portions without a sequenceNumber sort last
SKIP_UNITS = frozenset({"RACC", "undetermined"})  # RACC: skip the portion; undetermined: SR Legacy, no unit

_UNSPECIFIED = re.compile(r"quantity not specified", re.IGNORECASE)
_FROM_REF = re.compile(r"\s+From [0-9]+\Z", re.IGNORECASE)  # internal "From 19191" references
_DIGITS = re.compile(r"[0-9]+")
_LEADING_ONE = re.compile(r"^1 (?=[^0-9])")


@dataclass(frozen=True)
class Portion:
    fdc_id: int
    description: str
    gram_weight: float

    @classmethod
    def columns(cls) -> tuple[str, ...]:
        return tuple(f.name for f in fields(cls))

    def values(self) -> tuple[Any, ...]:
        return astuple(self)


def _number(value: Any) -> float | None:
    """The value as a float when it is a real, finite number (a bool is not one)."""
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        return None
    return float(value)


def _quantity(portion: dict[str, Any]) -> str:
    """`value` (Foundation), else `amount` (SR Legacy), else 1; "" for 0, which the label leaves out."""
    quantity = portion.get("value")
    if quantity is None:
        quantity = portion.get("amount")
    if quantity is None:
        quantity = 1
    if isinstance(quantity, str):
        return quantity
    number = _number(quantity)
    if not number:  # 0, or not a number
        return ""
    return str(int(number)) if number.is_integer() else repr(number)  # 1.0 → "1", 0.5 → "0.5"


def _label(portion: dict[str, Any]) -> str | None:
    """The portion's display label before whitespace cleanup; None when the portion is one to skip."""
    described = portion.get("portionDescription")
    if described:  # FNDDS: "1 banana split"
        described = str(described)
        return None if _UNSPECIFIED.search(described) else described  # the catch-all is not a portion
    # Foundation: value + unit + modifier ("1 banana (Peeled)"); SR Legacy: amount + modifier ("1 cup, sliced").
    measure = portion.get("measureUnit")
    name = measure.get("name") if isinstance(measure, dict) else None
    if name == "RACC":
        return None
    unit = name.lower() if isinstance(name, str) and name not in SKIP_UNITS else ""
    modifier = _FROM_REF.sub("", str(portion.get("modifier") or "")).strip()
    parts = (_quantity(portion), unit, f"({modifier})" if modifier and unit else modifier)
    return " ".join(part for part in parts if part)


def portions_of(record: dict[str, Any], fdc_id: int) -> list[Portion]:
    """The food's usable portions in USDA's order (`sequenceNumber`), labels cleaned and de-duplicated."""
    found = record.get("foodPortions")
    usable = [p for p in found if isinstance(p, dict)] if isinstance(found, list) else []

    def sequence(portion: dict[str, Any]) -> float:
        number = _number(portion.get("sequenceNumber"))
        return NO_SEQUENCE if number is None else number

    out: list[Portion] = []
    seen: set[str] = set()
    for portion in sorted(usable, key=sequence):  # stable: ties keep the record's order
        grams = _number(portion.get("gramWeight"))
        if grams is None or grams <= 0:
            continue
        label = _label(portion)
        if label is None:
            continue
        label = re.sub(r"\s+,", ",", " ".join(label.split()))
        # De-duplicate as a client shows them: "package" and "1 package" are one, as are "tbsp" and "TBSP".
        key = _LEADING_ONE.sub("", label).lower()
        if not label or _DIGITS.fullmatch(label) or key in seen:
            continue
        seen.add(key)
        out.append(Portion(fdc_id, label, grams))
    return out
