"""The database copy for the move to Neon (kalo/copy_db.py): from one scratch schema into another, empty one."""

import os
import uuid

import psycopg
import pytest
from alembic import command
from conftest import URL
from fastapi.testclient import TestClient

from app.main import create_app
from kalo import copy_db
from kalo.copy_db import CopyRefused, copy_database, target_label
from kalo.db import alembic_config

pytestmark = pytest.mark.skipif(not URL, reason="DATABASE_URL not set")


@pytest.fixture
def target_url():
    """An empty scratch schema (not migrated: the copy migrates it)."""
    name = f"test_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(URL, autocommit=True) as conn:
        conn.execute(f"CREATE SCHEMA {name}")
    sep = "&" if "?" in URL else "?"
    yield f"{URL}{sep}options=-c%20search_path%3D{name},public"
    with psycopg.connect(URL, autocommit=True) as conn:
        conn.execute(f"DROP SCHEMA {name} CASCADE")


@pytest.fixture
def source_url(migrated_url):
    """A migrated scratch schema with a food, its portions, a user with a token, logs and steps."""
    with psycopg.connect(migrated_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO foods (fdc_id, description, data_type, calories_per_100g, protein_per_100g,"
            " carbs_per_100g, fat_per_100g) VALUES (1, 'Bananas, raw', 'Foundation', 89, 1.1, 22.8, 0.3)"
        )
        conn.execute("INSERT INTO food_portions (fdc_id, description, gram_weight) VALUES (1, '1 banana', 118)")
        conn.execute("INSERT INTO food_portions (fdc_id, description, gram_weight) VALUES (1, '1 cup', 150)")
    with TestClient(create_app(migrated_url)) as client:
        token = client.post("/api/v1/devices").json()["token"]
        me = {"Authorization": f"Bearer {token}"}
        for quantity in (100, 50):
            assert client.post("/api/v1/food-logs", json={"fdc_id": 1, "quantity": quantity}, headers=me).is_success
    return migrated_url


def rows(url, query):
    with psycopg.connect(url) as conn:
        return conn.execute(query).fetchall()


def test_copies_every_row_with_its_ids_revs_and_sequences(source_url, target_url):
    said = []
    copied = copy_database(source_url, target_url, say=said.append)
    assert copied["foods"] == 1 and copied["food_portions"] == 2
    assert copied["users"] == 1 and copied["user_tokens"] == 1 and copied["food_logs"] == 2
    for query in (
        "SELECT * FROM foods",
        "SELECT * FROM food_portions ORDER BY id",
        "SELECT * FROM users",
        "SELECT * FROM user_tokens",
        "SELECT * FROM food_logs ORDER BY rev",  # same ids, same revs, same generated totals
        "SELECT last_value, is_called FROM sync_rev_seq",
        "SELECT last_value, is_called FROM food_portions_id_seq",
    ):
        assert rows(target_url, query) == rows(source_url, query), query
    assert rows(target_url, "SELECT version_num FROM alembic_version") == rows(
        source_url, "SELECT version_num FROM alembic_version"
    )
    # The triggers are back on: a new write gets the next rev, and new portions the next id.
    with psycopg.connect(target_url, autocommit=True) as conn:
        before = conn.execute("SELECT max(rev) FROM food_logs").fetchone()[0]
        conn.execute("UPDATE food_logs SET quantity = quantity + 1 WHERE rev = %s", (before,))
        assert conn.execute("SELECT max(rev) FROM food_logs").fetchone()[0] > before
        new_id = conn.execute(
            "INSERT INTO food_portions (fdc_id, description, gram_weight) VALUES (1, '1 slice', 10) RETURNING id"
        ).fetchone()[0]
        assert new_id > rows(source_url, "SELECT max(id) FROM food_portions")[0][0]
    assert not any("kalo:kalo" in line for line in said)  # never prints the credentials


def test_refuses_a_target_that_has_data_and_changes_nothing(source_url, target_url):
    copy_database(source_url, target_url, say=lambda _: None)
    before = rows(target_url, "SELECT count(*) FROM food_logs")
    with pytest.raises(CopyRefused, match="already has data"):
        copy_database(source_url, target_url, say=lambda _: None)
    assert rows(target_url, "SELECT count(*) FROM food_logs") == before


def test_target_label_has_no_credentials():
    assert target_label("postgresql://u:secret@ep-x-pooler.neon.tech/neondb?sslmode=require") == (
        "ep-x-pooler.neon.tech/neondb"
    )
    assert "secret" not in target_label(os.environ.get("DATABASE_URL", "postgresql://u:secret@h/d"))


@pytest.mark.parametrize(
    "respell",
    [
        lambda url: url.replace("@localhost", "@127.0.0.1"),
        lambda url: url.replace("?options", "?sslmode=disable&options"),
    ],
)
def test_refuses_the_source_itself_however_spelled_before_writing_anything(migrated_url, respell):
    command.downgrade(alembic_config(migrated_url), "0005")  # an older source, as on the Mac
    same = respell(migrated_url)
    assert same != migrated_url
    with pytest.raises(CopyRefused, match="is the source"):
        copy_database(migrated_url, same, say=lambda _: None)
    assert rows(migrated_url, "SELECT version_num FROM alembic_version") == [("0005",)]  # not migrated
    assert rows(migrated_url, "SELECT to_regclass('rate_limits')") == [(None,)]


def test_refuses_a_target_with_data_before_migrating_it(source_url, target_url):
    command.upgrade(alembic_config(target_url), "0005")
    with psycopg.connect(target_url, autocommit=True) as conn:
        conn.execute("INSERT INTO users DEFAULT VALUES")
    with pytest.raises(CopyRefused, match=r"already has data.*users \(1 rows\)"):
        copy_database(source_url, target_url, say=lambda _: None)
    assert rows(target_url, "SELECT version_num FROM alembic_version") == [("0005",)]


def test_a_malformed_target_url_is_not_echoed(monkeypatch, capsys):
    monkeypatch.setenv("TARGET_DATABASE_URL", "host=h password=s3cret-value ===")
    assert copy_db.main() == 2
    out = capsys.readouterr().out
    assert "not a valid connection string" in out and "s3cret" not in out
