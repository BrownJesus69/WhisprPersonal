import asyncio
import sqlite3
from pathlib import Path

import pytest

from app.services.store import MIGRATIONS, Store, insert


def test_migrations_recovery_events_and_cascade(tmp_path: Path) -> None:
    async def check() -> None:
        store = Store(tmp_path)
        await store.open()
        await store.transaction(
            lambda conn: insert(
                conn,
                "sessions",
                {
                    "id": "s",
                    "owner_uid": "u",
                    "event_id": "e",
                    "status": "active",
                    "transcript_status": "pending",
                    "model_profile": "turbo",
                },
            )
        )
        for index in range(3):
            assert await store.append_event("s", "test", {"index": index}) == index + 1
        await store.transaction(
            lambda conn: insert(
                conn,
                "chunks",
                {
                    "session_id": "s",
                    "chunk_id": "c",
                    "sequence": 0,
                    "status": "processing",
                    "attempts": 2,
                },
            )
        )
        with pytest.raises(sqlite3.IntegrityError):
            await store.transaction(
                lambda conn: insert(
                    conn,
                    "chunks",
                    {"session_id": "s", "chunk_id": "d", "sequence": 0, "status": "queued"},
                )
            )
        await store.close()
        await store.open()
        assert await store.recover_on_startup() == {"requeued": 1}
        assert (await store.chunks("s"))[0]["attempts"] == 2
        assert [event["seq"] for event in await store.events("s", 1)] == [2, 3]
        await store.execute("DELETE FROM sessions WHERE id='s'")
        assert await store.chunks("s") == [] and await store.events("s") == []
        await store.close()

    asyncio.run(check())


def test_upgrade_four_to_five_preserves_raw(tmp_path: Path) -> None:
    database = tmp_path / "whisprpersonal.sqlite3"
    with sqlite3.connect(database) as conn:
        for migration in MIGRATIONS[:4]:
            conn.executescript(migration)
        conn.execute("PRAGMA user_version=4")
        conn.execute(
            "INSERT INTO sessions(id,owner_uid,event_id,status,transcript_status,model_profile) "
            "VALUES ('s','u','e','finalized','complete','turbo')"
        )
        conn.execute(
            "INSERT INTO chunks(session_id,chunk_id,sequence,status,raw_text,raw_text_full) "
            "VALUES ('s','c',0,'done','unaltered speech','full speech')"
        )

    async def scenario() -> None:
        store = Store(tmp_path)
        await store.open()
        chunk = (await store.chunks("s"))[0]
        assert chunk["raw_text"] == "unaltered speech" and chunk["raw_text_full"] == "full speech"
        assert chunk["polished_text"] is None and chunk["polish_error"] is None
        assert (await store.rows("PRAGMA user_version"))[0]["user_version"] == 5
        assert await store.rows("SELECT * FROM ai_jobs") == []
        assert await store.rows("SELECT * FROM ai_usage") == []
        await store.close()

    asyncio.run(scenario())
