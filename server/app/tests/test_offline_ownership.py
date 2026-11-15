"""Offline events: sessions can start without Firestore, but nothing reaches Firestore until
event ownership is verified online."""

from typing import Any

from app.core.errors import AppError, ErrorCode
from app.tests.fakes import create_session


class OfflineRepo:
    """Firestore unreachable."""

    async def get_event_owner(self, event_id: str) -> str | None:
        raise AppError(ErrorCode.firestore_unavailable, "Event storage is unavailable.")


class Repo:
    def __init__(self, owners: dict[str, str]) -> None:
        self.owners = owners

    async def get_event_owner(self, event_id: str) -> str | None:
        return self.owners.get(event_id)


def session_row(client: Any, sid: str) -> dict[str, Any]:
    return client.portal.call(client.app.state.store.session, sid)


def sync(client: Any, sid: str) -> None:
    worker = client.app.state.worker
    client.portal.call(worker.sync_session, session_row(client, sid))


def test_cached_event_allows_offline_session(phase3_client: Any) -> None:
    client = phase3_client
    assert create_session(client, "online").status_code == 201  # verifies + caches event1
    client.app.state.event_repository = OfflineRepo()
    assert create_session(client, "offline").status_code == 201
    assert session_row(client, "offline")["ownership_pending"] == 0


def test_cached_other_owner_still_rejected_offline(phase3_client: Any) -> None:
    client = phase3_client
    client.portal.call(
        client.app.state.store.execute,
        "INSERT INTO event_owners VALUES ('other', 'user-2', 'x')",
    )
    client.app.state.event_repository = OfflineRepo()
    assert create_session(client, "s", event_id="other").status_code == 404


def test_unverified_offline_session_is_held_then_synced(phase3_client: Any) -> None:
    client = phase3_client
    sync_calls = client.app.state.worker.sync.calls
    client.app.state.event_repository = OfflineRepo()
    assert create_session(client, "s1", event_id="new-event").status_code == 201
    assert session_row(client, "s1")["ownership_pending"] == 1
    sync(client, "s1")  # still offline: nothing written
    assert not [c for c in sync_calls if c[1].get("id") == "s1"]
    assert session_row(client, "s1")["firestore_error"] == "firestore_unavailable"

    client.app.state.event_repository = Repo({})  # online, phone has not uploaded the event yet
    sync(client, "s1")
    assert session_row(client, "s1")["firestore_error"] == "event_not_found_yet"
    assert not [c for c in sync_calls if c[1].get("id") == "s1"]

    client.app.state.event_repository = Repo({"new-event": "user-1"})
    sync(client, "s1")
    row = session_row(client, "s1")
    assert row["ownership_pending"] == 0 and row["firestore_sync"] == "synced"
    assert [c for c in sync_calls if c[0] == "started" and c[1]["id"] == "s1"]


def test_offline_session_for_someone_elses_event_is_quarantined(phase3_client: Any) -> None:
    client = phase3_client
    client.app.state.event_repository = OfflineRepo()
    assert create_session(client, "s1", event_id="theirs").status_code == 201
    client.app.state.event_repository = Repo({"theirs": "user-2"})
    sync(client, "s1")
    row = session_row(client, "s1")
    assert (row["firestore_sync"], row["firestore_error"]) == ("disabled", "ownership_mismatch")
    assert not [c for c in client.app.state.worker.sync.calls if c[1].get("id") == "s1"]
    # Quarantined sessions are not retried by the sweep.
    client.portal.call(client.app.state.worker.retry_sync)
    assert not [c for c in client.app.state.worker.sync.calls if c[1].get("id") == "s1"]


def test_vocabulary_can_be_saved_offline(phase3_client: Any) -> None:
    client = phase3_client
    client.app.state.event_repository = OfflineRepo()
    body = {"event_id": "new-event", "terms": ["Ramesh Iyer"], "replacements": []}
    assert client.post("/api/v1/vocabulary", json=body).status_code == 200
    assert client.get("/api/v1/vocabulary", params={"event_id": "new-event"}).json()["terms"] == [
        "Ramesh Iyer"
    ]
