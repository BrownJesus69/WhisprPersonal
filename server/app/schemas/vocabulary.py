"""Vocabulary hints; replacements are reserved for the future polished layer."""

from pydantic import BaseModel, Field, field_validator

from app.models.ids import DocId


class Replacement(BaseModel):
    from_: str = Field(alias="from", min_length=1)
    to: str = Field(min_length=1)


class VocabularyIn(BaseModel):
    event_id: DocId
    terms: list[str] = Field(default_factory=list)
    replacements: list[Replacement] = Field(default_factory=list, max_length=200)

    @field_validator("terms")
    @classmethod
    def normalize(cls, terms: list[str]) -> list[str]:
        if any(len(term) > 64 for term in terms):
            raise ValueError("Terms must be at most 64 characters")
        return list(dict.fromkeys(term.strip() for term in terms if term.strip()))
