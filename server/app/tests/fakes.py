"""Scriptable offline engine and cloud boundaries shared by Phase 3 tests."""

from collections import deque
from collections.abc import Callable
from pathlib import Path
from typing import Any

from app.services.firestore_sync import FirestoreSyncError
from app.services.overlap import Word
from app.services.transcription import AudioClip, EngineError, EngineOutput, SegmentOut


class FakeEngine:
    def __init__(
        self,
        speech: list[float] | None = None,
        probs: list[list[tuple[str, float]]] | None = None,
        failures: int = 0,
        output: EngineOutput | None = None,
    ) -> None:
        self.speech = deque(speech or [16.0])
        self.probs = deque(probs or [[("en", 0.95), ("kn", 0.05)]])
        self.failures = failures
        self.output = output or EngineOutput(
            "technology summit Bengaluru",
            [
                Word(1.0, 2.0, " technology"),
                Word(2.0, 3.0, " summit"),
                Word(3.0, 4.0, " Bengaluru"),
            ],
        )
        self.calls: list[tuple[str, Any]] = []

    def load_audio(self, path: Path) -> AudioClip:
        self.calls.append(("load", path.name))
        if self.failures:
            self.failures -= 1
            raise EngineError("audio_decode_failed")
        return AudioClip(None, 16.0)

    def speech_seconds(self, clip: AudioClip) -> float:
        self.calls.append(("vad", None))
        return self.speech.popleft() if len(self.speech) > 1 else self.speech[0]

    def detect(self, clip: AudioClip, profile: str) -> list[tuple[str, float]]:
        self.calls.append(("detect", profile))
        return self.probs.popleft() if len(self.probs) > 1 else self.probs[0]

    def transcribe(
        self,
        clip: AudioClip,
        profile: str,
        language: str,
        hotwords: str | None,
        on_segment: Callable[[SegmentOut], None],
    ) -> EngineOutput:
        self.calls.append(("transcribe", {"language": language, "hotwords": hotwords}))
        on_segment(SegmentOut(1000, 4000, self.output.raw_text_full))
        return self.output


class FakeEventRepo:
    async def get_event_owner(self, event_id: str) -> str | None:
        return {"event1": "user-1", "other": "user-2"}.get(event_id)


class FakeFirestoreSync:
    enabled = True

    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.fail = False

    def check(self) -> None:
        if self.fail:
            raise FirestoreSyncError("firestore_unavailable")

    async def session_started(self, session: dict[str, Any]) -> None:
        self.check()
        self.calls.append(("started", session))

    async def session_finalized(
        self, session: dict[str, Any], chunks: list[dict[str, Any]]
    ) -> None:
        self.check()
        self.calls.append(("finalized", (session, chunks)))

    async def delete_session(self, event_id: str, session_id: str) -> None:
        self.check()
        self.calls.append(("deleted", (event_id, session_id)))


def create_session(client: Any, session_id: str = "session1", **values: Any) -> Any:
    return client.post(
        "/api/v1/sessions", json={"session_id": session_id, "event_id": "event1", **values}
    )


def upload_chunk(
    client: Any,
    sequence: int = 0,
    chunk_id: str | None = None,
    session_id: str = "session1",
    audio: bytes = b"fake-audio",
    filename: str = "audio.m4a",
    **values: Any,
) -> Any:
    return client.post(
        f"/api/v1/sessions/{session_id}/chunks",
        data={
            "chunk_id": chunk_id or f"chunk{sequence}",
            "sequence": sequence,
            "start_ms": sequence * 16000,
            "end_ms": (sequence + 1) * 16000,
            "overlap_ms": 0,
            "continues": "false",
            **values,
        },
        files={"file": (filename, audio, "audio/mp4")},
    )


def wait_done(client: Any, status: str = "done", sequence: int = 0) -> dict[str, Any]:
    import time

    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        response = client.get("/api/v1/sessions/session1").json()
        for chunk in response["chunks"]:
            if chunk["sequence"] == sequence and chunk["status"] == status:
                return response
        time.sleep(0.01)
    raise AssertionError(f"Chunk did not reach {status}")
