"""Disabled integration; never creates a client or performs I/O."""

from typing import Protocol

from app.integrations.base import DisabledIntegration, IntegrationStatus


class WebSearchProvider(Protocol):
    def status(self) -> IntegrationStatus: ...
    async def enrich(self) -> IntegrationStatus: ...


class DisabledWebSearch(DisabledIntegration):
    def __init__(self, flag: bool = False) -> None:
        super().__init__(flag, "web-search")

    async def enrich(self) -> IntegrationStatus:
        return self.status()
