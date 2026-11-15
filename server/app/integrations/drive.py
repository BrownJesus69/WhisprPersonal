"""Disabled integration; never creates a client or performs I/O."""

from typing import Protocol

from app.integrations.base import DisabledIntegration, IntegrationStatus


class DriveProvider(Protocol):
    def status(self) -> IntegrationStatus: ...
    async def upload_export(self) -> IntegrationStatus: ...


class DisabledDrive(DisabledIntegration):
    def __init__(self, flag: bool = False) -> None:
        super().__init__(flag, "drive")

    async def upload_export(self) -> IntegrationStatus:
        return self.status()
