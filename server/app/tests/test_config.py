import secrets
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from app.config import Settings


def test_invalid_settings(make_settings: Any) -> None:
    for values in (
        {"server_shared_secret": "short"},
        {"cors_allowed_origins": "*"},
        {"allowed_client_networks": "not-a-network"},
    ):
        with pytest.raises(ValidationError):
            make_settings(**values)


def test_env_comma_lists(make_settings: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    make_settings()
    monkeypatch.setenv("ALLOWED_CLIENT_NETWORKS", "127.0.0.0/8, 100.64.0.0/10")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://one.example,https://two.example")
    settings = Settings(_env_file=None)
    assert settings.allowed_client_networks == ["127.0.0.0/8", "100.64.0.0/10"]
    assert len(settings.cors_allowed_origins) == 2
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "*")
    with pytest.raises(ValidationError):
        Settings(_env_file=None)


def test_summary_and_repr(make_settings: Any, tmp_path: Path) -> None:
    key = secrets.token_urlsafe(36)
    settings = make_settings(groq_api_key=key, firebase_credentials_path=tmp_path / "absent")
    for output in (repr(settings), str(settings.safe_summary())):
        assert key not in output
        assert settings.server_shared_secret.get_secret_value() not in output
        assert str(tmp_path) not in output
    assert settings.safe_summary()["server_shared_secret_set"] is True
    assert settings.firebase_credentials_present is False


def test_empty_optional_env(make_settings: Any) -> None:
    settings = make_settings(server_shared_secret="", firebase_credentials_path="", groq_model="")
    assert settings.server_shared_secret is None
    assert settings.firebase_credentials_path is None
    assert not settings.groq_configured


def test_invalid_secret_is_not_printed(make_settings: Any) -> None:
    value = secrets.token_urlsafe(8)
    with pytest.raises(ValidationError) as error:
        make_settings(server_shared_secret=value)
    assert value not in str(error.value)


def test_example_covers_settings(make_settings: Any) -> None:
    make_settings()
    # Read only the public example, never a real environment file.
    example = Path(".env.example").read_text(encoding="utf-8")
    names = {
        line.split("=", 1)[0]
        for line in example.splitlines()
        if "=" in line and not line.startswith("#")
    }
    assert {name.upper() for name in Settings.model_fields} <= names
    settings = Settings(_env_file=".env.example", gpu_detection="off")
    assert settings.server_shared_secret is None
    assert settings.groq_model is None
    assert settings.whisper_model == Settings.model_fields["whisper_model"].default
