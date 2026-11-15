"""Public liveness and readiness summary without remote service calls."""

from datetime import UTC, datetime

from fastapi import APIRouter, Request

from app import __version__
from app.config import Settings
from app.schemas.health import (
    AuthInfo,
    FeaturesInfo,
    FirebaseInfo,
    GrantsInfo,
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

    def provider(configured: bool, name: str) -> ProviderInfo:
        ai_router = getattr(request.app.state, "ai_router", None)
        if ai_router:
            return ProviderInfo(configured=configured, **ai_router.status()[name])
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
            loaded=state.model_loaded,
            device_resolved=state.model_device,
            compute_type=state.model_compute_type,
            load_s=state.model_load_s,
            error=state.model_error,
        ),
        gpu=state.gpu,
        languages={"supported": settings.supported_languages, "default_mode": "auto"},
        queue=QueueInfo(
            status=state.queue_status,
            depth=state.queue_depth,
            max_depth=settings.queue_max_depth,
            workers=settings.worker_count,
        ),
        providers=ProvidersInfo(
            groq=provider(settings.groq_configured, "groq"),
            sambanova=provider(settings.sambanova_configured, "sambanova"),
            local_llm=provider(settings.local_llm_configured, "local_llm"),
        ),
        firebase=FirebaseInfo(
            credentials_present=settings.firebase_credentials_present,
            status=request.app.state.firebase.status,
            error_reason=request.app.state.firebase.error_reason,
            project_id_set=bool(request.app.state.firebase.project_id),
        ),
        auth=AuthInfo(
            shared_secret_configured=bool(settings.server_shared_secret),
            token_verification="firebase"
            if request.app.state.firebase.status == "ready"
            else "disabled",
            allowlist_enabled=bool(settings.auth_allowed_uids or settings.auth_allowed_emails),
            check_revoked=settings.firebase_check_revoked,
            grants=GrantsInfo(
                enabled=settings.auth_grant_enabled, ttl_hours=settings.auth_grant_ttl_hours
            ),
        ),
        features=FeaturesInfo(
            **{name: getattr(settings, f"feature_{name}") for name in FeaturesInfo.model_fields}
        ),
    )


@router.get("/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    return build_health(request)
