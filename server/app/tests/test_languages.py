from typing import Any

import pytest
from pydantic import ValidationError

from app.core.errors import AppError
from app.models.languages import LANGUAGE_NAMES, validate_language


def test_languages(make_settings: Any) -> None:
    settings = make_settings(supported_languages="kn,en,te")
    assert validate_language(" TE ", settings) == "te"
    assert LANGUAGE_NAMES["kn"] == "Kannada"
    assert validate_language("auto", settings, allow_auto=True) == "auto"
    with pytest.raises(AppError):
        validate_language("hi", settings)
    with pytest.raises(ValidationError):
        make_settings(supported_languages="nonsense")
