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


@pytest.mark.parametrize(
    "name",
    [
        "ai_max_input_chars",
        "ai_max_output_tokens",
        "ai_cleanup_window_chars",
        "ai_temperature",
        "ai_retry_max_attempts",
        "ai_retry_max_wait_s",
        "ai_circuit_failure_threshold",
        "ai_circuit_cooldown_s",
        "ai_user_requests_per_minute",
        "ai_global_requests_per_minute",
        "ai_queue_max",
        "ai_job_timeout_s",
        "ai_brief_max_notes",
        "local_llm_timeout_s",
        "local_llm_max_concurrency",
        "local_llm_max_rpm",
    ],
)
def test_ai_positive_settings(make_settings: Any, name: str) -> None:
    with pytest.raises(ValidationError):
        make_settings(**{name: 0})


def test_ai_configuration_requires_model_and_secret_or_url(make_settings: Any) -> None:
    assert not make_settings(groq_api_key="mock-secret").groq_configured
    assert not make_settings(sambanova_model="mock-model").sambanova_configured
    assert not make_settings(local_llm_base_url="http://127.0.0.1/v1").local_llm_configured
    settings = make_settings(
        local_llm_api_key="mock-local-secret",
        local_llm_model="mock-model",
        local_llm_base_url="http://127.0.0.1/v1",
    )
    assert settings.local_llm_configured
    assert "mock-local-secret" not in str(settings.safe_summary())
    with pytest.raises(ValidationError):
        make_settings(ai_temperature=2.1)


@pytest.mark.parametrize(
    "url,valid",
    [
        ("http://localhost:9000/v1", True),
        ("http://127.0.0.1:9000/v1", True),
        ("http://[::1]:9000/v1", True),
        ("https://remote.example/v1", False),
        ("http://192.168.1.1/v1", False),
        ("file:///model", False),
        ("http://private:secret@localhost/v1", False),
        ("http://localhost/v1?key=private", False),
    ],
)
def test_local_llm_loopback_only(make_settings: Any, url: str, valid: bool) -> None:
    if valid:
        assert make_settings(
            local_llm_base_url=url, local_llm_model="mock-model"
        ).local_llm_configured
    else:
        with pytest.raises(ValidationError):
            make_settings(local_llm_base_url=url, local_llm_model="mock-model")


def test_translation_configuration_is_local_and_audio_requires_explicit_opt_in(
    make_settings: Any,
) -> None:
    private_secret = secrets.token_urlsafe(36)
    settings = make_settings(
        translator_shared_secret=private_secret,
        groq_api_key="mock-test-key",
        groq_audio_translation_model="audio-test-model",
    )
    assert not settings.groq_audio_configured
    assert private_secret not in str(settings.safe_summary())
    assert not settings.groq_configured  # Text LLM model remains independently unconfigured.
    assert make_settings(
        groq_audio_fallback_enabled=True,
        groq_api_key="mock-test-key",
        groq_audio_translation_model="audio-test-model",
    ).groq_audio_configured
    assert not make_settings(
        groq_audio_fallback_enabled=True, groq_api_key="mock-test-key"
    ).groq_audio_configured
    with pytest.raises(ValidationError):
        make_settings(translator_url="http://remote.example:8100")
    with pytest.raises(ValidationError):
        make_settings(libretranslate_enabled_pairs=["hi-hi"])
