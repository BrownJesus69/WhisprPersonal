"""Synchronous engine boundary; only the serialized worker executor calls this."""

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from app.config import Settings
from app.services.indic_asr import IndicConformer
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
            if self.manager.state.model_status == "error" and self.manager.state.model_error in {
                "load_failed",
                "model_files_missing",
                "cuda_unavailable",
                "model_not_ready",
            }:
                raise EngineError(self.manager.state.model_error) from None
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
            if self.manager.state.model_status == "error" and self.manager.state.model_error in {
                "load_failed",
                "model_files_missing",
                "cuda_unavailable",
                "model_not_ready",
            }:
                raise EngineError(self.manager.state.model_error) from None
            raise EngineError("transcription_failed") from None


class CompositeEngine:
    """Called on the worker's single executor, including keyboard dictation."""

    def __init__(self, whisper: TranscriptionEngine, settings: Settings) -> None:
        self.whisper = whisper
        self.settings = settings
        model_dir = settings.indic_asr_model_dir
        if not model_dir.is_absolute():
            model_dir = settings.models_dir / model_dir
        self.indic = IndicConformer(
            model_dir, settings.indic_asr_languages, settings.indic_asr_enabled
        )

    def load_audio(self, path: Path) -> AudioClip:
        return self.whisper.load_audio(path)

    def speech_seconds(self, clip: AudioClip) -> float:
        return self.whisper.speech_seconds(clip)

    def detect(self, clip: AudioClip, profile: str) -> list[tuple[str, float]]:
        return self.whisper.detect(clip, profile)

    def transcribe(
        self,
        clip: AudioClip,
        profile: str,
        language: str,
        hotwords: str | None,
        on_segment: Callable[[SegmentOut], None],
    ) -> EngineOutput:
        if language in self.settings.indic_asr_languages and self.indic.available:
            logger = logging.getLogger(__name__)
            try:
                text, words = self.indic.transcribe(clip.samples, language)
            except Exception:
                logger.warning(
                    "Indic ASR failed; using Whisper", extra={"event": "indic_asr_failed"}
                )
            else:
                if hotwords:
                    logger.debug(
                        "Personal words do not apply to Indic ASR",
                        extra={"event": "indic_asr_hotwords_ignored"},
                    )
                if text:
                    on_segment(
                        SegmentOut(round(words[0].start * 1000), round(words[-1].end * 1000), text)
                    )
                return EngineOutput(text, words)
        return self.whisper.transcribe(clip, profile, language, hotwords, on_segment)
