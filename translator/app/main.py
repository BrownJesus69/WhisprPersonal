"""Local-only authenticated dedicated translation API."""

import asyncio
import hmac
import json
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse

from app.config import Settings
from app.engine import IndicTrans2Engine, TranslationError, direction_for


class TranslationLogFormatter(logging.Formatter):
    """Allowlist metadata; never serialize arbitrary record fields or exceptions."""

    def format(self, record: logging.LogRecord) -> str:
        return json.dumps(
            {
                "event": "translation_completed",
                "request_id": getattr(record, "request_id", "unknown"),
                "count": getattr(record, "count", 0),
                "duration_ms": getattr(record, "duration_ms", 0),
            }
        )


class Segment(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    text: str = Field(min_length=1, max_length=100000)


class TranslateRequest(BaseModel):
    source_lang: str
    target_lang: str
    segments: list[Segment] = Field(min_length=1, max_length=500)


def create_app(settings: Settings | None = None, engine: Any = None) -> FastAPI:
    config = settings or Settings()
    engine = engine or IndicTrans2Engine(config)

    async def idle() -> None:
        while True:
            await asyncio.sleep(min(30, config.idle_unload_s))
            await asyncio.to_thread(engine.unload_idle)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        task = asyncio.create_task(idle(), name="Translator idle unload (~30 s/check)")
        try:
            yield
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await asyncio.to_thread(engine.unload_idle)

    app = FastAPI(lifespan=lifespan)
    app.state.engine = engine

    @app.middleware("http")
    async def request_context(request: Request, call_next: Any) -> Any:
        request.state.request_id = uuid4().hex
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["Cache-Control"] = "no-store"
        return response

    def error(request: Request, code: str, status: int) -> JSONResponse:
        return JSONResponse(
            {
                "error": {
                    "code": code,
                    "message": code.replace("_", " ") + ".",
                    "request_id": getattr(request.state, "request_id", "unknown"),
                }
            },
            status_code=status,
        )

    @app.exception_handler(TranslationError)
    async def engine_error(request: Request, exc: TranslationError) -> JSONResponse:
        return error(
            request, exc.code, 422 if exc.code in {"same_language", "unsupported_pair"} else 503
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return error(request, "validation_error", 422)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException) -> JSONResponse:
        return error(request, "bad_request", exc.status_code)

    @app.exception_handler(Exception)
    async def unexpected(request: Request, exc: Exception) -> JSONResponse:
        return error(request, "translation_failed", 503)

    @app.get("/health")
    async def health() -> Any:
        return {
            "configured": bool(config.shared_secret and config.shared_secret.get_secret_value()),
            "directions": engine.status(),
        }

    @app.post("/translate")
    async def translate(payload: TranslateRequest, request: Request) -> Any:
        secret = config.shared_secret.get_secret_value() if config.shared_secret else ""
        if not secret:
            return error(request, "translator_not_configured", 503)
        supplied = request.headers.get("X-WhisprPersonal-Translator-Key", "")
        if not hmac.compare_digest(secret.encode(), supplied.encode()):
            return error(request, "invalid_translator_key", 401)
        direction = direction_for(payload.source_lang, payload.target_lang)
        if len(payload.segments) > config.max_segments or len(
            {s.id for s in payload.segments}
        ) != len(payload.segments):
            return error(request, "validation_error", 422)
        started = time.monotonic()
        texts = await engine.translate(
            payload.source_lang, payload.target_lang, [s.text for s in payload.segments]
        )
        repo, revision = config.model_spec(direction)
        logging.getLogger("whisprpersonal.translator").info(
            "Translation completed",
            extra={
                "request_id": request.state.request_id,
                "count": len(texts),
                "duration_ms": int((time.monotonic() - started) * 1000),
            },
        )
        return {
            "engine": "indictrans2",
            "model": f"{repo}@{revision[:7]}",
            "source_lang": payload.source_lang,
            "target_lang": payload.target_lang,
            "segments": [
                {"id": s.id, "text": t} for s, t in zip(payload.segments, texts, strict=True)
            ],
            "created_at": datetime.now(UTC).isoformat(),
        }

    return app


def run() -> None:
    import uvicorn

    settings = Settings()
    handler = logging.StreamHandler()
    handler.setFormatter(TranslationLogFormatter())
    logger = logging.getLogger("whisprpersonal.translator")
    logger.handlers = [handler]
    logger.setLevel(logging.INFO)
    logger.propagate = False
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_config=None)


if __name__ == "__main__":
    run()
