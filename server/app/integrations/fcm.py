"""Disabled integration; never creates a client or performs I/O."""

from typing import Protocol

from app.integrations.base import DisabledIntegration, IntegrationStatus


class FCMProvider(Protocol):
    def status(self) -> IntegrationStatus: ...
    async def send_push(self) -> IntegrationStatus: ...


class DisabledFCM(DisabledIntegration):
    def __init__(self, flag: bool = False) -> None:
        super().__init__(flag, "fcm")

    async def send_push(self) -> IntegrationStatus:
        return self.status()
