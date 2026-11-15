"""Per-process bounded token buckets; a single server worker is required."""

import math
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Request
from starlette.types import ASGIApp, Receive, Scope, Send

from app.core.errors import AppError, ErrorCode, send_error
from app.security.auth import VerifiedUser, require_auth


@dataclass(frozen=True)
class RateDecision:
    allowed: bool
    retry_after_s: float


class TokenBucketLimiter:
    def __init__(
        self,
        rate_per_minute: int,
        burst: int | None = None,
        max_keys: int = 10_000,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if rate_per_minute <= 0 or max_keys <= 0 or (burst is not None and burst <= 0):
            raise ValueError("Rate, burst and max_keys must be positive")
        self.rate = rate_per_minute / 60
        self.burst = burst if burst is not None else rate_per_minute
        self.max_keys = max_keys
        self.clock = clock
        self._buckets: OrderedDict[str, tuple[float, float]] = OrderedDict()

    @property
    def key_count(self) -> int:
        return len(self._buckets)

    def check(self, key: str) -> RateDecision:
        now = self.clock()
        tokens, previous = self._buckets.pop(key, (float(self.burst), now))
        tokens = min(self.burst, tokens + max(0, now - previous) * self.rate)
        allowed = tokens >= 1
        if allowed:
            tokens -= 1
        self._buckets[key] = (tokens, now)
        if len(self._buckets) > self.max_keys:
            self._buckets.popitem(last=False)
        return RateDecision(allowed, 0 if allowed else (1 - tokens) / self.rate)


def rate_error(decision: RateDecision) -> AppError:
    return AppError(
        ErrorCode.rate_limited,
        "Request rate limit exceeded.",
        headers={"Retry-After": str(max(1, math.ceil(decision.retry_after_s)))},
    )


class RateLimitMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        state = scope["app"].state
        ip = (scope.get("client") or ("unknown",))[0]
        # Both checks run, so rejected requests still count against global capacity.
        decisions = [state.global_limiter.check("global"), state.ip_limiter.check(ip)]
        denied = [decision for decision in decisions if not decision.allowed]
        if denied:
            await send_error(
                scope,
                receive,
                send,
                rate_error(max(denied, key=lambda decision: decision.retry_after_s)),
            )
            return
        await self.app(scope, receive, send)


async def per_user_rate_limit(
    request: Request,
    user: Annotated[VerifiedUser, Depends(require_auth)],
) -> VerifiedUser:
    decision = request.app.state.user_limiter.check(user.uid)
    if not decision.allowed:
        raise rate_error(decision)
    return user
