import asyncio
from datetime import datetime
from types import SimpleNamespace
from typing import Any

import pytest

from app.services.firestore_sync import (
    FirestoreSync,
    FirestoreSyncError,
    chunk_fields,
    session_fields,
)
from app.tests.fakes import create_session, upload_chunk


class FakeReference:
    def __init__(self, client: Any, path: str = "") -> None:
        self.client, self.path = client, path

    def collection(self, value: str) -> "FakeReference":
        return FakeReference(self.client, self.path + "/" + value)

    def document(self, value: str) -> "FakeReference":
        return FakeReference(self.client, self.path + "/" + value)

    def set(self, data: dict, merge: bool) -> None:
        self.client.writes.append((self.path, data, merge))

    def limit(self, count: int) -> "FakeReference":
        assert count == 450
        return self

    def stream(self) -> list[Any]:
        return [
            SimpleNamespace(reference=FakeReference(self.client, path))
            for path in self.client.remaining[:450]
        ]

    def delete(self) -> None:
        self.client.deleted.append(self.path)


class FakeBatch:
    def __init__(self, client: Any) -> None:
        self.client, self.ops = client, []

    def set(self, ref: FakeReference, data: dict, merge: bool) -> None:
        self.ops.append((ref.path, data, merge))

    def delete(self, ref: FakeReference) -> None:
        self.ops.append((ref.path, None, None))

    def commit(self) -> None:
        self.client.batches.append(self.ops)
        for path, data, _ in self.ops:
            if data is None:
                self.client.remaining.remove(path)


class FakeClient(FakeReference):
    def __init__(self) -> None:
        super().__init__(self)
        self.writes: list[Any] = []
        self.batches: list[Any] = []
        self.remaining: list[str] = []
        self.deleted: list[str] = []

    def batch(self) -> FakeBatch:
        return FakeBatch(self)


def test_projection_field_names_and_batches(phase3_client: Any) -> None:
    client = phase3_client
    create_session(client)
    upload_chunk(client)
    session = client.portal.call(client.app.state.store.session, "session1")
    chunk = client.portal.call(client.app.state.store.chunks, "session1")[0]
    session_data = session_fields(session, [chunk])
    assert set(session_data) == {
        "ownerId",
        "status",
        "model",
        "languageMode",
        "detectedLanguages",
        "startedAt",
        "endedAt",
        "durationMs",
        "serverSessionId",
        "transcriptStatus",
        "error",
    }
    assert isinstance(session_data["startedAt"], datetime)
    chunk_data = chunk_fields(chunk)
    assert set(chunk_data) == {
        "sequence",
        "startMs",
        "endMs",
        "uploadStatus",
        "transcriptionStatus",
        "detectedLanguage",
        "languageConfidence",
        "languageSource",
        "userOverride",
        "rawText",
        "polishedText",
        "error",
        "createdAt",
        "updatedAt",
    }
    assert chunk_data["polishedText"] is None
    firestore = FakeClient()

    class Service:
        def firestore(self) -> Any:
            return firestore

    sync = FirestoreSync(Service())
    asyncio.run(sync.session_started(session))
    asyncio.run(
        sync.session_finalized(session, [{**chunk, "chunk_id": f"c{i}"} for i in range(901)])
    )
    assert [len(batch) for batch in firestore.batches] == [450, 450, 1]
    assert all(op[2] is True for batch in firestore.batches for op in batch)
    assert firestore.writes[-1][0] == "/events/event1/sessions/session1"


def test_firestore_failure_is_safe() -> None:
    class Broken:
        def firestore(self) -> None:
            raise RuntimeError("private path and transcript")

    with pytest.raises(FirestoreSyncError, match="^firestore_unavailable$"):
        asyncio.run(FirestoreSync(Broken()).session_started({"event_id": "e", "id": "s"}))


def test_hanging_firestore_is_cut_off_at_timeout() -> None:
    # Offline laptop: the Firestore client would otherwise retry for minutes.
    import threading
    import time

    release = threading.Event()

    class Hanging:
        def firestore(self) -> None:
            release.wait(5)
            raise RuntimeError("never reached in time")

    async def scenario() -> float:
        # Measure inside the loop: asyncio.run() itself joins the abandoned thread on exit,
        # which a long-running server loop never does.
        started = time.perf_counter()
        try:
            with pytest.raises(FirestoreSyncError, match="^firestore_unavailable$"):
                await FirestoreSync(Hanging(), timeout_s=0.2).session_started(
                    {"event_id": "e", "id": "s"}
                )
            return time.perf_counter() - started
        finally:
            release.set()

    assert asyncio.run(scenario()) < 1


def test_delete_removes_nested_chunks_in_bounded_batches() -> None:
    client = FakeClient()
    client.remaining = [f"chunk{i}" for i in range(902)]

    class Service:
        def firestore(self) -> Any:
            return client

    asyncio.run(FirestoreSync(Service()).delete_session("event1", "session1"))
    assert [len(batch) for batch in client.batches] == [450, 450, 2]
    assert not client.remaining
    assert client.deleted == ["/events/event1/sessions/session1"]
