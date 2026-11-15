"""Disabled integration; never creates a client or performs I/O."""

from typing import Protocol

from app.integrations.base import DisabledIntegration, IntegrationStatus


class GmailProvider(Protocol):
    def status(self) -> IntegrationStatus: ...
    async def send_brief(self) -> IntegrationStatus: ...


class DisabledGmail(DisabledIntegration):
    def __init__(self, flag: bool = False) -> None:
        super().__init__(flag, "gmail")

    async def send_brief(self) -> IntegrationStatus:
        return self.status()
