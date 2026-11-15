"""Content-safe provider contracts."""

from dataclasses import dataclass, field
from typing import Literal, Protocol

ErrorKind = Literal[
    "timeout",
    "network",
    "rate_limited",
    "server_error",
    "auth_failed",
    "bad_request",
    "bad_response",
]


@dataclass(frozen=True)
class ChatMessage:
    role: Literal["system", "user", "assistant"]
    content: str = field(repr=False)


@dataclass(frozen=True)
class ChatRequest:
    messages: list[ChatMessage] = field(repr=False)
    purpose: Literal["cleanup", "brief", "translation_polish"]
    max_output_tokens: int


@dataclass(frozen=True)
class ChatResult:
    text: str = field(repr=False)
    provider: str
    model: str
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    latency_ms: int = 0


@dataclass(frozen=True)
class ProviderCheck:
    status: Literal["ok", "auth_failed", "unreachable", "not_configured"]


class ProviderError(Exception):
    def __init__(
        self, kind: ErrorKind, status: int | None = None, retry_after_s: float | None = None
    ) -> None:
        super().__init__(kind)
        self.kind = kind
        self.status = status
        self.retry_after_s = retry_after_s


class LLMProvider(Protocol):
    name: str
    model: str
    configured: bool
    is_cloud: bool

    async def complete(self, req: ChatRequest) -> ChatResult: ...

    async def check(self) -> ProviderCheck: ...
