"""The loader's row collection (kalo/usda/load.py): bad records are all reported and nothing is loaded."""

import pytest

from kalo.usda import load
from kalo.usda.datasets import Dataset


def record(fdc_id, data_type="SR Legacy", nutrients=()):
    """A USDA food record with nutrients given as (id, amount, unit)."""
    return {
        "fdcId": fdc_id,
        "dataType": data_type,
        "description": "Banana, raw",
        "foodNutrients": [
            {"nutrient": {"id": nid, "unitName": unit}, "amount": amount} for nid, amount, unit in nutrients
        ],
    }


GOOD = record(fdc_id=1, nutrients=[(1008, 89, "KCAL")])
WRONG_UNIT = record(fdc_id=22, nutrients=[(1008, 372.0, "kJ")])
UNKNOWN_TYPE = record(fdc_id=333, data_type="Branded")


def test_every_bad_record_is_reported_and_nothing_is_returned(monkeypatch, capsys):
    monkeypatch.setattr(load, "DATASETS", (Dataset("FoodData_Central_fake_2099-01-01", "Fake"),))
    monkeypatch.setattr(load, "records", lambda dataset: [GOOD, WRONG_UNIT, UNKNOWN_TYPE])

    with pytest.raises(SystemExit, match=r"^2 records could not be mapped; nothing loaded$"):
        load.read_rows()

    captured = capsys.readouterr()
    assert "fake_2099-01-01:" in captured.err
    assert "fdc_id 22: nutrient 1008 is in 'kJ', expected 'KCAL'" in captured.err
    assert "fdc_id 333: unknown dataType 'Branded'" in captured.err
    assert "3 foods, 2 could not be mapped" in captured.out


def test_clean_datasets_still_skip_duplicate_fdc_ids(monkeypatch, capsys):
    datasets = (Dataset("FoodData_Central_a_2099", "A"), Dataset("FoodData_Central_b_2099", "B"))
    monkeypatch.setattr(load, "DATASETS", datasets)
    monkeypatch.setattr(load, "records", lambda dataset: [GOOD, record(fdc_id=2)])

    rows = load.read_rows()

    assert [row.fdc_id for row in rows] == [1, 2]
    assert "b_2099: 2 foods, 2 duplicate fdc_ids skipped" in capsys.readouterr().out
