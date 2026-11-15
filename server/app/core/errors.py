"""Safe error taxonomy and HTTP exception translation."""

import logging
from enum import StrEnum
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.types import Receive, Scope, Send

from app.core.request_context import request_id_var
from app.schemas.common import ErrorBody, ErrorResponse


class ErrorCode(StrEnum):
    bad_request = "bad_request"
    validation_error = "validation_error"
    not_found = "not_found"
    method_not_allowed = "method_not_allowed"
    missing_server_key = "missing_server_key"
    invalid_server_key = "invalid_server_key"
    server_not_configured = "server_not_configured"
    missing_auth_token = "missing_auth_token"  # noqa: S105 -- public error identifier
    invalid_auth_token = "invalid_auth_token"  # noqa: S105 -- public error identifier
    auth_not_configured = "auth_not_configured"
    auth_token_expired = "auth_token_expired"  # noqa: S105 -- public error identifier
    auth_unavailable = "auth_unavailable"
    account_not_allowed = "account_not_allowed"
    firestore_unavailable = "firestore_unavailable"
    forbidden = "forbidden"
    network_not_allowed = "network_not_allowed"
    payload_too_large = "payload_too_large"
    rate_limited = "rate_limited"
    feature_disabled = "feature_disabled"
    provider_unavailable = "provider_unavailable"
    queue_full = "queue_full"
    model_not_ready = "model_not_ready"
    internal_error = "internal_error"


ERROR_STATUSES: dict[ErrorCode, int] = {
    ErrorCode.bad_request: 400,
    ErrorCode.validation_error: 422,
    ErrorCode.not_found: 404,
    ErrorCode.method_not_allowed: 405,
    ErrorCode.missing_server_key: 401,
    ErrorCode.invalid_server_key: 401,
    ErrorCode.server_not_configured: 503,
    ErrorCode.missing_auth_token: 401,
    ErrorCode.invalid_auth_token: 401,
    ErrorCode.auth_not_configured: 503,
    ErrorCode.auth_token_expired: 401,
    ErrorCode.auth_unavailable: 503,
    ErrorCode.account_not_allowed: 403,
    ErrorCode.firestore_unavailable: 503,
    ErrorCode.forbidden: 403,
    ErrorCode.network_not_allowed: 403,
    ErrorCode.payload_too_large: 413,
    ErrorCode.rate_limited: 429,
    ErrorCode.feature_disabled: 503,
    ErrorCode.provider_unavailable: 503,
    ErrorCode.queue_full: 503,
    ErrorCode.model_not_ready: 503,
    ErrorCode.internal_error: 500,
}


class AppError(Exception):
    def __init__(
        self,
        code: ErrorCode,
        message: str,
        status_code: int | None = None,
        details: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code if status_code is not None else ERROR_STATUSES[code]
        self.details = details
        self.headers = headers


def error_response(
    error: AppError,
    request_id: str | None = None,
    details: list[dict[str, Any]] | None = None,
) -> JSONResponse:
    body = ErrorResponse(
        error=ErrorBody(
            code=error.code,
            message=error.message,
            request_id=request_id or request_id_var.get() or "unknown",
            details=details if details is not None else error.details,
        )
    )
    return JSONResponse(
        body.model_dump(exclude_none=True), status_code=error.status_code, headers=error.headers
    )


async def send_error(scope: Scope, receive: Receive, send: Send, error: AppError) -> None:
    await error_response(error)(scope, receive, send)


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
        return error_response(exc, getattr(request.state, "request_id", None))

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        details = [
            {"loc": error["loc"], "msg": error["msg"], "type": error["type"]}
            for error in exc.errors()
        ]
        return error_response(
            AppError(ErrorCode.validation_error, "Request validation failed."),
            getattr(request.state, "request_id", None),
            details,
        )

    @app.exception_handler(HTTPException)
    async def http_handler(request: Request, exc: HTTPException) -> JSONResponse:
        code = {404: ErrorCode.not_found, 405: ErrorCode.method_not_allowed}.get(
            exc.status_code, ErrorCode.bad_request
        )
        return error_response(
            AppError(
                code,
                code.value.replace("_", " ").capitalize() + ".",
                status_code=exc.status_code,
                headers=exc.headers,
            ),
            getattr(request.state, "request_id", None),
        )

    @app.exception_handler(Exception)
    async def unexpected_handler(request: Request, exc: Exception) -> JSONResponse:
        request_id = getattr(request.state, "request_id", "unknown")
        logging.getLogger(__name__).error(
            "Unhandled exception",
            exc_info=(type(exc), exc, exc.__traceback__),
            extra={"event": "unhandled_exception", "request_id": request_id},
        )
        response = error_response(
            AppError(ErrorCode.internal_error, "An unexpected error occurred."), request_id
        )
        # Starlette's outer ServerErrorMiddleware handles this after user middleware unwinds.
        response.headers["X-Request-ID"] = request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path.startswith("/api/") or request.url.path == "/health":
            response.headers["Cache-Control"] = "no-store"
        return response
