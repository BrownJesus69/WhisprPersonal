"""Synchronous engine boundary; only the serialized worker executor calls this."""

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from app.config import Settings
from app.services.model_manager import ModelManager
from app.services.overlap import Word


class EngineError(Exception):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass
class AudioClip:
    samples: Any
    duration_s: float


@dataclass
class SegmentOut:
    start_ms: int
    end_ms: int
    text: str


@dataclass
class EngineOutput:
    raw_text_full: str = ""
    words: list[Word] = field(default_factory=list)


class TranscriptionEngine(Protocol):
    def load_audio(self, path: Path) -> AudioClip: ...
    def speech_seconds(self, clip: AudioClip) -> float: ...
    def detect(self, clip: AudioClip, profile: str) -> list[tuple[str, float]]: ...
    def transcribe(
        self,
        clip: AudioClip,
        profile: str,
        language: str,
        hotwords: str | None,
        on_segment: Callable[[SegmentOut], None],
    ) -> EngineOutput: ...


class FasterWhisperEngine:
    def __init__(self, model_manager: ModelManager, settings: Settings) -> None:
        self.manager, self.settings = model_manager, settings

    def load_audio(self, path: Path) -> AudioClip:
        try:
            from faster_whisper import decode_audio

            samples = decode_audio(str(path), sampling_rate=16000)
        except Exception:
            raise EngineError("audio_decode_failed") from None
        duration = len(samples) / 16000
        if duration > self.settings.max_chunk_duration_s + self.settings.max_overlap_ms / 1000:
            raise EngineError("chunk_too_long")
        return AudioClip(samples, duration)

    def speech_seconds(self, clip: AudioClip) -> float:
        from faster_whisper.vad import get_speech_timestamps

        return float(
            sum(
                item["end"] - item["start"]
                for item in get_speech_timestamps(clip.samples, sampling_rate=16000)
            )
            / 16000
        )

    def detect(self, clip: AudioClip, profile: str) -> list[tuple[str, float]]:
        try:
            with self.manager.lock:
                _, _, probs = self.manager.get(profile).detect_language(
                    clip.samples, vad_filter=True
                )
                return [(code, float(prob)) for code, prob in probs]
        except Exception:
            raise EngineError("transcription_failed") from None

    def transcribe(
        self,
        clip: AudioClip,
        profile: str,
        language: str,
        hotwords: str | None,
        on_segment: Callable[[SegmentOut], None],
    ) -> EngineOutput:
        try:
            with self.manager.lock:
                segments, _ = self.manager.get(profile).transcribe(
                    clip.samples,
                    language=language,
                    vad_filter=True,
                    word_timestamps=True,
                    beam_size=self.settings.whisper_beam_size,
                    condition_on_previous_text=False,
                    hotwords=hotwords,
                )
                output = EngineOutput()
                for index, segment in enumerate(segments):
                    on_segment(
                        SegmentOut(
                            int(float(segment.start) * 1000),
                            int(float(segment.end) * 1000),
                            segment.text,
                        )
                    )
                    output.raw_text_full += segment.text
                    output.words.extend(
                        Word(float(word.start), float(word.end), word.word, index)
                        for word in segment.words or []
                    )
                output.raw_text_full = " ".join(output.raw_text_full.split())
                return output
        except Exception:
            raise EngineError("transcription_failed") from None
