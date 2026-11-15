"""Language syntax and configuration-aware route validation."""

from typing import Annotated

from pydantic import AfterValidator

from app.config import Settings
from app.core.errors import AppError, ErrorCode

LanguageCode = Annotated[str, AfterValidator(lambda value: value.strip().lower())]
LanguageMode = LanguageCode
LANGUAGE_NAMES = {
    "kn": "Kannada",
    "ta": "Tamil",
    "hi": "Hindi",
    "en": "English",
    "te": "Telugu",
    "ml": "Malayalam",
    "mr": "Marathi",
    "bn": "Bengali",
    "gu": "Gujarati",
    "pa": "Punjabi",
}


def validate_language(code: str, settings: Settings, *, allow_auto: bool = False) -> str:
    code = code.strip().lower()
    if code not in settings.supported_languages and not (allow_auto and code == "auto"):
        raise AppError(ErrorCode.validation_error, "Language is not configured.")
    return code
