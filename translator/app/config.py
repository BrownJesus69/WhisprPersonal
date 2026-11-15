"""Offline model configuration. HF authentication belongs to the owner's HF login."""

from ipaddress import ip_address
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="TRANSLATOR_", hide_input_in_errors=True)
    host: str = "127.0.0.1"
    port: int = Field(8100, ge=1, le=65535)
    allow_lan: bool = False
    shared_secret: SecretStr | None = Field(None, repr=False)
    en_indic_repo: str = "ai4bharat/indictrans2-en-indic-1B"
    en_indic_revision: str = "89cd0007fd7b9e0693a2fd4404d187e07dac79fd"
    indic_en_repo: str = "ai4bharat/indictrans2-indic-en-1B"
    indic_en_revision: str = "ac3daf0ecd37be3b6957764a9179ab2b07fa9d6a"
    indic_indic_repo: str = "ai4bharat/indictrans2-indic-indic-1B"
    indic_indic_revision: str = "24d732922a0a91d0998d5568e3af37b7a21cd705"
    hf_cache_dir: Path = Path("E:/whispr-models/hf-cache")
    # trust_remote_code modules are copied here (transformers otherwise uses the C: profile).
    hf_modules_cache: Path = Path("E:/whispr-models/hf-modules")
    local_files_only: Literal[True] = True
    device: Literal["cuda", "cpu", "auto"] = "auto"
    dtype: Literal["float16", "float32"] = "float16"
    cpu_retry_on_oom: bool = False
    num_beams: int = Field(5, ge=1)
    max_length: int = Field(256, ge=1)
    batch_size: int = Field(8, ge=1)
    max_segment_chars: int = Field(1000, ge=1)
    max_segments: int = Field(500, ge=1)
    idle_unload_s: float = Field(300, gt=0)

    @model_validator(mode="after")
    def safe_settings(self) -> "Settings":
        try:
            loopback = self.host == "localhost" or ip_address(self.host).is_loopback
        except ValueError:
            loopback = False
        if not loopback and not self.allow_lan:
            raise ValueError("Non-loopback binding requires TRANSLATOR_ALLOW_LAN=true")
        for direction in ("en_indic", "indic_en", "indic_indic"):
            revision = getattr(self, direction + "_revision")
            if len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
                raise ValueError("Model revisions must be full pinned commit hashes")
        repo = Path(__file__).resolve().parents[2]
        if self.hf_cache_dir.resolve().is_relative_to(repo):
            raise ValueError("HF cache must be outside the repository")
        return self

    def model_spec(self, direction: str) -> tuple[str, str]:
        return getattr(self, direction + "_repo"), getattr(self, direction + "_revision")
