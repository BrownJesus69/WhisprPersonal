"""Not configured.

Emergency English-only audio translation via Groq is available separately when enabled.
"""

from typing import Protocol

from app.integrations.base import DisabledIntegration, IntegrationStatus


class CloudWhisperProvider(Protocol):
    def status(self) -> IntegrationStatus: ...
    async def transcribe(self) -> IntegrationStatus: ...


class DisabledCloudWhisper(DisabledIntegration):
    def __init__(self, flag: bool = False) -> None:
        super().__init__(flag, "cloud-whisper")

    async def transcribe(self) -> IntegrationStatus:
        return self.status()
