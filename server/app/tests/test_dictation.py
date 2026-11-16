"""Keyboard dictation is authenticated, bounded and ephemeral (no real inference/network)."""

import io
import logging
import tempfile
import wave
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest

from app.core.errors import AppError, ErrorCode


def wav(seconds: float = 1, rate: int = 16000, channels: int = 1, width: int = 2) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(channels)
        audio.setsampwidth(width)
        audio.setframerate(rate)
        audio.writeframes(bytes(int(seconds * rate) * channels * width))
    return output.getvalue()


def post(client: Any, audio: bytes | None = None, **data: str) -> Any:
    return client.post(
        "/api/v1/dictation",
        files={"file": ("voice.wav", wav() if audio is None else audio)},
        data=data,
    )


@pytest.fixture
def ready(phase3_client: Any) -> Any:
    phase3_client.app.state.server_state.model_status = "ready"
    return phase3_client


def test_auth_required(ready: Any, client: Any) -> None:
    ready.headers.pop("X-WhisprPersonal-Server-Key")
    assert post(ready).status_code == 401
    key = client.app.state.settings.server_shared_secret.get_secret_value()
    client.headers.update(
        {
            "X-WhisprPersonal-Server-Key": key,
            "Authorization": "Bearer good-token",
        }
    )
    assert post(client).status_code == 503  # verifier is deliberately unconfigured


@pytest.mark.parametrize(
    "audio",
    [b"not a wav", wav(rate=8000), wav(120.01), wav(channels=2), wav(width=1), wav(0), wav()[:-1]],
)
def test_invalid_audio(ready: Any, audio: bytes) -> None:
    result = post(ready, audio)
    assert result.status_code == 422
    assert result.json()["error"]["code"] == "validation_error"
    assert not ready.app.state.engine.calls


def test_language(ready: Any) -> None:
    assert post(ready, language="invalid").status_code == 422
    assert post(ready, language="kn").json()["language"] == "kn"
    assert post(ready, language="auto").json()["language"] == "en"


def test_owned_vocabulary(ready: Any) -> None:
    assert (
        ready.post(
            "/api/v1/vocabulary", json={"event_id": "event1", "terms": ["Bengaluru"]}
        ).status_code
        == 200
    )
    assert post(ready, event_id="other").status_code == 404
    assert post(ready, event_id="event1").status_code == 200
    engine = ready.app.state.engine
    assert engine.calls[-1][1]["hotwords"] == "Bengaluru"
    assert post(ready).status_code == 200
    assert engine.calls[-1][1]["hotwords"] is None


def test_unverified_offline_event_has_no_hotwords(ready: Any) -> None:
    async def offline(event_id: str) -> str:
        raise AppError(ErrorCode.firestore_unavailable, "Offline")

    ready.app.state.event_repository.get_event_owner = offline
    assert post(ready, event_id="unverified").status_code == 200
    assert ready.app.state.engine.calls[-1][1]["hotwords"] is None


def test_model_not_ready(phase3_client: Any) -> None:
    result = post(phase3_client)
    assert result.status_code == 503
    assert result.json()["error"]["code"] == "model_not_ready"


@pytest.mark.parametrize("fails", [False, True])
def test_no_history_no_text_logging_and_no_audio_on_disk(
    ready: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: Any, fails: bool
) -> None:
    def no_disk(**kwargs: Any) -> Any:
        raise AssertionError("dictation audio must not be written to disk")

    monkeypatch.setattr(tempfile, "NamedTemporaryFile", no_disk)
    if fails:
        ready.app.state.engine.transcribe = Mock(side_effect=RuntimeError("PRIVATE WORDS"))
    with caplog.at_level(logging.INFO):
        result = post(ready)
    assert result.status_code == (500 if fails else 200)
    if not fails:
        assert result.json() == {
            "text": "technology summit Bengaluru",
            "language": "en",
            "duration_ms": 1000,
        }
        record = next(r for r in caplog.records if r.message == "Dictation completed")
        assert record.request_id and record.duration_ms == 1000
    assert "technology summit" not in caplog.text
    assert "PRIVATE WORDS" not in caplog.text
    assert not list(ready.app.state.store.audio_dir.rglob("*.wav"))
    assert ready.get("/api/v1/sessions/unknown").status_code == 404


def test_body_limit_and_maximum_duration(ready: Any) -> None:
    assert post(ready, wav(120)).status_code == 200
    assert post(ready, b"x" * (4 * 1024 * 1024)).status_code == 413


def test_queue_admission(ready: Any) -> None:
    ready.app.state.worker.dictation_pending = ready.app.state.settings.queue_max_depth
    result = post(ready)
    assert result.status_code == 503
    assert result.json()["error"]["code"] == "queue_full"


def test_chunks_share_queue_capacity_with_dictation(ready: Any) -> None:
    from app.tests.fakes import create_session, upload_chunk

    assert create_session(ready).status_code == 201
    ready.app.state.worker.dictation_pending = ready.app.state.settings.queue_max_depth
    result = upload_chunk(ready)
    assert result.status_code == 503
    assert result.json()["error"]["code"] == "queue_full"
