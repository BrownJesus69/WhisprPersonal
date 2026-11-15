"""Shared-secret-first authentication and verified identity allowlists.

App Check (feature_app_check, Phase 10) is currently a no-op even when enabled;
it must not block the MVP.
"""

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from fastapi import Request

from app.config import Settings
from app.core.errors import AppError, ErrorCode
from app.security.shared_secret import require_server_key


@dataclass(frozen=True)
class VerifiedUser:
    uid: str
    email: str | None
    claims: Mapping[str, Any]


class TokenVerifier(Protocol):
    async def verify(self, id_token: str) -> VerifiedUser:
        """Return a verified identity or raise invalid_auth_token."""
        ...


class DisabledTokenVerifier:
    async def verify(self, id_token: str) -> VerifiedUser:
        raise AppError(ErrorCode.auth_not_configured, "Token verification is not configured.")


async def get_current_user(request: Request) -> VerifiedUser:
    parts = request.headers.get("Authorization", "").split()
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise AppError(ErrorCode.missing_auth_token, "A Bearer token is required.")
    return await request.app.state.token_verifier.verify(parts[1])


async def require_auth(request: Request) -> VerifiedUser:
    await require_server_key(request)
    return await get_current_user(request)


def enforce_allowlist(user: VerifiedUser, settings: Settings) -> None:
    if not settings.auth_allowed_uids and not settings.auth_allowed_emails:
        return
    if user.uid in settings.auth_allowed_uids or (
        user.claims.get("email_verified") is True
        and user.email is not None
        and user.email.lower() in settings.auth_allowed_emails
    ):
        return
    logging.getLogger(__name__).warning(
        "Account denied", extra={"event": "auth_denied_allowlist", "uid": user.uid}
    )
    raise AppError(ErrorCode.account_not_allowed, "Account is not allowed.")
