"""Status contracts; health does not contact remote services."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class GpuInfo(BaseModel):
    available: bool | None = None
    name: str | None = None
    vram_total_mb: int | None = None
    detection: Literal["ctranslate2", "nvidia-smi", "disabled", "unavailable"] = "unavailable"


class ModelInfo(BaseModel):
    name: str
    fallback_name: str
    status: Literal["not_loaded", "loading", "ready", "error"]
    device: Literal["auto", "cuda", "cpu"]


class QueueInfo(BaseModel):
    status: Literal["not_started", "running", "stopping"]
    depth: int
    max_depth: int
    workers: int


class ProviderInfo(BaseModel):
    configured: bool
    status: Literal["not_configured", "configured_unchecked"]


class ProvidersInfo(BaseModel):
    groq: ProviderInfo
    sambanova: ProviderInfo
    local_llm: ProviderInfo


class FirebaseInfo(BaseModel):
    credentials_present: bool
    status: Literal["not_configured", "ready", "error"]
    error_reason: str | None = None
    project_id_set: bool


class AuthInfo(BaseModel):
    shared_secret_configured: bool
    token_verification: Literal["disabled", "firebase"] = "disabled"  # noqa: S105 -- public status

    allowlist_enabled: bool
    check_revoked: bool


class FeaturesInfo(BaseModel):
    translation: bool
    calendar: bool
    drive: bool
    gmail: bool
    app_check: bool
    fcm: bool
    web_search: bool
    cloud_whisper: bool


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    server_time: datetime
    uptime_s: float
    model: ModelInfo
    gpu: GpuInfo
    queue: QueueInfo
    providers: ProvidersInfo
    firebase: FirebaseInfo
    auth: AuthInfo
    features: FeaturesInfo
