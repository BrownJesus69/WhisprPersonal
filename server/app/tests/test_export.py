from typing import Any

import pytest

from app.tests.fakes import create_session, upload_chunk


def seed(client: Any) -> None:
    create_session(client)
    for sequence in [0, 2, 3]:
        upload_chunk(client, sequence)
    execute = client.app.state.store.execute
    client.portal.call(execute, "UPDATE sessions SET expected_chunk_count=5")
    client.portal.call(
        execute,
        "UPDATE chunks SET status='done',raw_text='hello',detected_language='kn',"
        "segments_json='[]' WHERE sequence=0",
    )
    client.portal.call(
        execute, "UPDATE chunks SET status='done',no_speech=1,raw_text='SILENT' WHERE sequence=2"
    )
    client.portal.call(execute, "UPDATE chunks SET status='failed' WHERE sequence=3")


@pytest.mark.parametrize("format,media", [("md", "text/markdown"), ("txt", "text/plain")])
def test_content(phase3_client: Any, format: str, media: str) -> None:
    seed(phase3_client)
    r = phase3_client.post(
        "/api/v1/export", json={"event_id": "event1", "session_ids": ["session1"], "format": format}
    )
    assert r.status_code == 200
    assert r.headers["content-type"] == media + "; charset=utf-8"
    assert "[00:00:00] hello" in r.text and "Kannada" in r.text
    assert r.text.count("[part not transcribed]") == 3
    assert "SILENT" not in r.text
    assert all(key in r.text for key in ["Model:", "Transcript status:", "Created:"])
    assert r.text.startswith("# event1" if format == "md" else "event1")
    rows = phase3_client.portal.call(
        phase3_client.app.state.store.rows,
        "SELECT * FROM audit_log WHERE action='transcript_exported'",
    )
    assert len(rows) == 1


def test_polished_and_filename(phase3_client: Any) -> None:
    seed(phase3_client)
    body = {
        "event_id": "event1",
        "session_ids": ["session1"],
        "format": "md",
        "text": "polished",
        "title": '../../bad\\path/"title"\r\n',
    }
    r = phase3_client.post("/api/v1/export", json=body)
    assert "hello (not cleaned)" in r.text
    assert "AI-cleaned text; the raw transcript is unchanged on the laptop." in r.text
    assert r.headers["content-disposition"] == 'attachment; filename="bad-path-title-transcript.md"'
    phase3_client.portal.call(
        phase3_client.app.state.store.execute,
        "UPDATE chunks SET polished_text='Cleaned' WHERE sequence=0",
    )
    assert "[00:00:00] Cleaned" in phase3_client.post("/api/v1/export", json=body).text


@pytest.mark.parametrize("change", ["owner", "event", "missing"])
def test_ownership(phase3_client: Any, change: str) -> None:
    create_session(phase3_client)
    if change == "owner":
        phase3_client.portal.call(
            phase3_client.app.state.store.execute, "UPDATE sessions SET owner_uid='other'"
        )
    r = phase3_client.post(
        "/api/v1/export",
        json={
            "event_id": "other" if change == "event" else "event1",
            "session_ids": ["absent" if change == "missing" else "session1"],
            "format": "txt",
        },
    )
    assert r.status_code == 404


def test_auth_and_validation(phase3_client: Any) -> None:
    body = {"event_id": "event1", "session_ids": [], "format": "pdf"}
    assert phase3_client.post("/api/v1/export", json=body).status_code == 422
    phase3_client.headers.pop("Authorization")
    assert (
        phase3_client.post(
            "/api/v1/export", json={**body, "format": "txt", "session_ids": ["session1"]}
        ).status_code
        == 401
    )


def test_missing_shared_key_and_bounds(phase3_client: Any) -> None:
    body = {"event_id": "event1", "session_ids": ["session1"], "format": "txt"}
    assert (
        phase3_client.post("/api/v1/export", json={**body, "title": "x" * 201}).status_code == 422
    )
    assert (
        phase3_client.post("/api/v1/export", json={**body, "session_ids": ["s"] * 21}).status_code
        == 422
    )
    phase3_client.headers.pop("X-WhisprPersonal-Server-Key")
    assert phase3_client.post("/api/v1/export", json=body).status_code == 401
