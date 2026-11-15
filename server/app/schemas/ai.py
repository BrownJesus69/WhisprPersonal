"""Explicit opt-in AI request contracts."""

from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.models.ids import DocId


class AIRequest(BaseModel):
    event_id: DocId
    session_ids: list[DocId] = Field(min_length=1, max_length=20)

    @field_validator("session_ids")
    @classmethod
    def unique_sessions(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(values))


class CleanupRequest(AIRequest):
    level: Literal["conservative", "polished"] = "conservative"


class OwnerNote(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    timestamp_ms: int | None = Field(None, ge=0)
    speaker: str | None = None


class BriefRequest(AIRequest):
    brief_type: Literal["summary", "action_items", "decisions", "follow_ups", "full"] = "full"
    allow_incomplete: bool = False
    use_polished: bool = False
    notes: list[OwnerNote] = Field(default_factory=list)
