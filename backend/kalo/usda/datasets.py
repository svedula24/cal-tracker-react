"""The USDA FoodData Central downloads: which releases, where they are cached, how to read them.

Downloads go to backend/data/usda/ (gitignored) and are reused on later runs.
The zips are read in place; nothing is extracted. USDA data is public domain.
"""

from __future__ import annotations

import json
import shutil
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

BASE_URL = "https://fdc.nal.usda.gov/fdc-datasets/"
DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "usda"


@dataclass(frozen=True)
class Dataset:
    file: str  # zip name without extension
    key: str  # the array in the JSON that holds the food records

    @property
    def release(self) -> str:
        return self.file.removeprefix("FoodData_Central_")


# The latest release of each generic dataset (https://fdc.nal.usda.gov/download-datasets/).
# Same releases as the app's bundled JSON (scripts/build-usda-foods.mjs).
DATASETS = (
    Dataset("FoodData_Central_foundation_food_json_2026-10-29", "FoundationFoods"),
    Dataset("FoodData_Central_sr_legacy_food_json_2018-04", "SRLegacyFoods"),  # final release
    Dataset("FoodData_Central_survey_food_json_2024-10-31", "SurveyFoods"),
)


def fetch(dataset: Dataset, data_dir: Path = DATA_DIR) -> Path:
    """The dataset's zip on disk, downloading it once."""
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / f"{dataset.file}.zip"
    if not path.exists():
        tmp = path.with_suffix(".zip.part")
        with urllib.request.urlopen(BASE_URL + path.name, timeout=60) as resp, tmp.open("wb") as out:  # noqa: S310
            shutil.copyfileobj(resp, out)
        tmp.replace(path)
    return path


def records(dataset: Dataset, data_dir: Path = DATA_DIR) -> list[dict[str, Any]]:
    """Every food record of the dataset."""
    path = fetch(dataset, data_dir)
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile as e:  # an outage page served with a 200 would be cached as the zip
        raise ValueError(f"{path} is not a zip file; delete it and rerun to download again") from e
    with zf:
        names = [n for n in zf.namelist() if n.endswith(".json")]
        if len(names) != 1:
            raise ValueError(f"{dataset.file}: expected one .json in the zip, found {names}")
        with zf.open(names[0]) as f:
            data = json.load(f)
    found = data.get(dataset.key)
    if not isinstance(found, list):
        raise ValueError(f"{dataset.file}: no {dataset.key!r} array in the JSON")
    return found
