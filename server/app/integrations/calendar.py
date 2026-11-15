"""Disabled integration; never creates a client or performs I/O."""

from typing import Protocol

from app.integrations.base import DisabledIntegration, IntegrationStatus


class CalendarProvider(Protocol):
    def status(self) -> IntegrationStatus: ...
    async def create_event(self) -> IntegrationStatus: ...
    async def list_events(self) -> IntegrationStatus: ...


class DisabledCalendar(DisabledIntegration):
    def __init__(self, flag: bool = False) -> None:
        super().__init__(flag, "calendar")

    async def create_event(self) -> IntegrationStatus:
        return self.status()

    async def list_events(self) -> IntegrationStatus:
        return self.status()
