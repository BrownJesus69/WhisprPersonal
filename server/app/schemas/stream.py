"""Stream client commands; tokens are accepted only in headers."""

from typing import Literal, TypeAlias

from pydantic import BaseModel

from app.models.languages import LanguageMode


class SetLanguage(BaseModel):
    type: Literal["set_language"]
    language: LanguageMode


StreamEventType: TypeAlias = Literal[
    "chunk_queued",
    "chunk_processing",
    "transcript_final",
    "transcript_revised",
    "chunk_failed",
    "language_locked",
    "language_changed",
    "language_override",
    "session_finalizing",
    "session_finalized",
    "session_deleted",
    "chunk_audio_translated",
]


class AudioTranslationData(BaseModel):
    sequence: int
    target_lang: Literal["en"]
    engine: Literal["groq-audio-translation"]


class ChunkAudioTranslated(BaseModel):
    type: Literal["chunk_audio_translated"]
    seq: int
    session_id: str
    ts: str
    data: AudioTranslationData
