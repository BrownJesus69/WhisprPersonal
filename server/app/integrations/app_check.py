"""Opt-in enforcement requires an explicitly configured verifier as well as the flag."""

from typing import Protocol

from fastapi import Request

from app.core.errors import AppError, ErrorCode
from app.integrations.base import DisabledIntegration, IntegrationStatus


class AppCheckVerifier(Protocol):
    configured: bool

    def status(self) -> IntegrationStatus: ...
    async def verify(self, token: str | None) -> bool: ...


class DisabledAppCheck(DisabledIntegration):
    configured = False

    def __init__(self, flag: bool = False) -> None:
        super().__init__(flag, "app-check")

    async def verify(self, token: str | None) -> bool:
        return False


async def enforce_app_check(request: Request) -> None:
    verifier = getattr(request.app.state, "app_check_verifier", None)
    if not request.app.state.settings.feature_app_check or not getattr(
        verifier, "configured", False
    ):
        return
    if not await verifier.verify(request.headers.get("X-Firebase-AppCheck")):
        raise AppError(ErrorCode.invalid_auth_token, "App verification failed.")
