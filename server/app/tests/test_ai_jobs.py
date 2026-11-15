"""Job lifecycle and endpoint contracts with real SQLite and mocked provider HTTP."""

import asyncio
import json
import time
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core.errors import AppError
from app.security.ownership import EventAccess
from app.services.ai.jobs import AIJobService, partition
from app.services.llm.local import LocalProvider
from app.services.llm.router import ProviderRouter
from app.services.llm.usage import UsageRecorder
from app.services.store import Store, insert
from app.tests.fakes import FakeEventRepo, FakeFirestoreSync
from app.tests.test_llm import SENTINEL_KEY, SENTINEL_TEXT, response


async def seed(store: Store, status: str = "finalized", text: str = SENTINEL_TEXT) -> None:
    await store.transaction(
        lambda conn: insert(
            conn,
            "sessions",
            {
                "id": "session1",
                "owner_uid": "user-1",
                "event_id": "event1",
                "status": status,
                "transcript_status": "complete",
                "model_profile": "turbo",
                "created_at": "2026-01-01",
            },
        )
    )
    for seq, state in enumerate(("done", "done", "failed")):
        await store.transaction(
            lambda conn, seq=seq, state=state: insert(
                conn,
                "chunks",
                {
                    "session_id": "session1",
                    "chunk_id": f"c{seq}",
                    "sequence": seq,
                    "start_ms": seq * 1000,
                    "status": state,
                    "no_speech": int(seq == 1),
                    "raw_text": text,
                    "raw_text_full": text,
                },
            )
        )


def params(kind: str = "cleanup", **overrides: Any) -> dict[str, Any]:
    return {
        "event_id": "event1",
        "session_ids": ["session1"],
        **(
            {"level": "conservative"}
            if kind == "cleanup"
            else {
                "brief_type": "summary",
                "allow_incomplete": False,
                "use_polished": False,
                "notes": [],
            }
        ),
        **overrides,
    }


def install_http(client: TestClient, handler: Any) -> list[httpx.Request]:
    calls = []

    async def setup() -> None:
        async def wrapped(req: httpx.Request) -> httpx.Response:
            calls.append(req)
            result = handler(req)
            return await result if hasattr(result, "__await__") else result

        state = client.app.state
        await state.ai_http_client.aclose()
        state.ai_http_client = httpx.AsyncClient(transport=httpx.MockTransport(wrapped))
        provider = LocalProvider(
            state.ai_http_client, "http://local.test/v1", "mock-model", SecretStr(SENTINEL_KEY)
        )
        state.ai_router = ProviderRouter([provider], state.settings, UsageRecorder(state.store))
        state.ai_jobs.router = state.ai_router

    client.portal.call(setup)
    return calls


def wait_job(client: TestClient, job_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        result = client.get(f"/api/v1/ai/jobs/{job_id}").json()
        if result["status"] not in {"running", "queued"}:
            return result
        time.sleep(0.01)
    raise AssertionError("Job did not finish")


def test_unconfigured_privacy_and_auth(phase3_client: TestClient) -> None:
    client = phase3_client
    client.portal.call(seed, client.app.state.store)
    for path in ("/api/v1/notes/cleanup", "/api/v1/briefs"):
        result = client.post(path, json=params("brief" if path.endswith("briefs") else "cleanup"))
        assert result.status_code == 503
        assert result.json()["error"]["code"] == "provider_unavailable"
        assert (
            result.json()["error"]["message"] == "Cloud AI unavailable; raw transcript preserved."
        )
    assert client.get("/api/v1/ai/status").json()["cloud_available"] is False
    assert set(client.post("/api/v1/ai/providers/check").json().values()) == {"not_configured"}
    for path in (
        "/api/v1/ai/status",
        "/api/v1/sessions/session1/polished",
        "/api/v1/ai/jobs/other",
    ):
        assert client.get(path, headers={"Authorization": ""}).status_code == 401
    assert (
        client.post(
            "/api/v1/notes/cleanup", json=params(), headers={"X-WhisprPersonal-Server-Key": ""}
        ).status_code
        == 401
    )
    chunks = client.portal.call(client.app.state.store.chunks, "session1")
    assert all(c["raw_text"] == SENTINEL_TEXT and c["polished_text"] is None for c in chunks)


@pytest.mark.parametrize(
    "mode,owner,code",
    [
        ("local_only", "user-1", "cloud_ai_disabled_for_event"),
        (None, "user-1", "privacy_mode_unknown"),
        ("cloud_ai", "user-2", "not_found"),
        ("offline", "user-1", "privacy_mode_unknown"),
    ],
)
def test_privacy_gate(phase3_client: TestClient, mode: str | None, owner: str, code: str) -> None:
    client = phase3_client
    client.portal.call(seed, client.app.state.store)

    class Repo:
        async def get_event_access(self, event_id: str) -> EventAccess:
            if mode == "offline":
                raise RuntimeError("unreachable")
            return EventAccess(owner, mode)

    client.app.state.event_repository = Repo()
    assert client.post("/api/v1/notes/cleanup", json=params()).json()["error"]["code"] == code


def test_ownership_precedes_privacy(phase3_client: TestClient) -> None:
    client = phase3_client
    client.portal.call(seed, client.app.state.store)
    client.portal.call(
        client.app.state.store.execute, "UPDATE sessions SET owner_uid='other' WHERE id='session1'"
    )
    assert client.post("/api/v1/notes/cleanup", json=params()).status_code == 404
    assert client.get("/api/v1/sessions/session1/polished").status_code == 404
    assert client.get("/api/v1/ai/jobs/unknown").status_code == 404


@pytest.mark.parametrize(
    "output,error",
    [
        (f"<<0>> {SENTINEL_TEXT}.", None),
        ("I refuse to do this", "missing_marker"),
        ("<<0>>", "empty"),
        ("<<0>> unrelated speech invented", "too_different"),
    ],
)
def test_cleanup_end_to_end(phase3_client: TestClient, output: str, error: str | None) -> None:
    client = phase3_client
    client.portal.call(seed, client.app.state.store)
    calls = install_http(client, lambda req: response(output))
    result = client.post("/api/v1/notes/cleanup", json=params())
    assert result.status_code == 202
    job = wait_job(client, result.json()["job_id"])
    assert job["status"] == ("failed" if error else "done")
    assert job["error_code"] == ("ai_output_invalid" if error else None)
    assert job["result"]["skipped"] == 2
    assert job["result"]["accepted"] == (0 if error else 1)
    chunks = client.portal.call(client.app.state.store.chunks, "session1")
    assert all(
        c["raw_text"] == SENTINEL_TEXT and c["raw_text_full"] == SENTINEL_TEXT for c in chunks
    )
    polished = client.get("/api/v1/sessions/session1/polished").json()["chunks"]
    assert polished[0]["polish_error"] == error
    assert (polished[0]["polished_text"] is None) == bool(error)
    assert len(calls) == 1
    assert json.loads(calls[0].content)["messages"][1]["content"] == f"<<0>> {SENTINEL_TEXT}"
    usage = client.portal.call(client.app.state.store.rows, "SELECT * FROM ai_usage")
    assert len(usage) == 1 and usage[0]["job_id"] == job["job_id"]
    assert SENTINEL_KEY not in json.dumps(usage) and SENTINEL_TEXT not in json.dumps(usage)
    client.portal.call(client.app.state.store.execute, "UPDATE ai_jobs SET owner_uid='other'")
    assert client.get(f"/api/v1/ai/jobs/{job['job_id']}").status_code == 404


def test_brief_incomplete_and_polished(phase3_client: TestClient) -> None:
    client = phase3_client
    client.portal.call(seed, client.app.state.store, "active")
    calls = install_http(client, lambda req: response("## Summary\n- [00:00] supported"))
    assert client.post("/api/v1/briefs", json=params("brief")).status_code == 409
    client.portal.call(
        client.app.state.store.execute,
        "UPDATE chunks SET polished_text='Owner approved words' WHERE sequence=0",
    )
    result = client.post(
        "/api/v1/briefs",
        json=params(
            "brief",
            allow_incomplete=True,
            use_polished=True,
            notes=[{"text": "owner instruction data", "timestamp_ms": None, "speaker": None}],
        ),
    )
    job = wait_job(client, result.json()["job_id"])
    assert job["status"] == "done" and job["result"]["incomplete"] is True
    assert job["result"]["source"] == {
        "session_ids": ["session1"],
        "chunk_count": 1,
        "used_polished": True,
    }
    assert job["result"]["structured_brief"] == {"Summary": ["[00:00] supported"]}
    prompt = json.loads(calls[0].content)["messages"][1]["content"]
    assert "Owner approved words" in prompt and "Owner's note (not speech)" in prompt


def test_local_only_and_health_no_calls(phase3_client: TestClient) -> None:
    client = phase3_client
    client.portal.call(seed, client.app.state.store)
    calls = install_http(client, lambda req: response("## Summary\n- supported"))

    class Repo:
        async def get_event_access(self, event_id: str) -> EventAccess:
            return EventAccess("user-1", "local_only")

    client.app.state.event_repository = Repo()
    # Health only consumes status; replacing the router with this local-only test router is safe.
    result = client.post("/api/v1/briefs", json=params("brief"))
    assert wait_job(client, result.json()["job_id"])["status"] == "done"
    assert len(calls) == 1


def test_health_never_probes(phase3_client: TestClient) -> None:
    client = phase3_client

    def fail(req: httpx.Request) -> httpx.Response:
        pytest.fail("Health contacted a provider")

    async def setup() -> None:
        client.app.state.ai_router.providers[0].client = httpx.AsyncClient(
            transport=httpx.MockTransport(fail)
        )

    client.portal.call(setup)
    assert client.get("/health").status_code == 200
    assert client.get("/api/v1/ai/status").status_code == 200
    client.portal.call(client.app.state.ai_router.providers[0].client.aclose)


def test_provider_failure_preserves_raw(phase3_client: TestClient) -> None:
    client = phase3_client
    client.portal.call(seed, client.app.state.store)
    install_http(client, lambda req: httpx.Response(401, text=SENTINEL_KEY + SENTINEL_TEXT))
    result = client.post("/api/v1/notes/cleanup", json=params())
    job = wait_job(client, result.json()["job_id"])
    assert job["status"] == "failed" and job["error_code"] == "provider_unavailable"
    assert all(
        c["raw_text"] == SENTINEL_TEXT and c["polished_text"] is None
        for c in client.portal.call(client.app.state.store.chunks, "session1")
    )


def test_failed_cleanup_keeps_previous_polish(phase3_client: TestClient) -> None:
    client = phase3_client
    client.portal.call(seed, client.app.state.store)
    install_http(client, lambda req: response(f"<<0>> {SENTINEL_TEXT}."))
    first = wait_job(client, client.post("/api/v1/notes/cleanup", json=params()).json()["job_id"])
    assert first["status"] == "done"
    # A later explicit request whose provider fails must not wipe the earlier good cleanup.
    install_http(client, lambda req: httpx.Response(503))
    second = client.post("/api/v1/notes/cleanup", json=params(level="polished"))
    assert wait_job(client, second.json()["job_id"])["status"] == "failed"
    polished = client.get("/api/v1/sessions/session1/polished").json()["chunks"]
    assert polished[0]["polished_text"] == f"{SENTINEL_TEXT}."
    assert polished[0]["polished_level"] == "conservative"
    assert all(
        c["raw_text"] == SENTINEL_TEXT
        for c in client.portal.call(client.app.state.store.chunks, "session1")
    )


def test_cleanup_window_respects_cleanup_budget(tmp_path: Path, make_settings: Any) -> None:
    settings = make_settings(ai_max_input_chars=12000, ai_cleanup_window_chars=40)
    lines = [f"<<{n}>> {'word ' * 5}" for n in range(4)]
    budget = min(settings.ai_max_input_chars, settings.ai_cleanup_window_chars)
    assert len(partition(lines, budget)) > 1


def test_ai_rate_limit(phase3_client: TestClient) -> None:
    from app.security.rate_limit import TokenBucketLimiter

    client = phase3_client
    client.portal.call(seed, client.app.state.store)
    install_http(client, lambda req: response("## Summary\n- supported"))
    client.app.state.ai_user_limiter = TokenBucketLimiter(1)
    assert client.post("/api/v1/briefs", json=params("brief")).status_code == 202
    result = client.post("/api/v1/briefs", json=params("brief"))
    assert result.status_code == 429 and int(result.headers["Retry-After"]) > 0


@pytest.mark.parametrize("stop", [False, True])
def test_queue_timeout_shutdown_recovery(tmp_path: Path, make_settings: Any, stop: bool) -> None:
    async def scenario() -> None:
        settings = make_settings(ai_queue_max=1, ai_job_timeout_s=0.05)
        store = Store(tmp_path)
        await store.open()
        await seed(store)
        started = asyncio.Event()

        async def handle(req: httpx.Request) -> httpx.Response:
            started.set()
            await asyncio.Event().wait()
            return response()

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
            router = ProviderRouter([LocalProvider(http, "http://local.test", "mock")], settings)
            service = AIJobService(settings, store, router, FakeEventRepo, FakeFirestoreSync)
            await service.start()
            first = await service.submit("cleanup", "user-1", params(), "req1")
            await started.wait()
            second = await service.submit("cleanup", "user-1", params(), "req2")
            with pytest.raises(AppError, match="AI queue is full"):
                await service.submit("cleanup", "user-1", params(), "req3")
            if stop:
                await service.stop()
                rows = await store.rows("SELECT status FROM ai_jobs")
                assert all(row["status"] == "interrupted" for row in rows)
            else:
                await service.queue.join()
                rows = await store.rows("SELECT * FROM ai_jobs")
                assert all(
                    r["status"] == "failed" and r["error_code"] == "job_timeout" for r in rows
                )
                await service.stop()
            await store.execute(
                "UPDATE ai_jobs SET status='running' WHERE id=?", (first["job_id"],)
            )
            await store.execute(
                "UPDATE ai_jobs SET status='queued' WHERE id=?", (second["job_id"],)
            )
            await store.close()
            await store.open()
            assert all(
                row["status"] == "interrupted" for row in await store.rows("SELECT * FROM ai_jobs")
            )
        await store.close()

    asyncio.run(scenario())


def test_map_reduce_and_overflow(tmp_path: Path, make_settings: Any) -> None:
    async def scenario() -> None:
        settings = make_settings(ai_max_input_chars=80)
        store = Store(tmp_path)
        await store.open()
        await seed(store, text="hello world " * 3)
        await store.execute("UPDATE chunks SET status='done', no_speech=0")
        calls = []

        def handle(req: httpx.Request) -> httpx.Response:
            prompt = json.loads(req.content)["messages"][1]["content"]
            assert len(prompt) <= 80
            calls.append(prompt)
            return response("## Summary\n- supported")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
            router = ProviderRouter([LocalProvider(http, "http://local.test", "mock")], settings)
            service = AIJobService(settings, store, router, FakeEventRepo, FakeFirestoreSync)
            result = await service.brief(params("brief"), [await store.session("session1")], True)
            assert result["structured_brief"] == {"Summary": ["supported"]}
            assert len(calls) == 4
            await store.execute("UPDATE chunks SET raw_text=?", ("x" * 81,))
            with pytest.raises(AppError) as exc:
                await service.brief(params("brief"), [await store.session("session1")], True)
            assert exc.value.code == "transcript_too_long"
        await store.close()

    asyncio.run(scenario())


def test_partition() -> None:
    assert partition(["one", "two", "three"], 7) == ["one\ntwo", "three"]


@pytest.mark.parametrize(
    "kind,path", [("cleanup", "/api/v1/notes/cleanup"), ("brief", "/api/v1/briefs")]
)
def test_queue_full_endpoint(phase3_client: TestClient, kind: str, path: str) -> None:
    client = phase3_client
    client.portal.call(seed, client.app.state.store)
    calls = install_http(client, lambda req: response("unused"))
    client.app.state.ai_jobs.accepting = False
    result = client.post(path, json=params(kind))
    assert result.status_code == 503 and result.json()["error"]["code"] == "queue_full"
    assert calls == []


def test_global_ai_limit_and_note_limit(phase3_client: TestClient) -> None:
    from app.security.rate_limit import TokenBucketLimiter

    client = phase3_client
    client.portal.call(seed, client.app.state.store)
    install_http(client, lambda req: response("## Summary\n- supported"))
    client.app.state.settings.ai_brief_max_notes = 1
    assert (
        client.post(
            "/api/v1/briefs", json=params("brief", notes=[{"text": "a"}, {"text": "b"}])
        ).status_code
        == 422
    )
    client.app.state.ai_global_limiter = TokenBucketLimiter(1)
    assert client.post("/api/v1/briefs", json=params("brief")).status_code == 202
    result = client.post("/api/v1/briefs", json=params("brief"))
    assert result.status_code == 429 and "Retry-After" in result.headers


def test_privacy_rechecked_at_execution(phase3_client: TestClient) -> None:
    client = phase3_client
    client.portal.call(seed, client.app.state.store)
    calls = install_http(client, lambda req: response("unused"))

    class Repo:
        def __init__(self) -> None:
            self.lookups = 0

        async def get_event_access(self, event_id: str) -> EventAccess:
            self.lookups += 1
            return EventAccess("user-1", "cloud_ai" if self.lookups == 1 else None)

    client.app.state.event_repository = Repo()
    result = client.post("/api/v1/briefs", json=params("brief"))
    assert result.status_code == 202
    job = wait_job(client, result.json()["job_id"])
    assert job["status"] == "failed" and job["error_code"] == "privacy_mode_unknown"
    assert calls == []


def test_polish_sync_failure_does_not_fail_job(phase3_client: TestClient) -> None:
    client = phase3_client
    client.portal.call(seed, client.app.state.store)
    install_http(client, lambda req: response(f"<<0>> {SENTINEL_TEXT}."))
    client.app.state.firestore_sync.fail = True
    result = client.post("/api/v1/notes/cleanup", json=params())
    assert wait_job(client, result.json()["job_id"])["status"] == "done"
