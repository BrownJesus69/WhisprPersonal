"""Static, credential-free integration status. No transport is constructed."""

from dataclasses import dataclass
from typing import Literal, TypedDict


class IntegrationStatus(TypedDict):
    enabled: bool
    status: Literal["disabled", "not_configured"]
    docs: str


@dataclass(frozen=True)
class DisabledIntegration:
    flag: bool = False
    anchor: str = ""

    def status(self) -> IntegrationStatus:
        return {
            "enabled": False,
            "status": "not_configured" if self.flag else "disabled",
            "docs": f"docs/integrations.md#{self.anchor}",
        }
