"""Provider wire and resilience contracts, entirely through MockTransport."""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from typing import Any

import httpx
import pytest
from pydantic import SecretStr

from app.services.llm.base import ChatMessage, ChatRequest, ProviderError
from app.services.llm.groq import GroqProvider
from app.services.llm.local import LocalProvider
from app.services.llm.openai_compat import retry_after
from app.services.llm.resilience import CircuitBreaker, retry_call
from app.services.llm.router import NoProviderAvailable, ProviderRouter
from app.services.llm.sambanova import SambaNovaProvider

SENTINEL_KEY = "sentinel-provider-secret"
SENTINEL_TEXT = "sentinel transcript private words"
REQUEST = ChatRequest([ChatMessage("user", SENTINEL_TEXT)], "cleanup", 50)


def response(text: str = "accepted", usage: Any = None) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": text}}], "usage": usage})


@pytest.mark.parametrize(
    "cls,field",
    [
        (GroqProvider, "max_completion_tokens"),
        (SambaNovaProvider, "max_tokens"),
        (LocalProvider, "max_tokens"),
    ],
)
@pytest.mark.parametrize("usage", [None, {"prompt_tokens": 11, "completion_tokens": 3}])
def test_payload_and_usage(cls: Any, field: str, usage: Any) -> None:
    async def scenario() -> None:
        def handle(req: httpx.Request) -> httpx.Response:
            assert str(req.url) == "https://provider.test/v1/chat/completions"
            payload = json.loads(req.content)
            assert payload == {
                "model": "mock-model",
                "messages": [{"role": "user", "content": SENTINEL_TEXT}],
                "temperature": 0.2,
                field: 50,
                "stream": False,
            }
            assert req.headers["authorization"] == "Bearer " + SENTINEL_KEY
            return response(usage=usage)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            provider = cls(
                client, "https://provider.test/v1/", "mock-model", SecretStr(SENTINEL_KEY)
            )
            result = await provider.complete(REQUEST)
            assert result.text == "accepted" and result.model == "mock-model"
            assert result.prompt_tokens == (11 if usage else None)
            assert result.completion_tokens == (3 if usage else None)

    asyncio.run(scenario())


def test_local_key_optional_and_models_probe() -> None:
    async def scenario() -> None:
        calls = []

        def handle(req: httpx.Request) -> httpx.Response:
            calls.append(req)
            assert "authorization" not in req.headers
            return response()

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            local = LocalProvider(client, "http://local.test/v1", "mock-local")
            assert local.configured
            await local.complete(REQUEST)
            assert (await local.check()).status == "ok"
            assert calls[-1].method == "GET" and calls[-1].url.path == "/v1/models"
            missing = GroqProvider(client, "https://provider.test", None)
            assert (await missing.check()).status == "not_configured"
            assert len(calls) == 2

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "status,kind",
    [
        (400, "bad_request"),
        (404, "bad_request"),
        (422, "bad_request"),
        (401, "auth_failed"),
        (403, "auth_failed"),
        (429, "rate_limited"),
        (500, "server_error"),
        (503, "server_error"),
    ],
)
def test_http_mapping(status: int, kind: str) -> None:
    async def scenario() -> None:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda req: httpx.Response(
                    status, text=SENTINEL_TEXT + SENTINEL_KEY, headers={"Retry-After": "7"}
                )
            )
        ) as client:
            provider = GroqProvider(
                client, "https://provider.test", "mock-model", SecretStr(SENTINEL_KEY)
            )
            with pytest.raises(ProviderError) as exc:
                await provider.complete(REQUEST)
            assert exc.value.kind == kind and exc.value.status == status
            assert SENTINEL_TEXT not in str(exc.value) and SENTINEL_KEY not in str(exc.value)
            if status == 429:
                assert exc.value.retry_after_s == 7
            assert (await provider.check()).status == (
                "auth_failed" if status in (401, 403) else "unreachable"
            )

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "data",
    [
        {},
        {"choices": []},
        {"choices": [{"message": {"content": " "}}]},
        {"choices": [{"message": {"content": []}}]},
        None,
    ],
)
def test_bad_response(data: Any) -> None:
    async def scenario() -> None:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda req: (
                    httpx.Response(200, json=data)
                    if data is not None
                    else httpx.Response(200, text="bad json")
                )
            )
        ) as client:
            provider = LocalProvider(client, "http://local.test", "mock-model")
            with pytest.raises(ProviderError, match="^bad_response$"):
                await provider.complete(REQUEST)

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "exception,kind", [(httpx.ReadTimeout, "timeout"), (httpx.ConnectError, "network")]
)
def test_transport_errors(exception: Any, kind: str) -> None:
    async def scenario() -> None:
        def handle(req: httpx.Request) -> httpx.Response:
            raise exception(SENTINEL_KEY)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            with pytest.raises(ProviderError, match=f"^{kind}$"):
                await LocalProvider(client, "http://local.test", "mock-model").complete(REQUEST)

    asyncio.run(scenario())


def test_retry_after_dates() -> None:
    now = datetime.now(UTC).replace(microsecond=0)
    assert retry_after("4", now) == 4
    assert retry_after(format_datetime(now + timedelta(seconds=9)), now) == 9
    assert retry_after(format_datetime(now - timedelta(seconds=9)), now) == 0
    assert retry_after("garbage", now) is None
    assert retry_after("nan", now) is None


@pytest.mark.parametrize(
    "kind,wait",
    [
        ("timeout", None),
        ("network", None),
        ("server_error", None),
        ("rate_limited", None),
        ("rate_limited", 7),
    ],
)
def test_retry_jitter(kind: Any, wait: float | None) -> None:
    async def scenario() -> None:
        calls = 0
        sleeps = []

        async def call() -> str:
            nonlocal calls
            calls += 1
            if calls < 3:
                raise ProviderError(kind, retry_after_s=wait)
            return "ok"

        async def sleep(seconds: float) -> None:
            sleeps.append(seconds)

        assert await retry_call(call, 3, 20, rng=lambda: 0.5, sleep=sleep) == "ok"
        assert sleeps == ([7, 7] if wait else [0.5, 1])

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "kind,wait",
    [("auth_failed", None), ("bad_request", None), ("bad_response", None), ("rate_limited", 21)],
)
def test_no_retry(kind: Any, wait: float | None) -> None:
    async def scenario() -> None:
        calls = 0

        async def call() -> None:
            nonlocal calls
            calls += 1
            raise ProviderError(kind, retry_after_s=wait)

        async def sleep(seconds: float) -> None:
            pytest.fail("Unexpected wait")

        with pytest.raises(ProviderError):
            await retry_call(call, 3, 20, sleep=sleep)
        assert calls == 1

    asyncio.run(scenario())


def test_breaker_transitions() -> None:
    now = [0.0]
    breaker = CircuitBreaker(2, 60, lambda: now[0])
    breaker.failure("bad_request")
    assert breaker.failures == 0 and breaker.allow()
    breaker.failure("timeout")
    assert breaker.status == "degraded" and breaker.allow()
    breaker.failure("network")
    assert breaker.status == "circuit_open" and not breaker.allow()
    now[0] = 60
    assert breaker.allow() and not breaker.allow()
    breaker.failure("server_error")
    assert not breaker.allow()
    now[0] = 120
    assert breaker.allow()
    breaker.success()
    assert breaker.status == "ready"
    breaker.failure("auth_failed")
    assert breaker.status == "auth_failed" and not breaker.allow()
    now[0] = 180
    assert breaker.allow()
    breaker.success()
    assert breaker.status == "ready"


def test_router_chain_and_reasons(make_settings: Any) -> None:
    async def scenario() -> None:
        calls = []

        def handle(req: httpx.Request) -> httpx.Response:
            calls.append(req.url.host)
            if req.url.host == "groq.test":
                return httpx.Response(429, headers={"Retry-After": "21"})
            if req.url.host == "samba.test":
                return httpx.Response(400)
            return response()

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            providers = [
                GroqProvider(client, "https://groq.test", "mock-model", SecretStr(SENTINEL_KEY)),
                SambaNovaProvider(
                    client, "https://samba.test", "mock-model", SecretStr(SENTINEL_KEY)
                ),
                LocalProvider(client, "http://local.test", "mock-model"),
            ]
            router = ProviderRouter(providers, make_settings())
            assert (await router.complete(REQUEST, True)).provider == "local_llm"
            assert calls == ["groq.test", "samba.test", "local.test"]
            assert router.breakers["sambanova"].failures == 0
            calls.clear()
            assert (await router.complete(REQUEST, False)).provider == "local_llm"
            assert calls == ["local.test"]
            providers[-1].configured = False
            with pytest.raises(NoProviderAvailable) as exc:
                await router.complete(REQUEST, False)
            assert exc.value.reasons == {
                "groq": "cloud_ai_disabled_for_event",
                "sambanova": "cloud_ai_disabled_for_event",
                "local_llm": "not_configured",
            }

    asyncio.run(scenario())


def test_auth_opens_and_falls_back(make_settings: Any) -> None:
    async def scenario() -> None:
        calls = []

        def handle(req: httpx.Request) -> httpx.Response:
            calls.append(req.url.host)
            return httpx.Response(401) if req.url.host == "groq.test" else response()

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            router = ProviderRouter(
                [
                    GroqProvider(client, "https://groq.test", "mock", SecretStr(SENTINEL_KEY)),
                    LocalProvider(client, "http://local.test", "mock"),
                ],
                make_settings(),
            )
            await router.complete(REQUEST, True)
            await router.complete(REQUEST, True)
            assert calls == ["groq.test", "local.test", "local.test"]
            assert router.status()["groq"]["status"] == "auth_failed"

    asyncio.run(scenario())


def test_provider_semaphore(make_settings: Any) -> None:
    async def scenario() -> None:
        active = 0
        peak = 0

        async def handle(req: httpx.Request) -> httpx.Response:
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0)
            active -= 1
            return response()

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            router = ProviderRouter(
                [LocalProvider(client, "http://local.test", "mock")],
                make_settings(local_llm_max_concurrency=2),
            )
            await asyncio.gather(*(router.complete(REQUEST, True) for _ in range(8)))
            assert peak == 2

    asyncio.run(scenario())


def test_audit_attempts_and_logs_exclude_content(
    make_settings: Any, tmp_path: Any, caplog: pytest.LogCaptureFixture
) -> None:
    from app.services.llm.usage import UsageContext, UsageRecorder, usage_context
    from app.services.store import Store

    async def scenario() -> None:
        store = Store(tmp_path)
        await store.open()
        calls = 0

        def handle(req: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            assert req.extensions["timeout"]["read"] == 0.5
            if calls < 3:
                return httpx.Response(500, text=SENTINEL_KEY + SENTINEL_TEXT)
            return response(usage={"prompt_tokens": 6, "completion_tokens": 2})

        async def sleep(seconds: float) -> None:
            assert seconds == 0

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            provider = LocalProvider(
                client, "http://local.test", "mock-model", SecretStr(SENTINEL_KEY), timeout_s=0.5
            )
            router = ProviderRouter(
                [provider], make_settings(), UsageRecorder(store), sleep=sleep, rng=lambda: 0
            )
            token = usage_context.set(UsageContext("job-audit", "user-audit", "request-audit"))
            try:
                with caplog.at_level("INFO", logger="app.services.llm.usage"):
                    await router.complete(REQUEST, True)
            finally:
                usage_context.reset(token)
        rows = await store.rows("SELECT * FROM ai_usage ORDER BY id")
        assert len(rows) == 3
        assert [r["outcome"] for r in rows] == ["error", "error", "ok"]
        assert [r["error_kind"] for r in rows] == ["server_error", "server_error", None]
        assert rows[-1]["prompt_tokens"] == 6 and rows[-1]["completion_tokens"] == 2
        records = [r for r in caplog.records if r.getMessage() == "ai_call"]
        assert len(records) == 3
        assert all(r.request_id == "request-audit" and r.job_id == "job-audit" for r in records)
        for content in (json.dumps(rows), str([r.__dict__ for r in records])):
            assert SENTINEL_KEY not in content and SENTINEL_TEXT not in content
        await store.close()

    asyncio.run(scenario())


def test_optional_provider_rpm_cap(make_settings: Any) -> None:
    async def scenario() -> None:
        calls = 0

        def handle(req: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return response()

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            provider = LocalProvider(client, "http://local.test", "mock")
            router = ProviderRouter([provider], make_settings(local_llm_max_rpm=1))
            await router.complete(REQUEST, False)
            with pytest.raises(NoProviderAvailable) as exc:
                await router.complete(REQUEST, False)
            assert exc.value.reasons == {"local_llm": "rate_limited"} and calls == 1

    asyncio.run(scenario())
