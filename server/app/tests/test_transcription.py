"""Engine adapter tests exercise lazy generator consumption without real inference."""

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from app.schemas.health import GpuInfo
from app.services.model_manager import ModelManager
from app.services.state import ServerState
from app.services.transcription import AudioClip, EngineError, FasterWhisperEngine


def test_adapter_parameters_lazy_iteration_and_native_times(make_settings: Any) -> None:
    settings = make_settings()
    state = ServerState(datetime.now(UTC), GpuInfo())
    calls = []

    class Model:
        def detect_language(self, audio: Any, **kwargs: Any) -> Any:
            assert manager.lock.locked() and kwargs == {"vad_filter": True}
            return "en", np.float64(0.9), [("en", np.float64(0.9))]

        def transcribe(self, audio: Any, **kwargs: Any) -> Any:
            calls.append(kwargs)

            def segments() -> Any:
                assert manager.lock.locked()
                yield SimpleNamespace(
                    start=np.float64(0.1),
                    end=np.float64(1.2),
                    text=" hello world",
                    words=[
                        SimpleNamespace(
                            start=np.float64(0.1), end=np.float64(1.2), word=" hello world"
                        )
                    ],
                )

            return segments(), None

    manager = ModelManager(settings, state, lambda *args, **kwargs: Model())
    engine = FasterWhisperEngine(manager, settings)
    clip = AudioClip(np.zeros(16000, dtype=np.float32), 1)
    assert engine.detect(clip, "turbo") == [("en", 0.9)]
    segments = []
    result = engine.transcribe(clip, "turbo", "en", "summit", segments.append)
    assert result.raw_text_full == "hello world"
    assert type(segments[0].start_ms) is int and segments[0].start_ms == 100
    assert type(result.words[0].start) is float
    assert calls == [
        {
            "language": "en",
            "vad_filter": True,
            "word_timestamps": True,
            "beam_size": 5,
            "condition_on_previous_text": False,
            "hotwords": "summit",
        }
    ]


def test_decode_errors_and_duration_limit(
    make_settings: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    import faster_whisper

    settings = make_settings()
    manager = ModelManager(
        settings, ServerState(datetime.now(UTC), GpuInfo()), lambda *a, **kw: None
    )
    engine = FasterWhisperEngine(manager, settings)

    def broken(*args: Any, **kwargs: Any) -> Any:
        raise ValueError("private path")

    monkeypatch.setattr(faster_whisper, "decode_audio", broken)
    with pytest.raises(EngineError, match="^audio_decode_failed$"):
        engine.load_audio(tmp_path / "bad.m4a")
    monkeypatch.setattr(faster_whisper, "decode_audio", lambda *a, **kw: np.zeros(34 * 16000))
    with pytest.raises(EngineError, match="^chunk_too_long$"):
        engine.load_audio(tmp_path / "long.m4a")
