"""Minimal OpenAI-compatible wire protocol; no content in exceptions or logs."""

import logging
import math
import time
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any

import httpx
from pydantic import SecretStr

from app.services.llm.base import ChatRequest, ChatResult, ProviderCheck, ProviderError


def retry_after(value: str | None, now: datetime | None = None) -> float | None:
    if not value:
        return None
    try:
        seconds = float(value)
        return max(0, seconds) if math.isfinite(seconds) else None
    except ValueError:
        try:
            date = parsedate_to_datetime(value)
            return max(0, (date - (now or datetime.now(UTC))).total_seconds())
        except (ValueError, TypeError, OverflowError):
            return None


class OpenAICompatibleProvider:
    name = "compatible"
    is_cloud = True
    max_tokens_field = "max_tokens"

    def __init__(
        self,
        client: httpx.AsyncClient,
        base_url: str | None,
        model: str | None,
        api_key: SecretStr | None = None,
        timeout_s: float = 30,
        temperature: float = 0.2,
    ) -> None:
        self.client = client
        self.base_url = (base_url or "").rstrip("/")
        self.model = model or ""
        self.api_key = api_key
        self.timeout_s = timeout_s
        self.temperature = temperature
        self.configured = bool(self.base_url and self.model and (api_key or not self.is_cloud))

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        headers = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key.get_secret_value()}"
        try:
            response = await self.client.request(
                method, self.base_url + path, headers=headers, timeout=self.timeout_s, **kwargs
            )
        except httpx.TimeoutException:
            raise ProviderError("timeout") from None
        except httpx.HTTPError:
            raise ProviderError("network") from None
        # Remaining counts are observations, never quotas or arbitrary header strings.
        remaining = {
            key: int(value)
            for key in ("x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens")
            if (value := response.headers.get(key, "")).isascii()
            and value.isdecimal()
            and len(value) <= 18
        }
        if remaining:
            logging.getLogger(__name__).info(
                "Provider remaining counts", extra={"provider": self.name, "remaining": remaining}
            )
        status = response.status_code
        if status in (401, 403):
            raise ProviderError("auth_failed", status)
        if status == 429:
            raise ProviderError(
                "rate_limited", status, retry_after(response.headers.get("retry-after"))
            )
        if status >= 500:
            raise ProviderError("server_error", status)
        if status >= 400:
            raise ProviderError("bad_request", status)
        if status >= 300:
            raise ProviderError("bad_response", status)
        return response

    async def complete(self, req: ChatRequest) -> ChatResult:
        started = time.monotonic()
        response = await self._request(
            "POST",
            "/chat/completions",
            json={
                "model": self.model,
                "messages": [{"role": m.role, "content": m.content} for m in req.messages],
                "temperature": self.temperature,
                self.max_tokens_field: req.max_output_tokens,
                "stream": False,
            },
        )
        try:
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            if not isinstance(content, str) or not content.strip():
                raise ValueError
            usage = data.get("usage") or {}
            if not isinstance(usage, dict):
                usage = {}

            def count(name: str) -> int | None:
                value = usage.get(name)
                return value if type(value) is int and value >= 0 else None

            return ChatResult(
                content.strip(),
                self.name,
                self.model,
                count("prompt_tokens"),
                count("completion_tokens"),
                int((time.monotonic() - started) * 1000),
            )
        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
            raise ProviderError("bad_response") from None

    async def check(self) -> ProviderCheck:
        if not self.configured:
            return ProviderCheck("not_configured")
        try:
            await self._request("GET", "/models")
            return ProviderCheck("ok")
        except ProviderError as exc:
            return ProviderCheck("auth_failed" if exc.kind == "auth_failed" else "unreachable")
