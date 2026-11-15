"""Stream client commands; tokens are accepted only in headers."""

from typing import Literal

from pydantic import BaseModel

from app.models.languages import LanguageMode


class SetLanguage(BaseModel):
    type: Literal["set_language"]
    language: LanguageMode
