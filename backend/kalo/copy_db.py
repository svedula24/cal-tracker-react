"""Copy every row of one Kalo database into another, empty one: the move from the Mac's docker Postgres to Neon.

    TARGET_DATABASE_URL='postgresql://...neon.tech/neondb?sslmode=require' uv run python -m kalo.copy_db

The source is DATABASE_URL (default: the docker-compose database), read only. The target is TARGET_DATABASE_URL,
an environment variable rather than an argument so the password stays out of the shell history and `ps`. Use
Neon's direct connection string (DATABASE_URL_UNPOOLED, the host without -pooler): the copy is one long
transaction of COPY and ALTER TABLE statements, which Neon recommends a direct connection for.

What it does:
1. After the checks in 2, migrates the target to head (alembic upgrade head), in its current_schema().
2. (Checked first, before anything is written:) refuses a target that is the source database however its URL
   is spelled, or that already has a row in any table it would copy (nothing is changed then), so a second
   run cannot duplicate or overwrite anything. To start over, drop and recreate the target's database.
3. In one transaction, copies every table of the source's current_schema() (the USDA foods and portions, the
   users, tokens and their data, OAuth, pairing codes, the barcode cache) in foreign-key order, ids and all,
   with COPY. The rev triggers are disabled for the copy, so each row keeps its rev; then every sequence
   (sync_rev_seq, the portion ids) is set to where the source's is. Any failure rolls the whole copy back.
4. Checks that each table has the same number of rows on both sides.

The source may be at an older migration than head (the API running on the Mac keeps working): every table it
has must exist in the target with the same columns, and the target's newer tables stay empty. Not copied:
alembic_version (the target has its own) and rate_limits (counts, not data). Prints table names and row counts
and the target's host, never a URL or a password.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Callable

import psycopg
from alembic import command
from psycopg import sql
from sqlalchemy.exc import DBAPIError

from kalo.db import alembic_config, database_url

SKIPPED = ("alembic_version", "rate_limits")


class CopyRefused(RuntimeError):
    """The target is not empty, or its tables do not match the source's."""


def _tables(conn: psycopg.Connection) -> list[str]:
    rows = conn.execute(
        "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename"
    ).fetchall()
    return [name for (name,) in rows if name not in SKIPPED]


def _columns(conn: psycopg.Connection, table: str) -> list[str]:
    """The table's stored, non-generated columns, in order (a GENERATED column cannot be written)."""
    rows = conn.execute(
        "SELECT attname FROM pg_attribute WHERE attrelid = to_regclass(format('%%I.%%I', current_schema(), %s::text))"
        " AND attnum > 0 AND NOT attisdropped AND attgenerated = '' ORDER BY attnum",
        (table,),
    ).fetchall()
    return [name for (name,) in rows]


def _fk_order(conn: psycopg.Connection, tables: list[str]) -> list[str]:
    """`tables` with every referenced table before the tables that reference it."""
    edges = conn.execute(
        "SELECT c.conrelid::regclass::text, c.confrelid::regclass::text FROM pg_constraint c"
        " JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.contype = 'f' AND n.nspname = current_schema()"
    ).fetchall()
    needs = {t: set() for t in tables}
    for child, parent in edges:
        child, parent = child.rpartition(".")[2], parent.rpartition(".")[2]
        if child in needs and parent in needs and child != parent:
            needs[child].add(parent)
    ordered: list[str] = []
    while needs:
        ready = sorted(t for t, parents in needs.items() if not parents - set(ordered))
        if not ready:
            raise CopyRefused(f"foreign keys form a cycle among {', '.join(sorted(needs))}")
        ordered += ready
        for t in ready:
            del needs[t]
    return ordered


def _sequences(conn: psycopg.Connection) -> dict[str, tuple[int, bool]]:
    names = conn.execute(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
        " WHERE c.relkind = 'S' AND n.nspname = current_schema()"
    ).fetchall()
    states = {}
    for (name,) in names:
        query = sql.SQL("SELECT last_value, is_called FROM {}").format(sql.Identifier(name))
        states[name] = conn.execute(query).fetchone()
    return states


def _count(conn: psycopg.Connection, table: str) -> int:
    return conn.execute(sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(table))).fetchone()[0]


def target_label(url: str) -> str:
    """The target's host and database, for messages: no user, no password."""
    info = psycopg.conninfo.conninfo_to_dict(url)
    return f"{info.get('host', 'localhost')}/{info.get('dbname', '')}"


# What makes a database (and schema) the same one however its URL is spelled ("localhost" or "127.0.0.1",
# extra parameters): the server's start time, the database and the schema the tables live in.
_IDENTITY = "SELECT pg_postmaster_start_time(), current_database(), current_schema()"


def check_target(source_url: str, target_url: str) -> None:
    """Raise CopyRefused, before anything is written, when the target is the source itself (spelled any way)
    or already has a row in any table the source has. Read-only on both sides."""
    with psycopg.connect(source_url) as src, psycopg.connect(target_url) as dst:
        if src.execute(_IDENTITY).fetchone() == dst.execute(_IDENTITY).fetchone():
            raise CopyRefused("the target is the source database")
        present = [
            t for t in _tables(src)
            if dst.execute("SELECT to_regclass(format('%%I.%%I', current_schema(), %s::text))", (t,)).fetchone()[0]
        ]  # fmt: skip
        not_empty = {t: n for t in present if (n := _count(dst, t))}
        if not_empty:
            listed = ", ".join(f"{t} ({n} rows)" for t, n in not_empty.items())
            raise CopyRefused(f"the target already has data, nothing was copied: {listed}")


def copy_database(source_url: str, target_url: str, say: Callable[[str], None] = print) -> dict[str, int]:
    """Copy every row from `source_url` into `target_url` (see the module docstring); the rows copied per table."""
    check_target(source_url, target_url)  # before the migration, the first write
    say(f"Migrating the target ({target_label(target_url)}) to head")
    command.upgrade(alembic_config(target_url), "head")

    with psycopg.connect(source_url) as src, psycopg.connect(target_url) as dst:
        # One snapshot of the source for the whole copy, so a write on the Mac mid-copy cannot tear it.
        src.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
        src.read_only = True
        tables = _fk_order(src, _tables(src))
        target_tables = set(_tables(dst))
        missing = [t for t in tables if t not in target_tables]
        if missing:
            raise CopyRefused(f"the target has no table {', '.join(missing)}: is the source newer than this code?")
        columns = {t: _columns(src, t) for t in tables}
        for t in tables:
            if _columns(dst, t) != columns[t]:
                raise CopyRefused(f"{t} has different columns in the source and the target")
        not_empty = {t: n for t in tables if (n := _count(dst, t))}
        if not_empty:
            listed = ", ".join(f"{t} ({n} rows)" for t, n in not_empty.items())
            raise CopyRefused(f"the target already has data, nothing was copied: {listed}")

        copied = {}
        for t in tables:
            cols = sql.SQL(", ").join(map(sql.Identifier, columns[t]))
            table = sql.Identifier(t)
            # The rev triggers would give every row a new rev; the copy keeps the source's.
            dst.execute(sql.SQL("ALTER TABLE {} DISABLE TRIGGER USER").format(table))
            with (
                src.cursor().copy(sql.SQL("COPY {} ({}) TO STDOUT (FORMAT BINARY)").format(table, cols)) as out,
                dst.cursor().copy(sql.SQL("COPY {} ({}) FROM STDIN (FORMAT BINARY)").format(table, cols)) as into,
            ):
                for chunk in out:
                    into.write(chunk)
            dst.execute(sql.SQL("ALTER TABLE {} ENABLE TRIGGER USER").format(table))
            copied[t] = _count(dst, t)
            say(f"  {t}: {copied[t]} rows")
        target_sequences = _sequences(dst)
        for name, (last, called) in _sequences(src).items():
            if name in target_sequences:
                dst.execute("SELECT setval(%s, %s, %s)", (sql.Identifier(name).as_string(dst), last, called))
                say(f"  sequence {name}: {last}")
        for t in tables:
            if copied[t] != _count(src, t):
                raise RuntimeError(f"{t}: {copied[t]} rows in the target, {_count(src, t)} in the source")
        dst.commit()
    return copied


def main() -> int:
    target = os.environ.get("TARGET_DATABASE_URL", "").strip()
    if not target:
        print("Set TARGET_DATABASE_URL to the target's connection string (Neon: the direct, unpooled one).")
        return 2
    source = database_url()
    try:
        label = target_label(target)
    except psycopg.Error:
        print("TARGET_DATABASE_URL is not a valid connection string.")  # never echoed: it holds a password
        return 2
    if "-pooler" in label:
        print("Note: the target is Neon's pooled host; the direct one (DATABASE_URL_UNPOOLED) is recommended.")
    try:
        copied = copy_database(source, target)
    except CopyRefused as e:
        print(f"Refused: {e}")
        return 1
    except (psycopg.Error, DBAPIError) as e:  # the message names the host, never the password
        print(f"Failed, nothing was copied: {e}")
        return 1
    print(f"Copied {sum(copied.values())} rows in {len(copied)} tables to {label}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
