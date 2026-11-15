"""Application factory with app-owned auth, durable queue and serialized inference."""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.config import Settings, get_settings
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging
from app.core.request_context import RequestContextMiddleware
from app.routers import ai, auth, diagnostics, export, health, sessions, stream, vocabulary
from app.security.auth import DisabledTokenVerifier, TokenVerifier
from app.security.body_limit import BodyLimitMiddleware
from app.security.firebase_verifier import FirebaseTokenVerifier
from app.security.grants import GrantService, GrantVerifier
from app.security.headers import SecurityHeadersMiddleware
from app.security.network import NetworkMiddleware
from app.security.ownership import DisabledEventRepository, FirestoreEventRepository
from app.security.rate_limit import RateLimitMiddleware, TokenBucketLimiter
from app.services.ai.jobs import AIJobService
from app.services.broadcaster import Broadcaster
from app.services.firebase import FirebaseService
from app.services.firestore_sync import DisabledFirestoreSync, FirestoreSync
from app.services.gpu import detect_gpu
from app.services.llm.router import build_router
from app.services.llm.usage import UsageRecorder
from app.services.model_manager import ModelManager
from app.services.state import ServerState
from app.services.store import Store
from app.services.transcription import FasterWhisperEngine
from app.workers.transcription_worker import TranscriptionWorker


def create_app(
    settings: Settings | None = None,
    firebase_service: FirebaseService | None = None,
    token_verifier: TokenVerifier | None = None,
) -> FastAPI:
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
        service = firebase_service if firebase_service is not None else FirebaseService(settings)
        await asyncio.to_thread(service.initialize)
        app.state.firebase = service
        app.state.token_verifier = (
            token_verifier
            if token_verifier is not None
            else (
                FirebaseTokenVerifier(service, settings)
                if service.status == "ready"
                else DisabledTokenVerifier()
            )
        )
        app.state.event_repository = (
            FirestoreEventRepository(service, settings.firestore_timeout_s)
            if service.status == "ready"
            else DisabledEventRepository()
        )
        if (
            service.status == "ready"
            and not settings.auth_allowed_uids
            and not settings.auth_allowed_emails
        ):
            logger.warning(
                "Any user of this Firebase project with the server key can use this server",
                extra={"event": "auth_allowlist_empty"},
            )
        app.state.global_limiter = TokenBucketLimiter(settings.rate_limit_global_per_minute)
        app.state.ip_limiter = TokenBucketLimiter(settings.rate_limit_per_ip_per_minute)
        app.state.user_limiter = TokenBucketLimiter(settings.rate_limit_per_user_per_minute)
        app.state.store = Store(settings.data_dir)
        await app.state.store.open()
        app.state.grant_service = GrantService(settings, app.state.store)
        await app.state.grant_service.initialize()
        app.state.grant_verifier = GrantVerifier(app.state.grant_service)
        app.state.broadcaster = Broadcaster()
        app.state.model_manager = ModelManager(settings, app.state.server_state)
        app.state.engine = FasterWhisperEngine(app.state.model_manager, settings)
        app.state.firestore_sync = (
            FirestoreSync(service, settings.firestore_timeout_s)
            if service.status == "ready"
            else DisabledFirestoreSync()
        )
        app.state.worker = TranscriptionWorker(
            settings,
            app.state.store,
            app.state.engine,
            app.state.model_manager,
            app.state.broadcaster,
            app.state.firestore_sync,
            app.state.server_state,
        )
        app.state.worker.event_repository_provider = lambda: app.state.event_repository
        app.state.ai_http_client = httpx.AsyncClient(follow_redirects=False, trust_env=False)
        app.state.ai_router = build_router(
            settings, app.state.ai_http_client, UsageRecorder(app.state.store)
        )
        app.state.ai_user_limiter = TokenBucketLimiter(settings.ai_user_requests_per_minute)
        app.state.ai_global_limiter = TokenBucketLimiter(settings.ai_global_requests_per_minute)
        app.state.ai_jobs = AIJobService(
            settings,
            app.state.store,
            app.state.ai_router,
            lambda: app.state.event_repository,
            lambda: app.state.firestore_sync,
        )
        await app.state.ai_jobs.start()
        await app.state.worker.start()
        try:
            yield
        finally:
            await app.state.ai_jobs.stop()
            await app.state.ai_http_client.aclose()
            await app.state.worker.stop()
            await app.state.store.close()
            await asyncio.to_thread(service.close)
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
    app.include_router(export.router)
    app.include_router(auth.router)
    app.include_router(ai.router)
    app.include_router(health.router)
    app.include_router(diagnostics.router)
    app.include_router(sessions.router)
    app.include_router(stream.router)
    app.include_router(vocabulary.router)
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
