"""Environment configuration; no credentials are opened or initialized here."""

import re
from functools import lru_cache
from ipaddress import ip_network
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import Field, SecretStr, ValidationInfo, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
        hide_input_in_errors=True,
    )

    app_env: Literal["development", "production"] = "development"
    log_level: str = "INFO"
    log_format: Literal["json", "console"] = "json"
    port: int = Field(8000, ge=1, le=65535)
    enable_api_docs: bool = True
    server_shared_secret: SecretStr | None = Field(None, repr=False)
    firebase_credentials_path: Path | None = Field(None, repr=False)
    firebase_project_id: str | None = None
    firebase_check_revoked: bool = False
    firebase_clock_skew_s: int = Field(5, ge=0, le=60)
    firebase_database_id: str | None = None
    auth_allowed_uids: Annotated[list[str], NoDecode] = Field(default_factory=list, repr=False)
    auth_allowed_emails: Annotated[list[str], NoDecode] = Field(default_factory=list, repr=False)
    groq_api_key: SecretStr | None = Field(None, repr=False)
    groq_base_url: str = Field("https://api.groq.com/openai/v1", repr=False)
    groq_model: str | None = None
    groq_timeout_s: float = Field(30, gt=0)
    groq_max_concurrency: int = Field(2, gt=0)
    groq_max_rpm: int | None = Field(None, gt=0)
    sambanova_api_key: SecretStr | None = Field(None, repr=False)
    sambanova_base_url: str = Field("https://api.sambanova.ai/v1", repr=False)
    sambanova_model: str | None = None
    sambanova_timeout_s: float = Field(30, gt=0)
    sambanova_max_concurrency: int = Field(2, gt=0)
    sambanova_max_rpm: int | None = Field(None, gt=0)
    local_llm_base_url: str | None = Field(None, repr=False)
    local_llm_model: str | None = None
    whisper_model: str = "large-v3-turbo"
    whisper_fallback_model: str = "large-v3"
    whisper_device: Literal["auto", "cuda", "cpu"] = "auto"
    whisper_compute_type: str = "float16"
    whisper_beam_size: int = Field(5, ge=1, le=10)
    whisper_local_files_only: bool = False
    whisper_preload: bool = True
    whisper_max_loaded_models: int = Field(1, ge=1, le=2)
    supported_languages: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["kn", "ta", "hi", "en"]
    )
    language_detect_window_s: float = Field(15, ge=10, le=20)
    language_lock_min_chunks: int = Field(2, ge=1)
    language_lock_threshold: float = Field(0.6, ge=0, le=1)
    language_uncertain_threshold: float = Field(0.5, ge=0, le=1)
    language_switch_threshold: float = Field(0.8, ge=0, le=1)
    language_switch_consecutive: int = Field(2, ge=1)
    max_chunk_duration_s: int = Field(30, ge=1)
    max_overlap_ms: int = Field(3000, ge=0)
    chunk_max_attempts: int = Field(3, ge=1)
    chunk_retry_base_s: float = Field(2, gt=0)
    shutdown_drain_timeout_s: float = Field(20, gt=0, lt=30)
    server_audio_retention: Literal["keep", "delete_on_finalize"] = "keep"
    firestore_sync_retry_s: int = Field(60, ge=1)
    firestore_timeout_s: float = Field(10, gt=0, le=120)
    allowed_audio_extensions: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: "m4a,mp4,aac,3gp,wav,ogg,webm,flac,mp3".split(",")
    )
    vocabulary_max_terms: int = Field(200, ge=1)
    models_dir: Path = Field(Path("./models"), repr=False)
    data_dir: Path = Field(Path("./data"), repr=False)
    queue_max_depth: int = Field(500, gt=0)
    worker_count: int = Field(1, ge=1, le=1)
    max_chunk_upload_bytes: int = Field(8_388_608, gt=0)
    max_json_body_bytes: int = Field(1_048_576, gt=0)
    rate_limit_global_per_minute: int = Field(1200, gt=0)
    rate_limit_per_ip_per_minute: int = Field(300, gt=0)
    rate_limit_per_user_per_minute: int = Field(240, gt=0)
    allowed_client_networks: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: [
            "127.0.0.0/8",
            "10.0.0.0/8",
            "172.16.0.0/12",
            "192.168.0.0/16",
            "100.64.0.0/10",
            "::1/128",
            "fc00::/7",
            "fe80::/10",
        ]
    )
    trust_proxy_headers: bool = False
    cors_allowed_origins: Annotated[list[str], NoDecode] = Field(default_factory=list)
    gpu_detection: Literal["auto", "off"] = "auto"
    feature_translation: bool = False
    feature_calendar: bool = False
    feature_drive: bool = False
    feature_gmail: bool = False
    feature_app_check: bool = False
    feature_fcm: bool = False
    feature_web_search: bool = False
    feature_cloud_whisper: bool = False

    @field_validator("whisper_model", "whisper_fallback_model", mode="before")
    @classmethod
    def empty_model_uses_default(cls, value: Any, info: ValidationInfo) -> Any:
        if isinstance(value, str) and not value.strip() and info.field_name is not None:
            return cls.model_fields[info.field_name].default
        return value

    @field_validator(
        "server_shared_secret",
        "firebase_credentials_path",
        "firebase_project_id",
        "firebase_database_id",
        "groq_api_key",
        "groq_model",
        "groq_max_rpm",
        "sambanova_api_key",
        "sambanova_model",
        "sambanova_max_rpm",
        "local_llm_base_url",
        "local_llm_model",
        mode="before",
    )
    @classmethod
    def empty_optional(cls, value: Any) -> Any:
        return None if isinstance(value, str) and not value.strip() else value

    @field_validator("server_shared_secret")
    @classmethod
    def strong_shared_secret(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None and len(value.get_secret_value()) < 32:
            raise ValueError("Shared secret must contain at least 32 characters")
        return value

    @field_validator(
        "supported_languages",
        "allowed_audio_extensions",
        "allowed_client_networks",
        "cors_allowed_origins",
        "auth_allowed_uids",
        "auth_allowed_emails",
        mode="before",
    )
    @classmethod
    def comma_list(cls, value: Any) -> Any:
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value

    @field_validator("supported_languages")
    @classmethod
    def valid_languages(cls, values: list[str]) -> list[str]:
        # Import only the tokenizer constants, never initialize a model or probe CUDA.
        from app.services.cuda_windows import prepare_cuda_dlls

        cuda_dirs = prepare_cuda_dlls()
        from faster_whisper.tokenizer import _LANGUAGE_CODES

        del cuda_dirs  # ModelManager retains its own handles while models are in use.

        values = list(dict.fromkeys(value.lower() for value in values))
        if not values or any(value not in _LANGUAGE_CODES for value in values):
            raise ValueError("Unsupported language configuration")
        return values

    @field_validator("auth_allowed_uids")
    @classmethod
    def valid_uids(cls, values: list[str]) -> list[str]:
        if any(re.fullmatch(r"[A-Za-z0-9]{1,128}", value) is None for value in values):
            raise ValueError("Invalid allowed uid")
        return values

    @field_validator("auth_allowed_emails")
    @classmethod
    def normalized_emails(cls, values: list[str]) -> list[str]:
        return [value.lower() for value in values]

    @field_validator("allowed_client_networks")
    @classmethod
    def valid_networks(cls, values: list[str]) -> list[str]:
        for value in values:
            ip_network(value, strict=False)
        return values

    @field_validator("cors_allowed_origins")
    @classmethod
    def explicit_origins(cls, values: list[str]) -> list[str]:
        if any("*" in value for value in values):
            raise ValueError("CORS origins must be explicit")
        return values

    @property
    def groq_configured(self) -> bool:
        return bool(self.groq_api_key and self.groq_model)

    @property
    def sambanova_configured(self) -> bool:
        return bool(self.sambanova_api_key and self.sambanova_model)

    @property
    def local_llm_configured(self) -> bool:
        return bool(self.local_llm_base_url and self.local_llm_model)

    @property
    def firebase_credentials_present(self) -> bool:
        try:
            return bool(self.firebase_credentials_path and self.firebase_credentials_path.is_file())
        except OSError:
            return False

    def safe_summary(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for name in type(self).model_fields:
            value = getattr(self, name)
            if name in {"auth_allowed_uids", "auth_allowed_emails"}:
                result[f"{name}_count"] = len(value)
            elif name in {"models_dir", "data_dir", "firebase_credentials_path"} or name.endswith(
                ("_api_key", "_shared_secret")
            ):
                result[f"{name}_set"] = bool(value)
            elif name.endswith("_base_url"):
                # URLs can contain credentials, query data or local filesystem paths.
                result[f"{name}_set"] = bool(value)
            else:
                result[name] = value
        return result


@lru_cache
def get_settings() -> Settings:
    return Settings()
