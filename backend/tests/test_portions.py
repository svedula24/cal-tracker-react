"""Mapping of USDA records to `food_portions` rows (kalo/usda/portions.py). Run: uv run pytest

The label cases mirror tests/usdaMap.test.mjs (the app's mapper), minus what is not ported:
default-first, the poor-default list, the cap of 8 and gram rounding.
"""

from kalo.usda.portions import Portion, portions_of


def sr(amount, modifier, grams, **extra):
    """An SR Legacy portion: amount + modifier, unit "undetermined"."""
    return {
        "amount": amount,
        "modifier": modifier,
        "gramWeight": grams,
        "measureUnit": {"name": "undetermined"},
        **extra,
    }


def labels(*portions):
    return [p.description for p in portions_of({"foodPortions": list(portions)}, 1)]


def test_sr_legacy_labels_in_usda_order_deduplicated_ignoring_case():
    honey = {"foodPortions": [sr(1, "cup", 339), sr(1, "tbsp", 21), sr(1, "packet (0.5 oz)", 14), sr(1, "TBSP", 22)]}
    assert portions_of(honey, 169640) == [
        Portion(169640, "1 cup", 339.0),  # no default-first: the cup stays where USDA put it
        Portion(169640, "1 tbsp", 21.0),  # the first of "tbsp"/"TBSP" wins
        Portion(169640, "1 packet (0.5 oz)", 14.0),
    ]
    assert Portion.columns() == ("fdc_id", "description", "gram_weight")
    assert Portion(1, "1 cup", 339.0).values() == (1, "1 cup", 339.0)


def test_foundation_labels_are_quantity_unit_modifier_and_racc_is_skipped():
    record = {
        "foodPortions": [
            {"value": 1, "measureUnit": {"name": "RACC"}, "gramWeight": 100},
            {"value": 1, "measureUnit": {"name": "Banana"}, "modifier": "Peeled", "gramWeight": 110},
            {"value": 2, "measureUnit": {"name": "Tablespoon"}, "gramWeight": 32},
        ]
    }
    assert portions_of(record, 7) == [Portion(7, "1 banana (Peeled)", 110.0), Portion(7, "2 tablespoon", 32.0)]


def test_fndds_uses_the_portion_description_and_skips_quantity_not_specified():
    assert labels(
        {"portionDescription": "Quantity not specified", "gramWeight": 100},
        {"portionDescription": "QUANTITY NOT SPECIFIED", "gramWeight": 100},
        {"portionDescription": "1 banana split", "gramWeight": 490},
    ) == ["1 banana split"]


def test_internal_from_references_are_dropped():
    assert labels(sr(0.5, "cup From 19191", 147)) == ["0.5 cup"]
    assert labels(sr(1, "cup from 19191", 147)) == ["1 cup"]
    assert labels(sr(1, "slice From concentrate", 10)) == ["1 slice From concentrate"]  # only a trailing number


def test_a_record_without_portions_has_none():
    assert portions_of({}, 1) == []
    assert portions_of({"foodPortions": None}, 1) == []
    assert portions_of({"foodPortions": []}, 1) == []
    assert portions_of({"foodPortions": ["cup", None, 3]}, 1) == []  # not portion objects: skipped, not an error


def test_labels_that_differ_only_by_a_leading_one_are_one_portion():
    assert labels(sr(1, "package (10 oz)", 284), {"portionDescription": "package (10 oz)", "gramWeight": 284}) == [
        "1 package (10 oz)"
    ]
    assert labels({"portionDescription": "package", "gramWeight": 284}, sr(1, "package", 300)) == ["package"]
    assert labels(sr(1, "0 g pack", 5), sr(1, "pack", 6), {"portionDescription": "10 g pack", "gramWeight": 10}) == [
        "1 0 g pack",  # "1 " before a digit is not a quantity prefix
        "1 pack",
        "10 g pack",
    ]


def test_whitespace_is_collapsed_and_spaces_before_commas_removed():
    assert portions_of({"foodPortions": [sr(1, "spray , about  1/3 second", 0.25)]}, 9) == [
        Portion(9, "1 spray, about 1/3 second", 0.25)
    ]
    assert labels({"portionDescription": "  1 cup,\n sliced ", "gramWeight": 150}) == ["1 cup, sliced"]


def test_every_usable_portion_is_kept_no_cap():
    many = [sr(1, f"portion {i}", 50 + i) for i in range(12)]
    assert labels(*many) == [f"1 portion {i}" for i in range(12)]


def test_poor_defaults_are_kept_in_place():
    # The app's mapper moves these behind a better default; here they are ordinary portions.
    assert labels(sr(1, "Guideline amount per cup of hot cereal", 61), sr(1, "cup", 244), sr(1, "fl oz", 30.5)) == [
        "1 Guideline amount per cup of hot cereal",
        "1 cup",
        "1 fl oz",
    ]


def test_empty_and_digits_only_labels_are_skipped():
    assert labels(sr(1, "", 100), sr(1, None, 100), sr(250, "", 250), sr(1, "   ", 5)) == []
    assert labels({"portionDescription": "100", "gramWeight": 100}, sr(1, "slice", 28)) == ["1 slice"]


def test_value_wins_over_amount_and_the_default_quantity_is_one():
    assert labels({"value": 2, "amount": 1, "measureUnit": {"name": "cup"}, "gramWeight": 480}) == ["2 cup"]
    assert labels({"value": 0.5, "amount": 3, "modifier": "cup", "gramWeight": 120}) == ["0.5 cup"]
    assert labels({"value": None, "amount": 3, "modifier": "cup", "gramWeight": 720}) == ["3 cup"]
    assert labels({"modifier": "slice", "gramWeight": 28}) == ["1 slice"]
    assert labels({"measureUnit": {"name": "Cup"}, "gramWeight": 240}) == ["1 cup"]


def test_quantities_are_formatted_without_a_trailing_zero():
    assert labels(sr(1.0, "cup", 240), sr(0.5, "cup", 120), sr(1.5, "oz", 42), sr(0.25, "cup", 60)) == [
        "1 cup",
        "0.5 cup",
        "1.5 oz",
        "0.25 cup",
    ]
    assert labels(sr(0, "cup", 240)) == ["cup"]  # a quantity of 0 is left out, as in the app's mapper


def test_portions_are_sorted_by_sequence_number_missing_last():
    assert labels(
        sr(1, "last, no sequence", 4),
        sr(1, "third", 3, sequenceNumber=3),
        sr(1, "first", 1, sequenceNumber=1),
        sr(1, "also last", 5),
        sr(1, "second", 2, sequenceNumber=2),
        sr(1, "tie with third", 6, sequenceNumber=3),
    ) == ["1 first", "1 second", "1 third", "1 tie with third", "1 last, no sequence", "1 also last"]
    # De-duplication follows that order: the lower sequence number wins, wherever it sits in the record.
    record = {"foodPortions": [sr(1, "TBSP", 22, sequenceNumber=2), sr(1, "tbsp", 21, sequenceNumber=1)]}
    assert portions_of(record, 1) == [Portion(1, "1 tbsp", 21.0)]


def test_the_raw_gram_weight_is_kept():
    record = {"foodPortions": [sr(1, "tsp", 4.928922), sr(1, "speck", 0.001), sr(1, "cup", 244)]}
    assert [p.gram_weight for p in portions_of(record, 1)] == [4.928922, 0.001, 244.0]
    assert isinstance(portions_of(record, 1)[2].gram_weight, float)


def test_unusable_gram_weights_are_skipped():
    bad = [0, -5, 0.0, True, None, "28", float("nan"), float("inf")]
    assert labels(*(sr(1, f"portion {i}", grams) for i, grams in enumerate(bad))) == []
    missing = {"amount": 1, "modifier": "cup"}
    assert labels(missing, sr(1, "slice", 28)) == ["1 slice"]
