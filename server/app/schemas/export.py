"""Owner transcript export request."""

from typing import Literal

from pydantic import BaseModel, Field

from app.models.ids import DocId


class ExportRequest(BaseModel):
    event_id: DocId
    session_ids: list[DocId] = Field(min_length=1, max_length=20)
    format: Literal["md", "txt"]
    text: Literal["raw", "polished"] = "raw"
    title: str | None = Field(default=None, max_length=200)
