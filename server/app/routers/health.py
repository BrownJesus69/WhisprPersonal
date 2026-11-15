"""Public liveness and readiness summary without remote service calls."""

from datetime import UTC, datetime

from fastapi import APIRouter, Request

from app import __version__
from app.config import Settings
from app.schemas.health import (
    AuthInfo,
    FeaturesInfo,
    FirebaseInfo,
    HealthResponse,
    ModelInfo,
    ProviderInfo,
    ProvidersInfo,
    QueueInfo,
)
from app.services.state import ServerState

router = APIRouter()


def build_health(request: Request) -> HealthResponse:
    settings: Settings = request.app.state.settings
    state: ServerState = request.app.state.server_state
    now = datetime.now(UTC)

    def provider(configured: bool) -> ProviderInfo:
        return ProviderInfo(
            configured=configured,
            status="configured_unchecked" if configured else "not_configured",
        )

    return HealthResponse(
        status="ok"
        if state.model_status == "ready" and state.queue_status == "running"
        else "degraded",
        version=__version__,
        server_time=now,
        uptime_s=max(0, (now - state.started_at).total_seconds()),
        model=ModelInfo(
            name=state.model_name or settings.whisper_model,
            fallback_name=settings.whisper_fallback_model,
            status=state.model_status,
            device=settings.whisper_device,
        ),
        gpu=state.gpu,
        queue=QueueInfo(
            status=state.queue_status,
            depth=state.queue_depth,
            max_depth=settings.queue_max_depth,
            workers=settings.worker_count,
        ),
        providers=ProvidersInfo(
            groq=provider(settings.groq_configured),
            sambanova=provider(settings.sambanova_configured),
            local_llm=provider(settings.local_llm_configured),
        ),
        firebase=FirebaseInfo(credentials_present=settings.firebase_credentials_present),
        auth=AuthInfo(shared_secret_configured=bool(settings.server_shared_secret)),
        features=FeaturesInfo(
            **{name: getattr(settings, f"feature_{name}") for name in FeaturesInfo.model_fields}
        ),
    )


@router.get("/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    return build_health(request)
