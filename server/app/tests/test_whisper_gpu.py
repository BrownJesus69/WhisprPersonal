import os
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.config import Settings
from app.schemas.health import GpuInfo
from app.services.model_manager import ModelManager
from app.services.transcription import AudioClip, FasterWhisperEngine


@pytest.mark.gpu
@pytest.mark.skipif(os.environ.get("WHISPR_RUN_GPU_TESTS") != "1", reason="Opt-in real GPU test")
def test_real_whisper_turbo() -> None:
    import numpy as np

    models = Path(__file__).resolve().parents[2] / "models"
    if not list(
        models.glob("models--mobiuslabsgmbh--faster-whisper-large-v3-turbo/snapshots/*/model.bin")
    ):
        pytest.skip("Turbo model is not cached locally")
    settings = Settings(
        _env_file=None,
        models_dir=models,
        whisper_local_files_only=True,
        whisper_device="cuda",
        gpu_detection="off",
    )
    manager = ModelManager(settings, ServerState(datetime.now(UTC), GpuInfo()))
    engine = FasterWhisperEngine(manager, settings)
    clip = engine.load_audio(Path(__file__).parent / "fixtures/en_sample.m4a")
    assert engine.speech_seconds(clip) > 10
    assert engine.detect(clip, "turbo")[0][0] == "en"
    segments = []
    result = engine.transcribe(clip, "turbo", "en", None, segments.append)
    assert "technology summit" in result.raw_text_full.lower()
    assert "bengaluru" in result.raw_text_full.lower()
    assert segments and all(
        isinstance(segment.start_ms, int) and isinstance(segment.end_ms, int)
        for segment in segments
    )
    assert engine.speech_seconds(AudioClip(np.zeros(16000, dtype=np.float32), 1.0)) == 0


from app.services.state import ServerState  # noqa: E402
