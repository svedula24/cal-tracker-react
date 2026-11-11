"""The loader's row collection (kalo/usda/load.py): bad records are all reported and nothing is loaded."""

import pytest

from kalo.usda import load
from kalo.usda.datasets import Dataset
from kalo.usda.portions import Portion


def record(fdc_id, data_type="SR Legacy", nutrients=(), portions=()):
    """A USDA food record with nutrients given as (id, amount, unit) and portions as (modifier, grams)."""
    return {
        "foodPortions": [{"amount": 1, "modifier": modifier, "gramWeight": grams} for modifier, grams in portions],
        "fdcId": fdc_id,
        "dataType": data_type,
        "description": "Banana, raw",
        "foodNutrients": [
            {"nutrient": {"id": nid, "unitName": unit}, "amount": amount} for nid, amount, unit in nutrients
        ],
    }


MACROS = [(1003, 1.09, "G"), (1005, 22.84, "G"), (1004, 0.33, "G")]
GOOD = record(fdc_id=1, nutrients=[(1008, 89, "KCAL"), *MACROS])
WRONG_UNIT = record(fdc_id=22, nutrients=[(1008, 372.0, "kJ")])
UNKNOWN_TYPE = record(fdc_id=333, data_type="Branded")


def test_every_bad_record_is_reported_and_nothing_is_returned(monkeypatch, capsys):
    monkeypatch.setattr(load, "DATASETS", (Dataset("FoodData_Central_fake_2099-01-01", "Fake", "0" * 64),))
    monkeypatch.setattr(load, "records", lambda dataset: [GOOD, WRONG_UNIT, UNKNOWN_TYPE])

    with pytest.raises(SystemExit, match=r"^2 records could not be mapped; nothing loaded$"):
        load.read_rows()

    captured = capsys.readouterr()
    assert "fake_2099-01-01:" in captured.err
    assert "fdc_id 22: nutrient 1008 is in 'kJ', expected 'KCAL'" in captured.err
    assert "fdc_id 333: unknown dataType 'Branded'" in captured.err
    assert "3 foods, 2 could not be mapped" in captured.out


def test_clean_datasets_still_skip_duplicate_fdc_ids(monkeypatch, capsys):
    datasets = (Dataset("FoodData_Central_a_2099", "A", "0" * 64), Dataset("FoodData_Central_b_2099", "B", "0" * 64))
    monkeypatch.setattr(load, "DATASETS", datasets)
    apple = record(fdc_id=2, nutrients=[(1008, 52, "KCAL"), *MACROS])
    monkeypatch.setattr(load, "records", lambda dataset: [GOOD, apple])

    rows, portions = load.read_rows()

    assert [row.fdc_id for row in rows] == [1, 2]
    assert portions == []
    assert "b_2099: 2 foods, 2 duplicate fdc_ids skipped" in capsys.readouterr().out


def test_portions_are_returned_for_kept_foods_only(monkeypatch):
    datasets = (Dataset("FoodData_Central_a_2099", "A", "0" * 64), Dataset("FoodData_Central_b_2099", "B", "0" * 64))
    monkeypatch.setattr(load, "DATASETS", datasets)
    complete = [(1008, 89, "KCAL"), *MACROS]
    banana = record(fdc_id=1, nutrients=complete, portions=[("cup, sliced", 150), ("small", 101)])
    no_portions = record(fdc_id=2, nutrients=complete)
    incomplete = record(fdc_id=3, nutrients=MACROS, portions=[("cup", 240)])  # no calories: skipped
    duplicate = record(fdc_id=1, nutrients=complete, portions=[("large", 136)])  # in the second dataset
    by_dataset = {"A": [banana, no_portions, incomplete], "B": [duplicate]}
    monkeypatch.setattr(load, "records", lambda dataset: by_dataset[dataset.key])

    rows, portions = load.read_rows()

    assert [row.fdc_id for row in rows] == [1, 2]
    assert portions == [Portion(1, "1 cup, sliced", 150.0), Portion(1, "1 small", 101.0)]


def test_a_bad_record_refuses_the_load_even_when_others_have_portions(monkeypatch):
    monkeypatch.setattr(load, "DATASETS", (Dataset("FoodData_Central_fake_2099-01-01", "Fake", "0" * 64),))
    good = record(fdc_id=1, nutrients=[(1008, 89, "KCAL"), *MACROS], portions=[("small", 101)])
    monkeypatch.setattr(load, "records", lambda dataset: [good, UNKNOWN_TYPE])
    with pytest.raises(SystemExit, match="nothing loaded"):
        load.read_rows()


def test_foods_missing_calories_or_a_macro_are_skipped(monkeypatch, capsys):
    monkeypatch.setattr(load, "DATASETS", (Dataset("FoodData_Central_fake_2099-01-01", "Fake", "0" * 64),))
    no_fat = record(fdc_id=2, nutrients=[(1008, 89, "KCAL"), *MACROS[:2]])
    no_energy = record(fdc_id=3, nutrients=MACROS)
    zero_fat = record(fdc_id=4, nutrients=[(1008, 89, "KCAL"), *MACROS[:2], (1004, 0, "G")])
    monkeypatch.setattr(load, "records", lambda dataset: [GOOD, no_fat, no_energy, record(fdc_id=5), zero_fat])

    rows, portions = load.read_rows()

    assert portions == []
    assert [row.fdc_id for row in rows] == [1, 4]  # a reported 0 is kept; only a missing value skips
    assert "5 foods, 3 without calories, protein, carbs and fat skipped" in capsys.readouterr().out
