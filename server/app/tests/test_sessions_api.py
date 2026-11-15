import hashlib
from typing import Any

from app.tests.fakes import create_session, upload_chunk, wait_done


def test_create_idempotence_ownership(phase3_client: Any) -> None:
    client = phase3_client
    assert create_session(client).status_code == 201
    assert create_session(client).status_code == 200
    assert create_session(client, "s2", event_id="other").status_code == 404
    client.portal.call(
        client.app.state.store.execute, "UPDATE sessions SET owner_uid='user-2' WHERE id='session1'"
    )
    assert create_session(client).status_code == 404
    assert client.get("/api/v1/sessions/session1").status_code == 404
    assert upload_chunk(client).status_code == 404


def test_upload_dedupe_conflict_files_and_limits(phase3_client: Any) -> None:
    client = phase3_client
    state = client.app.state
    create_session(client)
    assert upload_chunk(client).status_code == 202
    duplicate = upload_chunk(client)
    assert duplicate.status_code == 200 and duplicate.json()["duplicate"]
    assert upload_chunk(client, audio=b"different").status_code == 409
    assert upload_chunk(client, chunk_id="different").status_code == 409
    assert upload_chunk(client, 1, filename="wrong.exe").status_code == 415
    assert upload_chunk(client, 1, sha256="a" * 64).status_code == 422
    rows = client.portal.call(state.store.chunks, "session1")
    assert len(rows) == 1 and rows[0]["attempts"] == 0
    assert rows[0]["sha256"] == hashlib.sha256(b"fake-audio").hexdigest()
    assert (state.store.audio_dir / "session1/000000_chunk0.m4a").read_bytes() == b"fake-audio"
    assert not list(state.store.audio_dir.rglob("*.part"))
    state.settings.queue_max_depth = 1
    full = upload_chunk(client, 1)
    assert full.status_code == 503 and full.headers["Retry-After"] == "10"
    body = client.get("/api/v1/sessions/session1").json()
    assert body["counts"] == {"queued": 1, "processing": 0, "done": 0, "failed": 0, "total": 1}


def test_order_transcript_override_and_delete(phase3_client: Any) -> None:
    client = phase3_client
    state = client.app.state
    create_session(client)
    assert (
        client.post("/api/v1/sessions/session1/language", json={"language": "kn"}).json()["mode"]
        == "kn"
    )
    assert (
        client.post("/api/v1/sessions/session1/language", json={"language": "te"}).status_code
        == 422
    )
    upload_chunk(client, 1)
    upload_chunk(client, 0)
    client.portal.call(
        state.store.execute, "UPDATE chunks SET status='done',raw_text='hello',segments_json='[]'"
    )
    body = client.get("/api/v1/sessions/session1").json()
    assert [c["sequence"] for c in body["chunks"]] == [0, 1]
    assert body["transcript_text"] == "hello hello"
    assert (
        client.get("/api/v1/sessions/session1?after_sequence=0").json()["transcript_text"] is None
    )
    client.portal.call(
        state.store.execute, "UPDATE chunks SET status='processing' WHERE sequence=0"
    )
    assert client.delete("/api/v1/sessions/session1").status_code == 409
    client.portal.call(state.store.execute, "UPDATE chunks SET status='done' WHERE sequence=0")
    assert client.delete("/api/v1/sessions/session1").json() == {
        "deleted": True,
        "firestore_deleted": True,
    }
    assert client.get("/api/v1/sessions/session1").status_code == 404
    assert not (state.store.audio_dir / "session1").exists()
    assert client.portal.call(state.store.chunks, "session1") == []
    assert state.firestore_sync.calls[-1] == ("deleted", ("event1", "session1"))


def test_finalize_and_late_upload(phase3_client: Any) -> None:
    client = phase3_client
    state = client.app.state
    create_session(client)
    result = client.post("/api/v1/sessions/session1/finalize", json={"expected_chunk_count": 2})
    assert result.status_code == 202 and result.json()["missing_sequences"] == [0, 1]
    upload_chunk(client)
    state.server_state.model_status = "ready"
    client.portal.call(state.worker.notify)
    wait_done(client)
    assert client.get("/api/v1/sessions/session1").json()["status"] == "finalizing"
    assert upload_chunk(client, 1).status_code == 202
    wait_done(client, sequence=1)
    # Explicit idempotent finalize also awaits cloud sync completion.
    result = client.post("/api/v1/sessions/session1/finalize", json={"expected_chunk_count": 2})
    assert result.status_code == 200 and result.json()["transcript_status"] == "complete"
    assert upload_chunk(client, 2).status_code == 409
    assert (
        client.post("/api/v1/sessions/session1/language", json={"language": "en"}).status_code
        == 409
    )


def test_force_partial_and_disabled_cloud(phase3_client: Any) -> None:
    from app.services.firestore_sync import DisabledFirestoreSync

    client = phase3_client
    state = client.app.state
    state.firestore_sync = state.worker.sync = DisabledFirestoreSync()
    create_session(client)
    result = client.post(
        "/api/v1/sessions/session1/finalize", json={"expected_chunk_count": 3, "force": True}
    )
    assert result.status_code == 200
    assert result.json()["transcript_status"] == "partial"
    assert result.json()["missing_sequences"] == [0, 1, 2]
    assert result.json()["firestore_sync"] == "disabled"
