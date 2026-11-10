import hashlib
import json
import zipfile

import pytest

from kalo.usda.datasets import Dataset, fetch, records


def _write_zip(path):
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("x.json", json.dumps({"K": [{"fdcId": 1}]}))
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_records_reads_a_verified_cached_zip(tmp_path):
    path = tmp_path / "small.zip"
    ds = Dataset(file="small", key="K", sha256=_write_zip(path))
    assert records(ds, data_dir=tmp_path) == [{"fdcId": 1}]


def test_corrupted_cached_zip_is_rejected(tmp_path):
    path = tmp_path / "small.zip"
    ds = Dataset(file="small", key="K", sha256=_write_zip(path))
    with path.open("ab") as f:
        f.write(b"\0")
    with pytest.raises(ValueError, match="sha256") as info:
        fetch(ds, data_dir=tmp_path)
    assert str(path) in str(info.value)
    assert ds.sha256 in str(info.value)
    with pytest.raises(ValueError, match="sha256"):
        records(ds, data_dir=tmp_path)
    assert path.exists()  # a cached file is left for the user to delete
