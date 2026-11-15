"""Monotonic circuit state and bounded, injectable retry waits."""

import asyncio
import random
import time
from collections.abc import Awaitable, Callable
from typing import TypeVar

from app.services.llm.base import ErrorKind, ProviderError

T = TypeVar("T")


class CircuitBreaker:
    def __init__(
        self, threshold: int, cooldown: float, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self.threshold = threshold
        self.cooldown = cooldown
        self.clock = clock
        self.failures = 0
        self.opened_at: float | None = None
        self.probing = False
        self.last_error_kind: ErrorKind | None = None

    @property
    def status(self) -> str:
        if self.opened_at is not None:
            return "auth_failed" if self.last_error_kind == "auth_failed" else "circuit_open"
        return "degraded" if self.last_error_kind else "ready"

    def available(self) -> bool:
        return self.opened_at is None or (
            self.clock() - self.opened_at >= self.cooldown and not self.probing
        )

    def allow(self) -> bool:
        if not self.available():
            return False
        if self.opened_at is not None:
            self.probing = True
        return True

    def success(self) -> None:
        self.failures = 0
        self.opened_at = None
        self.probing = False
        self.last_error_kind = None

    def failure(self, kind: ErrorKind) -> None:
        self.last_error_kind = kind
        if kind == "bad_request":
            # Model-specific request failures neither count nor hold a half-open probe.
            self.failures = 0
            self.opened_at = None
            self.probing = False
            return
        self.failures += 1
        if kind == "auth_failed" or self.probing or self.failures >= self.threshold:
            self.opened_at = self.clock()
        self.probing = False


async def retry_call(
    fn: Callable[[], Awaitable[T]],
    attempts: int,
    max_wait: float,
    rng: Callable[[], float] = random.random,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> T:
    for attempt in range(attempts):
        try:
            return await fn()
        except ProviderError as exc:
            if exc.kind not in {"timeout", "network", "server_error", "rate_limited"}:
                raise
            if attempt + 1 == attempts:
                raise
            wait = rng() * min(max_wait, 2.0 ** min(attempt, 30))
            if exc.kind == "rate_limited" and exc.retry_after_s is not None:
                wait = exc.retry_after_s
                if wait > max_wait:
                    raise
            await sleep(wait)
    raise ValueError("attempts must be positive")
