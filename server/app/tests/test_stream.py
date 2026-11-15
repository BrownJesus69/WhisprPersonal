from typing import Any

import pytest
from starlette.websockets import WebSocketDisconnect

from app.tests.fakes import create_session, upload_chunk


@pytest.mark.parametrize(
    ("headers", "code"),
    [({"X-WhisprPersonal-Server-Key": ""}, 4401), ({"Authorization": "Bearer bad"}, 4401)],
)
def test_stream_auth(phase3_client: Any, headers: dict[str, str], code: int) -> None:
    client = phase3_client
    create_session(client)
    with client.websocket_connect("/api/v1/sessions/session1/stream", headers=headers) as ws:
        assert ws.receive_json()["type"] == "error"
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == code


def test_stream_not_owned(phase3_client: Any) -> None:
    client = phase3_client
    create_session(client)
    client.portal.call(client.app.state.store.execute, "UPDATE sessions SET owner_uid='user-2'")
    with client.websocket_connect("/api/v1/sessions/session1/stream") as ws:
        assert ws.receive_json()["code"] == "not_found"
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 4404


def test_replay_live_commands_invalid_and_delete(phase3_client: Any) -> None:
    client = phase3_client
    state = client.app.state
    create_session(client)
    upload_chunk(client)
    with client.websocket_connect("/api/v1/sessions/session1/stream?after_seq=1") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello" and hello["last_event_seq"] == 2
        assert ws.receive_json()["type"] == "chunk_queued"
        ws.send_text("not json")
        assert ws.receive_json()["type"] == "error"
        ws.send_json({"type": "set_language", "language": "kn"})
        assert ws.receive_json()["type"] == "language_override"
        state.server_state.model_status = "ready"
        client.portal.call(state.worker.notify)
        received = [ws.receive_json() for _ in range(3)]
        assert [m["type"] for m in received] == [
            "chunk_processing",
            "transcript_partial",
            "transcript_final",
        ]
        assert "seq" not in received[1]
        assert received[2]["data"]["language_source"] == "override"
        assert client.delete("/api/v1/sessions/session1").status_code == 200
        assert ws.receive_json()["type"] == "session_deleted"
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 1000


def test_subscribe_before_replay_deduplication(phase3_client: Any) -> None:
    client = phase3_client
    state = client.app.state
    create_session(client)
    original_events = state.store.events

    async def replay(session_id: str, after_seq: int = 0) -> list[dict]:
        await state.worker.emit(session_id, "language_override", {"language": "en", "by": "user"})
        return await original_events(session_id, after_seq)

    state.store.events = replay
    with client.websocket_connect("/api/v1/sessions/session1/stream") as ws:
        assert ws.receive_json()["type"] == "hello"
        assert ws.receive_json()["seq"] == 1
        assert ws.receive_json()["seq"] == 2
        ws.send_json({"type": "unknown"})
        assert ws.receive_json()["type"] == "error"  # queued duplicate seq=2 was skipped


def test_overflow_closes_for_resume(phase3_client: Any) -> None:
    client = phase3_client
    state = client.app.state
    create_session(client)
    with client.websocket_connect("/api/v1/sessions/session1/stream?after_seq=1") as ws:
        assert ws.receive_json()["type"] == "hello"

        def flood() -> None:
            for _ in range(300):
                state.broadcaster.publish("session1", {"type": "transcript_partial"})

        client.portal.call(flood)
        with pytest.raises(WebSocketDisconnect) as exc:
            while True:
                ws.receive_json()
        assert exc.value.code == 4008


@pytest.mark.parametrize(
    ("kind", "close_code"), [("disabled", 4503), ("allowlist", 4403), ("rate", 4429)]
)
def test_stream_other_auth_close_codes(phase3_client: Any, kind: str, close_code: int) -> None:
    from app.security.auth import DisabledTokenVerifier
    from app.security.rate_limit import TokenBucketLimiter

    client = phase3_client
    state = client.app.state
    create_session(client)
    if kind == "disabled":
        state.token_verifier = DisabledTokenVerifier()
    elif kind == "allowlist":
        state.settings.auth_allowed_uids = ["someoneelse"]
    else:
        state.user_limiter = TokenBucketLimiter(1)
        state.user_limiter.check("user-1")
    with client.websocket_connect("/api/v1/sessions/session1/stream") as ws:
        assert ws.receive_json()["type"] == "error"
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == close_code
