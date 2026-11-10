import hashlib
import io
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


def _serve(monkeypatch, body: bytes):
    """Make urlopen return `body`, recording the URL asked for."""
    asked = []

    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            self.close()

    def fake_urlopen(url, timeout=None):
        asked.append(url)
        return Resp(body)

    monkeypatch.setattr("kalo.usda.datasets.urllib.request.urlopen", fake_urlopen)
    return asked


def test_download_is_verified_and_kept_only_when_it_matches(tmp_path, monkeypatch):
    good = tmp_path / "src.zip"
    ds = Dataset(file="fresh", key="K", sha256=_write_zip(good))
    asked = _serve(monkeypatch, good.read_bytes())
    assert fetch(ds, data_dir=tmp_path) == tmp_path / "fresh.zip"
    assert asked == ["https://fdc.nal.usda.gov/fdc-datasets/fresh.zip"]
    assert not (tmp_path / "fresh.zip.part").exists()
    assert records(ds, data_dir=tmp_path) == [{"fdcId": 1}]  # cached now; no second download
    assert len(asked) == 1


def test_download_with_wrong_hash_is_rejected_and_removed(tmp_path, monkeypatch):
    good = tmp_path / "src.zip"
    ds = Dataset(file="fresh", key="K", sha256=_write_zip(good))
    _serve(monkeypatch, good.read_bytes() + b"\0")  # truncated/altered transfer
    with pytest.raises(ValueError, match="sha256"):
        fetch(ds, data_dir=tmp_path)
    assert not (tmp_path / "fresh.zip").exists()
    assert not (tmp_path / "fresh.zip.part").exists()


def test_failed_download_leaves_no_partial_file(tmp_path, monkeypatch):
    ds = Dataset(file="fresh", key="K", sha256="0" * 64)

    def boom(url, timeout=None):
        raise OSError("network down")

    monkeypatch.setattr("kalo.usda.datasets.urllib.request.urlopen", boom)
    with pytest.raises(OSError, match="network down"):
        fetch(ds, data_dir=tmp_path)
    assert list(tmp_path.iterdir()) == []


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
