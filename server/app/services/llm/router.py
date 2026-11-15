"""Ordered provider fallback with independent capacity and circuit state."""

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from app.config import Settings
from app.security.rate_limit import TokenBucketLimiter
from app.services.llm.base import ChatRequest, ChatResult, LLMProvider, ProviderError
from app.services.llm.groq import GroqProvider
from app.services.llm.local import LocalProvider
from app.services.llm.resilience import CircuitBreaker, retry_call
from app.services.llm.sambanova import SambaNovaProvider
from app.services.llm.usage import UsageRecorder


class NoProviderAvailable(Exception):
    def __init__(self, reasons: dict[str, str]) -> None:
        super().__init__("provider_unavailable")
        self.reasons = reasons


class ProviderRouter:
    def __init__(
        self,
        providers: list[LLMProvider],
        settings: Settings,
        usage: UsageRecorder | None = None,
        **retry_options: Any,
    ) -> None:
        self.providers = providers
        self.settings = settings
        self.usage = usage
        self.retry_options = retry_options
        self.breakers = {
            p.name: CircuitBreaker(
                settings.ai_circuit_failure_threshold, settings.ai_circuit_cooldown_s
            )
            for p in providers
        }
        self.semaphores = {
            p.name: asyncio.Semaphore(getattr(settings, f"{p.name}_max_concurrency", 2))
            for p in providers
        }
        self.limiters = {
            p.name: TokenBucketLimiter(rpm)
            if (rpm := getattr(settings, f"{p.name}_max_rpm", None))
            else None
            for p in providers
        }

    def usable(self, allow_cloud: bool) -> bool:
        return any(
            p.configured and (allow_cloud or not p.is_cloud) and self.breakers[p.name].available()
            for p in self.providers
        )

    def status(self) -> dict[str, dict[str, Any]]:
        return {
            p.name: {
                "status": self.breakers[p.name].status if p.configured else "not_configured",
                "model": p.model or None,
                "last_error_kind": self.breakers[p.name].last_error_kind,
            }
            for p in self.providers
        }

    async def complete(self, req: ChatRequest, allow_cloud: bool) -> ChatResult:
        reasons = {}
        for provider in self.providers:
            name = provider.name
            breaker = self.breakers[name]
            if not provider.configured:
                reasons[name] = "not_configured"
                continue
            if provider.is_cloud and not allow_cloud:
                reasons[name] = "cloud_ai_disabled_for_event"
                continue
            async with self.semaphores[name]:
                if not breaker.allow():
                    reasons[name] = breaker.status
                    continue
                try:
                    result = await retry_call(
                        self._attempt(provider, req),
                        self.settings.ai_retry_max_attempts,
                        self.settings.ai_retry_max_wait_s,
                        **self.retry_options,
                    )
                except ProviderError as exc:
                    breaker.failure(exc.kind)
                    reasons[name] = exc.kind
                except asyncio.CancelledError:
                    breaker.probing = False
                    raise
                else:
                    breaker.success()
                    return result
        raise NoProviderAvailable(reasons)

    def _attempt(
        self, provider: LLMProvider, req: ChatRequest
    ) -> Callable[[], Awaitable[ChatResult]]:
        async def call() -> ChatResult:
            started = time.monotonic()
            result = None
            error = None
            try:
                limiter = self.limiters[provider.name]
                if limiter:
                    decision = limiter.check("provider")
                    if not decision.allowed:
                        raise ProviderError("rate_limited", retry_after_s=decision.retry_after_s)
                result = await provider.complete(req)
                return result
            except ProviderError as exc:
                error = exc.kind
                raise
            finally:
                if self.usage:
                    await self.usage.record(
                        provider,
                        req.purpose,
                        int((time.monotonic() - started) * 1000),
                        result,
                        error or ("interrupted" if result is None else None),
                    )

        return call

    async def check(self) -> dict[str, str]:
        result = {}
        for provider in self.providers:
            async with self.semaphores[provider.name]:
                check = await provider.check()
            result[provider.name] = check.status
            if provider.configured:
                if check.status == "ok":
                    self.breakers[provider.name].success()
                else:
                    self.breakers[provider.name].failure(
                        "auth_failed" if check.status == "auth_failed" else "network"
                    )
        return result


def build_router(
    settings: Settings, client: httpx.AsyncClient, usage: UsageRecorder
) -> ProviderRouter:
    providers = []
    for cls, prefix in (
        (GroqProvider, "groq"),
        (SambaNovaProvider, "sambanova"),
        (LocalProvider, "local_llm"),
    ):
        providers.append(
            cls(
                client,
                getattr(settings, f"{prefix}_base_url"),
                getattr(settings, f"{prefix}_model"),
                getattr(settings, f"{prefix}_api_key"),
                getattr(settings, f"{prefix}_timeout_s"),
                settings.ai_temperature,
            )
        )
    return ProviderRouter(providers, settings, usage)
