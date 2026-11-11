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
    macros = [(1008, 89, "KCAL"), (1003, 1.09, "G"), (1005, 22.84, "G"), (1004, 0.33, "G")]
    row = to_row(record(nutrients=[*macros, (1079, 2.6, "G"), (2000, 12.23, "G"), (1093, 1, "MG")]))
    assert row == FoodRow(1, "Banana, raw", "SR Legacy", None, 89.0, 1.09, 22.84, 0.33, 2.6, 12.23, 1.0)
    assert row.values() == (1, "Banana, raw", "SR Legacy", None, 89.0, 1.09, 22.84, 0.33, 2.6, 12.23, 1.0)
    assert FoodRow.columns() == (
        "fdc_id",
        "description",
        "data_type",
        "brand_name",
        "calories_per_100g",
        "protein_per_100g",
        "carbs_per_100g",
        "fat_per_100g",
        "fiber_per_100g",
        "sugar_per_100g",
        "sodium_mg_per_100g",
    )


def test_sugar_prefers_2000_and_falls_back_to_1063():
    assert to_row(record(nutrients=[(1063, 15.8, "G"), (2000, 12.2, "G")])).sugar_per_100g == 12.2
    assert to_row(record(data_type="Foundation", nutrients=[(1063, 15.8, "g")])).sugar_per_100g == 15.8


def test_fiber_sugar_and_sodium_are_optional_and_never_negative():
    macros = [(1008, 89, "KCAL"), (1003, 1.09, "G"), (1005, 22.84, "G"), (1004, 0.33, "G")]
    row = to_row(record(nutrients=macros))
    assert (row.fiber_per_100g, row.sugar_per_100g, row.sodium_mg_per_100g) == (None, None, None)
    assert row.complete  # only calories, protein, carbs and fat are required
    row = to_row(record(nutrients=[(1079, -0.1, "G"), (2000, -2, "G"), (1093, -5, "MG")]))
    assert (row.fiber_per_100g, row.sugar_per_100g, row.sodium_mg_per_100g) == (0.0, 0.0, 0.0)
    row = to_row(record(nutrients=[(1079, 0, "G"), (1093, 0, "mg")]))
    assert (row.fiber_per_100g, row.sugar_per_100g, row.sodium_mg_per_100g) == (0.0, None, 0.0)  # a reported 0 stays 0


def test_sodium_or_fiber_in_the_wrong_unit_fails_loudly():
    with pytest.raises(UnitMismatch, match="nutrient 1093 is in 'G', expected 'MG'"):
        to_row(record(nutrients=[(1093, 0.001, "G")]))
    with pytest.raises(UnitMismatch, match="nutrient 1079 is in 'MG', expected 'G'"):
        to_row(record(nutrients=[(1079, 2600, "MG")]))
    # Sugar 2000 in the wrong unit is skipped when 1063 is usable.
    assert to_row(record(nutrients=[(2000, 12200, "MG"), (1063, 12.2, "G")])).sugar_per_100g == 12.2


def test_energy_prefers_kcal_then_atwater_specific_then_general():
    both = [(2047, 380.0, "KCAL"), (2048, 375.0, "KCAL")]
    assert to_row(record(data_type="Foundation", nutrients=[(1008, 370.0, "KCAL"), *both])).calories_per_100g == 370.0
    assert to_row(record(data_type="Foundation", nutrients=both)).calories_per_100g == 375.0  # Specific over General
    assert to_row(record(data_type="Foundation", nutrients=[(2047, 380.0, "KCAL")])).calories_per_100g == 380.0


def test_wrong_unit_falls_through_to_the_next_energy_candidate():
    # 1008 reported in kJ is skipped when an Atwater value is usable; a lone wrong unit is still an error.
    row = to_row(record(nutrients=[(1008, 1548.0, "kJ"), (2048, 370.0, "KCAL")]))
    assert row.calories_per_100g == 370.0
    with pytest.raises(UnitMismatch, match="nutrient 1008 is in 'kJ'"):
        to_row(record(nutrients=[(1008, 1548.0, "kJ")]))


def test_non_finite_amounts_are_not_reported():
    row = to_row(record(nutrients=[(1003, float("inf"), "G"), (1004, float("nan"), "G"), (1005, 1.0, "G")]))
    assert (row.protein_per_100g, row.fat_per_100g, row.carbs_per_100g) == (None, None, 1.0)


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


def test_negative_carbs_by_difference_is_zero_like_the_app_mapper():
    row = to_row(record(nutrients=[(1005, -0.2, "G"), (1004, 0.0, "G")]))
    assert row.carbs_per_100g == 0.0
    assert row.fat_per_100g == 0.0  # a reported 0 stays 0
    assert row.protein_per_100g is None  # not reported stays NULL


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
