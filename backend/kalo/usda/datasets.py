"""The USDA FoodData Central downloads: which releases, where they are cached, how to read them.

Downloads go to backend/data/usda/ (gitignored) and are reused on later runs.
The zips are read in place; nothing is extracted. USDA data is public domain.
Each zip is verified against a pinned SHA-256, on download and on every reuse.
"""

from __future__ import annotations

import hashlib
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
    sha256: str  # of the zip; `shasum -a 256 data/usda/<file>.zip`

    @property
    def release(self) -> str:
        return self.file.removeprefix("FoodData_Central_")


# The latest release of each generic dataset (https://fdc.nal.usda.gov/download-datasets/).
# Same releases as the app's bundled JSON (scripts/build-usda-foods.mjs).
# Bumping a release means updating its sha256 pin too.
DATASETS = (
    Dataset(
        "FoodData_Central_foundation_food_json_2026-10-29",
        "FoundationFoods",
        "dd414cc9f1a132626bad354ef6655972c78b44aff14f16114dc899708663c579",
    ),
    Dataset(  # final release
        "FoodData_Central_sr_legacy_food_json_2018-04",
        "SRLegacyFoods",
        "0fe8ae486a2c8eb42cb96413f058deb51863a46c8fb8eeb4b1fb45006dd338ef",
    ),
    Dataset(
        "FoodData_Central_survey_food_json_2024-10-31",
        "SurveyFoods",
        "dfb06ae7ddc397ccd570b91c14b75438ab2ba39f64f22d321f61d4a52a77f3eb",
    ),
)


def sha256_of(path: Path) -> str:
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def verify(dataset: Dataset, path: Path) -> None:
    """Raise ValueError unless the file's SHA-256 matches the dataset's pin."""
    actual = sha256_of(path)
    if actual != dataset.sha256:
        raise ValueError(
            f"{path}: sha256 mismatch; expected {dataset.sha256}, got {actual}. "
            "Delete the file and rerun to download it again; if USDA republished this release, "
            "update the pin in kalo/usda/datasets.py"
        )


def fetch(dataset: Dataset, data_dir: Path = DATA_DIR) -> Path:
    """The dataset's zip on disk, downloading it once and checking its SHA-256."""
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / f"{dataset.file}.zip"
    if path.exists():
        verify(dataset, path)
        return path
    tmp = path.with_suffix(".zip.part")
    try:
        with urllib.request.urlopen(BASE_URL + path.name, timeout=60) as resp, tmp.open("wb") as out:
            shutil.copyfileobj(resp, out)
        verify(dataset, tmp)
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)  # a failed or rejected download leaves nothing behind
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
