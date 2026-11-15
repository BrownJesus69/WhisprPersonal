"""Application factory; inference and identity initialization arrive in later phases."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.config import Settings, get_settings
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging
from app.core.request_context import RequestContextMiddleware
from app.routers import diagnostics, health
from app.security.auth import DisabledTokenVerifier
from app.security.body_limit import BodyLimitMiddleware
from app.security.headers import SecurityHeadersMiddleware
from app.security.network import NetworkMiddleware
from app.security.rate_limit import RateLimitMiddleware, TokenBucketLimiter
from app.services.gpu import detect_gpu
from app.services.state import ServerState


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings if settings is not None else get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        configure_logging(settings)
        logger = logging.getLogger("whisprpersonal")
        logger.info(
            "Server starting", extra={"event": "startup", "config": settings.safe_summary()}
        )
        app.state.settings = settings
        app.state.server_state = ServerState(
            started_at=datetime.now(UTC),
            gpu=await detect_gpu(settings),
            model_name=settings.whisper_model,
        )
        app.state.token_verifier = DisabledTokenVerifier()
        app.state.global_limiter = TokenBucketLimiter(settings.rate_limit_global_per_minute)
        app.state.ip_limiter = TokenBucketLimiter(settings.rate_limit_per_ip_per_minute)
        app.state.user_limiter = TokenBucketLimiter(settings.rate_limit_per_user_per_minute)
        try:
            yield
        finally:
            logger.info("Server stopping", extra={"event": "shutdown"})

    app = FastAPI(
        title="WhisprPersonal Server",
        version=__version__,
        lifespan=lifespan,
        docs_url="/docs" if settings.enable_api_docs else None,
        redoc_url="/redoc" if settings.enable_api_docs else None,
        openapi_url="/openapi.json" if settings.enable_api_docs else None,
    )
    register_exception_handlers(app)
    app.include_router(health.router)
    app.include_router(diagnostics.router)
    # add_middleware prepends: register from innermost to outermost.
    if settings.cors_allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_allowed_origins,
            allow_credentials=False,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=[
                "Authorization",
                "Content-Type",
                "X-WhisprPersonal-Server-Key",
                "X-Request-ID",
            ],
            expose_headers=["X-Request-ID", "Retry-After"],
        )
    app.add_middleware(RateLimitMiddleware)
    app.add_middleware(BodyLimitMiddleware, settings=settings)
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(NetworkMiddleware, settings=settings)
    app.add_middleware(RequestContextMiddleware)
    return app


app = create_app()
