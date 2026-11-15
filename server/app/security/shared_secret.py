"""Shared server key boundary, checked before identity verification."""

import hmac

from fastapi import Request

from app.core.errors import AppError, ErrorCode


async def require_server_key(request: Request) -> None:
    secret = request.app.state.settings.server_shared_secret
    if secret is None:
        raise AppError(ErrorCode.server_not_configured, "Server shared secret is not configured.")
    provided = request.headers.get("X-EventScribe-Server-Key")
    if not provided:
        raise AppError(ErrorCode.missing_server_key, "Server key is required.")
    if not hmac.compare_digest(provided.encode("utf-8"), secret.get_secret_value().encode("utf-8")):
        raise AppError(ErrorCode.invalid_server_key, "Server key is invalid.")
