"""Environment configuration; no credentials are opened or initialized here."""

import re
import sys
from functools import lru_cache
from ipaddress import ip_address, ip_network
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

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
    auth_grant_enabled: bool = True
    auth_grant_ttl_hours: float = Field(12, ge=1, le=24)
    auth_grant_signing_key: SecretStr | None = Field(None, repr=False)
    groq_api_key: SecretStr | None = Field(None, repr=False)
    groq_base_url: str = Field("https://api.groq.com/openai/v1", repr=False)
    groq_model: str | None = None
    groq_timeout_s: float = Field(30, gt=0)
    groq_max_concurrency: int = Field(2, gt=0)
    groq_max_rpm: int | None = Field(None, gt=0)
    translator_url: str = Field("http://127.0.0.1:8100", repr=False)
    translator_shared_secret: SecretStr | None = Field(None, repr=False)
    translator_timeout_s: float = Field(60, gt=0)
    libretranslate_url: str = Field("http://127.0.0.1:5000", repr=False)
    libretranslate_enabled_pairs: Annotated[list[str], NoDecode] = Field(default_factory=list)
    translation_benchmark_path: Path = Field(
        Path("../translator/benchmarks/latest.json"), repr=False
    )
    groq_audio_fallback_enabled: bool = False
    groq_audio_translation_model: str | None = None
    sambanova_api_key: SecretStr | None = Field(None, repr=False)
    sambanova_base_url: str = Field("https://api.sambanova.ai/v1", repr=False)
    sambanova_model: str | None = None
    sambanova_timeout_s: float = Field(30, gt=0)
    sambanova_max_concurrency: int = Field(2, gt=0)
    sambanova_max_rpm: int | None = Field(None, gt=0)
    local_llm_base_url: str | None = Field(None, repr=False)
    local_llm_model: str | None = None
    local_llm_api_key: SecretStr | None = Field(None, repr=False)
    local_llm_timeout_s: float = Field(30, gt=0)
    local_llm_max_concurrency: int = Field(2, gt=0)
    local_llm_max_rpm: int | None = Field(None, gt=0)
    # Laptop safety budgets, never provider quotas.
    ai_max_input_chars: int = Field(12000, gt=0)
    ai_max_output_tokens: int = Field(2048, gt=0)
    # Cleanup output is as long as its input, and Indic scripts cost several tokens per
    # character: keep cleanup windows well inside ai_max_output_tokens.
    ai_cleanup_window_chars: int = Field(3000, gt=0)
    ai_temperature: float = Field(0.2, gt=0, le=2)
    ai_retry_max_attempts: int = Field(3, gt=0)
    ai_retry_max_wait_s: float = Field(20, gt=0)
    ai_circuit_failure_threshold: int = Field(3, gt=0)
    ai_circuit_cooldown_s: float = Field(60, gt=0)
    ai_user_requests_per_minute: int = Field(6, gt=0)
    ai_global_requests_per_minute: int = Field(20, gt=0)
    ai_queue_max: int = Field(8, gt=0)
    ai_job_timeout_s: float = Field(600, gt=0)
    ai_brief_max_notes: int = Field(200, gt=0)
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
    indic_asr_enabled: bool = True
    indic_asr_model_dir: Path = Field(
        Path(
            "models--ai4bharat--indic-conformer-600m-multilingual/snapshots/"
            "2a77d305038dfc502fd9464e7d028b90381976cb"
        ),
        repr=False,
    )
    indic_asr_languages: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda data: [
            lang for lang in ["kn", "hi", "ta"] if lang in data.get("supported_languages", [])
        ]
    )
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
    # Future provider identifiers only; no SDK/client is initialized from these placeholders.
    calendar_account: str | None = None
    drive_folder_id: str | None = None
    gmail_account: str | None = None
    app_check_project_id: str | None = None
    fcm_project_id: str | None = None
    web_search_api_key: SecretStr | None = Field(None, repr=False)
    cloud_whisper_api_key: SecretStr | None = Field(None, repr=False)
    cloud_whisper_model: str | None = None
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
        "calendar_account",
        "drive_folder_id",
        "gmail_account",
        "app_check_project_id",
        "fcm_project_id",
        "web_search_api_key",
        "cloud_whisper_api_key",
        "cloud_whisper_model",
        "server_shared_secret",
        "auth_grant_signing_key",
        "firebase_credentials_path",
        "firebase_project_id",
        "firebase_database_id",
        "groq_api_key",
        "translator_shared_secret",
        "groq_audio_translation_model",
        "groq_model",
        "groq_max_rpm",
        "sambanova_api_key",
        "sambanova_model",
        "sambanova_max_rpm",
        "local_llm_base_url",
        "local_llm_model",
        "local_llm_api_key",
        "local_llm_max_rpm",
        mode="before",
    )
    @classmethod
    def empty_optional(cls, value: Any) -> Any:
        return None if isinstance(value, str) and not value.strip() else value

    @field_validator("server_shared_secret", "auth_grant_signing_key")
    @classmethod
    def strong_shared_secret(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None and len(value.get_secret_value()) < 32:
            raise ValueError("Shared secret must contain at least 32 characters")
        return value

    @field_validator("local_llm_base_url", "translator_url", "libretranslate_url")
    @classmethod
    def local_llm_stays_on_laptop(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            parsed = urlsplit(value)
            host = parsed.hostname or ""
            local = host == "localhost" or ip_address(host).is_loopback
            if (
                not local
                or parsed.scheme not in {"http", "https"}
                or parsed.username
                or parsed.password
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError
        except ValueError:
            raise ValueError(
                "Local LLM URL must be an HTTP(S) loopback URL without credentials."
            ) from None
        return value

    @field_validator(
        "supported_languages",
        "indic_asr_languages",
        "allowed_audio_extensions",
        "allowed_client_networks",
        "cors_allowed_origins",
        "auth_allowed_uids",
        "auth_allowed_emails",
        "libretranslate_enabled_pairs",
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

        # Tokenizer imports native libraries only once. Re-registering DLL directories
        # for every Settings instance leaks Windows loader registrations in long processes.
        cuda_dirs = prepare_cuda_dlls() if "faster_whisper.tokenizer" not in sys.modules else None
        from faster_whisper.tokenizer import _LANGUAGE_CODES

        del cuda_dirs  # ModelManager retains its own handles while models are in use.

        values = list(dict.fromkeys(value.lower() for value in values))
        if not values or any(value not in _LANGUAGE_CODES for value in values):
            raise ValueError("Unsupported language configuration")
        return values

    @field_validator("indic_asr_languages")
    @classmethod
    def valid_indic_languages(cls, values: list[str], info: ValidationInfo) -> list[str]:
        values = list(dict.fromkeys(value.lower() for value in values))
        if any(value not in info.data.get("supported_languages", []) for value in values):
            raise ValueError("Indic ASR languages must be supported server languages")
        return values

    @field_validator("libretranslate_enabled_pairs")
    @classmethod
    def valid_translation_pairs(cls, values: list[str]) -> list[str]:
        languages = {"kn", "ta", "hi", "en"}
        valid = {
            f"{source}-{target}" for source in languages for target in languages if source != target
        }
        if any(value not in valid for value in values):
            raise ValueError("Translation pairs must be directed pairs among kn, ta, hi, en")
        return list(dict.fromkeys(values))

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
    def groq_audio_configured(self) -> bool:
        return bool(
            self.groq_audio_fallback_enabled
            and self.groq_api_key
            and self.groq_audio_translation_model
        )

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
            elif name in {
                "models_dir",
                "data_dir",
                "firebase_credentials_path",
                "indic_asr_model_dir",
            } or name.endswith(("_api_key", "_shared_secret", "_signing_key")):
                result[f"{name}_set"] = bool(value)
            elif name in {
                "calendar_account",
                "drive_folder_id",
                "gmail_account",
                "app_check_project_id",
                "fcm_project_id",
            }:
                result[f"{name}_set"] = bool(value)
            elif name.endswith(("_base_url", "_url", "_path")):
                # URLs can contain credentials, query data or local filesystem paths.
                result[f"{name}_set"] = bool(value)
            else:
                result[name] = value
        return result


@lru_cache
def get_settings() -> Settings:
    return Settings()
