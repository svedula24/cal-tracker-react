"""Mapping of USDA records to `foods` rows (kalo/usda/nutrients.py). Run: uv run pytest"""

import pytest

from kalo.usda.nutrients import KCAL_PER_KJ, FoodRow, RecordError, UnitMismatch, to_row


def record(fdc_id=1, data_type="SR Legacy", description="Banana, raw", nutrients=(), brand=None):
    """A USDA food record with nutrients given as (id, amount, unit)."""
    rec = {
        "fdcId": fdc_id,
        "dataType": data_type,
        "description": description,
        "foodNutrients": [
            {"nutrient": {"id": nid, "unitName": unit}, "amount": amount} for nid, amount, unit in nutrients
        ],
    }
    if brand is not None:
        rec["brandName"] = brand
    return rec


def test_sr_legacy_record_maps_every_column():
    row = to_row(record(nutrients=[(1008, 89, "KCAL"), (1003, 1.09, "G"), (1005, 22.84, "G"), (1004, 0.33, "G")]))
    assert row == FoodRow(1, "Banana, raw", "SR Legacy", None, 89.0, 1.09, 22.84, 0.33)
    assert row.values() == (1, "Banana, raw", "SR Legacy", None, 89.0, 1.09, 22.84, 0.33)


def test_energy_prefers_kcal_then_atwater_specific_then_general():
    both = [(2047, 380.0, "KCAL"), (2048, 375.0, "KCAL")]
    assert to_row(record(data_type="Foundation", nutrients=[(1008, 370.0, "KCAL"), *both])).calories_per_100g == 370.0
    assert to_row(record(data_type="Foundation", nutrients=both)).calories_per_100g == 375.0  # Specific over General
    assert to_row(record(data_type="Foundation", nutrients=[(2047, 380.0, "KCAL")])).calories_per_100g == 380.0


def test_energy_in_kj_alone_is_converted():
    row = to_row(record(nutrients=[(1062, 418.4, "kJ")]))
    assert row.calories_per_100g == pytest.approx(418.4 * KCAL_PER_KJ) == pytest.approx(100.0)


def test_missing_nutrients_are_none_not_zero():
    row = to_row(record(nutrients=[(1003, 2.0, "G")]))
    assert row.protein_per_100g == 2.0
    assert row.calories_per_100g is None
    assert row.carbs_per_100g is None
    assert row.fat_per_100g is None
    # A record without an amount, or with a non-numeric one, is "not reported".
    rec = record(nutrients=[(1004, 5.0, "G")])
    del rec["foodNutrients"][0]["amount"]
    assert to_row(rec).fat_per_100g is None
    rec = record(nutrients=[(1004, "n/a", "G")])
    assert to_row(rec).fat_per_100g is None


def test_carbs_by_difference_kept_as_reported():
    assert to_row(record(nutrients=[(1005, -0.2, "G")])).carbs_per_100g == -0.2


def test_unit_case_differs_between_datasets():
    row = to_row(record(data_type="Foundation", nutrients=[(1008, 52.0, "kcal"), (1003, 0.3, "g")]))
    assert (row.calories_per_100g, row.protein_per_100g) == (52.0, 0.3)


def test_unit_mismatch_fails_loudly():
    with pytest.raises(UnitMismatch, match="nutrient 1008 is in 'kJ', expected 'KCAL'"):
        to_row(record(nutrients=[(1008, 372.0, "kJ")]))
    with pytest.raises(UnitMismatch):
        to_row(record(nutrients=[(1003, 1.0, "MG")]))


def test_description_whitespace_is_collapsed_and_brand_kept():
    row = to_row(record(description="  Yogurt,  Greek,\nplain ", brand="Acme"))
    assert row.description == "Yogurt, Greek, plain"
    assert row.brand_name == "Acme"
    assert to_row(record(brand="")).brand_name is None


def test_malformed_records_are_record_errors_not_crashes():
    # Every malformed field is reported as a RecordError so the loader can list them all.
    for rec, pattern in [
        ({"dataType": "SR Legacy", "description": "X"}, "record #7: missing or invalid fdcId None"),
        ({"fdcId": "abc", "dataType": "SR Legacy", "description": "X"}, "record #7: missing or invalid fdcId 'abc'"),
        ({"fdcId": 5, "description": "X"}, "fdc_id 5: unknown dataType None"),
        ({"fdcId": 5, "dataType": "SR Legacy"}, "fdc_id 5: empty description"),
        ("not a record", "record #7: not an object"),
    ]:
        with pytest.raises(RecordError, match=pattern):
            to_row(rec, 7)
    # Nutrient items with a missing id or amount are "not reported", not errors.
    rec = record(nutrients=[(1003, 1.0, "G")])
    rec["foodNutrients"].append({"nutrient": {"unitName": "G"}, "amount": 2.0})
    rec["foodNutrients"].append({"nutrient": {"id": "1004"}, "amount": 3.0})
    assert to_row(rec).protein_per_100g == 1.0


def test_unknown_data_type_and_empty_description_are_rejected():
    with pytest.raises(ValueError, match="unknown dataType"):
        to_row(record(data_type="Branded"))
    with pytest.raises(ValueError, match="empty description"):
        to_row(record(description="   "))
