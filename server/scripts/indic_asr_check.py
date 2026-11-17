"""Manual local recording check; prints private transcript text only when explicitly run."""

import argparse
import re
import sys
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings  # noqa: E402
from app.schemas.health import GpuInfo  # noqa: E402
from app.services.model_manager import ModelManager  # noqa: E402
from app.services.state import ServerState  # noqa: E402
from app.services.transcription import CompositeEngine, FasterWhisperEngine  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session_id")
    parser.add_argument("language", choices=["kn", "hi", "ta"])
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]+", args.session_id):
        parser.error("Invalid session id")
    # Model checks never need to read the owner's environment file or credentials.
    settings = Settings(_env_file=None, whisper_local_files_only=True, whisper_preload=False)
    state = ServerState(started_at=datetime.now(UTC), gpu=GpuInfo(detection="disabled"))
    manager = ModelManager(settings, state)
    engine = CompositeEngine(FasterWhisperEngine(manager, settings), settings)
    audio_dir = settings.data_dir / "audio" / args.session_id
    paths = sorted(audio_dir.rglob("*.wav"))
    if not paths:
        parser.error("No WAV chunks found for this session")
    print(f"Indic ASR: {engine.indic.status}")
    for path in paths:
        started = perf_counter()
        clip = engine.load_audio(path)
        output = engine.transcribe(clip, "turbo", args.language, None, lambda segment: None)
        print(f"{path.name}: {perf_counter() - started:.3f} s ({engine.indic.status})")
        print(output.raw_text_full)


if __name__ == "__main__":
    main()
