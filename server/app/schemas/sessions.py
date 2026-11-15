"""Session request and safe response contracts."""

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.models.ids import DocId
from app.models.languages import LanguageCode, LanguageMode


class SessionCreate(BaseModel):
    session_id: DocId
    event_id: DocId
    language_mode: LanguageMode = "auto"
    expected_languages: list[LanguageCode] = Field(default_factory=list)
    model_profile: Literal["turbo", "accurate"] = "turbo"
    overlap_ms: int = Field(0, ge=0)


class FinalizeRequest(BaseModel):
    expected_chunk_count: int | None = Field(None, ge=0, le=100001)
    force: bool = False


class LanguageRequest(BaseModel):
    language: LanguageMode


class ChunkOut(BaseModel):
    chunk_id: str
    sequence: int
    start_ms: int
    end_ms: int
    status: str
    raw_text: str | None = None
    segments: list[dict[str, Any]] = Field(default_factory=list)
    detected_language: str | None = None
    language_confidence: float | None = None
    language_source: str | None = None
    language_uncertain: bool = False
    no_speech: bool = False
    error_code: str | None = None


class SessionOut(BaseModel):
    session_id: str
    event_id: str
    status: str
    transcript_status: str
    model_profile: str
    model_name: str
    language: dict[str, Any]
    counts: dict[str, int]
    missing_sequences: list[int]
    chunks: list[ChunkOut]
    transcript_text: str | None = None
    last_event_seq: int
    firestore_sync: str
