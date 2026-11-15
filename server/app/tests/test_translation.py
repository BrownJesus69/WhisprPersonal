"""Offline translation integration, real SQLite, mocked loopback/cloud HTTP."""

import asyncio
import io
import json
import secrets
import time
import wave
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError

from app.core.errors import AppError
from app.security.ownership import EventAccess
from app.services.llm.base import ChatResult
from app.services.llm.router import build_router
from app.services.llm.usage import UsageRecorder
from app.services.store import Store
from app.services.translation.audio import MAX_AUDIO_BYTES, AudioFallback, wav_bytes
from app.services.translation.jobs import TranslationJobService, source_for
from app.services.translation.router import DIRECTIONS, TranslationRouter, unavailable
from app.tests.fakes import FakeEventRepo, create_session, upload_chunk, wait_done
from app.tests.test_ai_jobs import seed


def test_translation_config(make_settings: Any) -> None:
    settings = make_settings(libretranslate_enabled_pairs="hi-en,en-hi")
    assert settings.libretranslate_enabled_pairs == ["hi-en", "en-hi"]
    assert not settings.groq_audio_configured
    assert settings.translator_timeout_s == 60
    for url in (
        "https://libretranslate.com",
        "http://10.0.0.1:5000",
        "http://localhost@evil.test",
        "http://localhost/?key=x",
    ):
        with pytest.raises(ValidationError):
            make_settings(libretranslate_url=url)
    assert make_settings(libretranslate_url="http://[::1]:5000").libretranslate_url


def benchmark(path: Path, score: float = 90, baseline: float = 100) -> None:
    path.write_text(
        json.dumps(
            {
                "engines": {
                    "indictrans2": {"hi-en": {"chrf": baseline, "n": 12}},
                    "libretranslate": {"hi-en": {"chrf": score, "n": 12, "eligible": True}},
                }
            }
        ),
        encoding="utf-8",
    )


@pytest.mark.parametrize(
    "enabled,score,ready,expected",
    [
        (True, 90, True, "indictrans2"),
        (True, 90, False, "libretranslate"),
        (False, 100, False, None),
        (True, 89, False, None),
        (True, 34, False, None),
    ],
)
def test_router_precedence(
    make_settings: Any,
    tmp_path: Path,
    enabled: bool,
    score: float,
    ready: bool,
    expected: str | None,
) -> None:
    path = tmp_path / "benchmark.json"
    benchmark(path, score)
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        if req.url.path == "/languages":
            return httpx.Response(
                200, json=[{"code": "hi", "targets": ["en"]}, {"code": "en", "targets": ["hi"]}]
            )
        if req.url.path == "/health":
            return httpx.Response(
                200,
                json={
                    "configured": True,
                    "directions": dict.fromkeys(
                        DIRECTIONS, "ready_on_disk" if ready else "not_downloaded"
                    ),
                },
            )
        payload = json.loads(req.content)
        if req.url.port == 8100:
            return httpx.Response(
                200,
                json={
                    **payload,
                    "engine": "indictrans2",
                    "model": "fake@pinned",
                    "segments": [{"id": "0", "text": "Hello"}],
                    "created_at": "2026-11-16T00:00:00Z",
                },
            )
        assert payload == {"q": "नमस्ते", "source": "hi", "target": "en", "format": "text"}
        return httpx.Response(200, json={"translatedText": "Hello"})

    async def check() -> None:
        settings = make_settings(
            translator_shared_secret=secrets.token_urlsafe(36),
            libretranslate_enabled_pairs=["hi-en"] if enabled else [],
            translation_benchmark_path=path,
        )
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            router = TranslationRouter(settings, client)
            if expected:
                result = await router.translate("hi", "en", [{"id": "0", "text": "नमस्ते"}])
                assert result["engine"] == expected
            else:
                with pytest.raises(AppError, match="Translation unavailable"):
                    await router.translate("hi", "en", [{"id": "0", "text": "नमस्ते"}])
                assert all(r.url.path == "/health" for r in calls)
            await router.refresh()
            assert sum(r.url.path == "/health" for r in calls) == 1

    asyncio.run(check())


def test_benchmark_fail_closed_and_reloads(make_settings: Any, tmp_path: Path) -> None:
    path = tmp_path / "benchmark.json"

    async def check() -> None:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda r: httpx.Response(500))
        ) as http:
            router = TranslationRouter(make_settings(translation_benchmark_path=path), http)
            router.read_benchmark()
            assert not router.eligible
            benchmark(path)
            router.read_benchmark()
            assert router.eligible == {"hi-en"}
            path.write_text('{"engines":null}', encoding="utf-8")
            router.read_benchmark()
            assert not router.eligible
            benchmark(path, float("nan"))
            router.read_benchmark()
            assert not router.eligible
            path.unlink()
            router.read_benchmark()
            assert not router.eligible

    asyncio.run(check())


def test_enabled_benchmarked_libre_stopped_is_unavailable(
    make_settings: Any, tmp_path: Path
) -> None:
    path = tmp_path / "benchmark.json"
    benchmark(path)
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(503)

    async def check() -> None:
        settings = make_settings(
            libretranslate_enabled_pairs=["hi-en"], translation_benchmark_path=path
        )
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            router = TranslationRouter(settings, http)
            assert not await router.can_serve("hi", "en")
            assert router.status()["libretranslate"]["hi-en"] == {
                "enabled": True,
                "eligible": True,
                "available": False,
            }
            with pytest.raises(AppError, match="Translation unavailable"):
                await router.translate("hi", "en", [{"id": "0", "text": "नमस्ते"}])
            assert calls == ["/languages"]

    asyncio.run(check())


def payload(**extra: Any) -> dict[str, Any]:
    return {"event_id": "event1", "session_ids": ["session1"], "target_lang": "en", **extra}


def wait_job(client: TestClient, job_id: str) -> Any:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        data = client.get(f"/api/v1/translation/jobs/{job_id}").json()
        if data["status"] not in {"queued", "running"}:
            return data
        time.sleep(0.01)
    raise AssertionError("Translation job did not finish")


class FakeTranslationRouter:
    async def can_serve(self, source: str, target: str) -> bool:
        return True

    async def translate(self, source: str, target: str, segments: Any) -> Any:
        return {
            "engine": "indictrans2",
            "model": "fake@pinned",
            "created_at": "2026-11-16T00:00:00Z",
            "segments": [
                {"id": s["id"], "text": "The meeting starts at 2:30 PM."} for s in segments
            ],
        }


def prepare(client: TestClient) -> None:
    client.portal.call(seed, client.app.state.store, "finalized", "नमस्ते, बैठक ढाई बजे है।")
    client.portal.call(
        client.app.state.store.execute,
        "UPDATE chunks SET detected_language='hi' WHERE session_id='session1'",
    )


def test_endpoint_unavailable_auth_ownership(phase3_client: TestClient) -> None:
    client = phase3_client
    prepare(client)
    response = client.post("/api/v1/translate", json=payload())
    assert response.status_code == 503
    assert (
        response.json()["error"]["message"]
        == "Translation unavailable; showing the original transcript."
    )
    for path in (
        "/api/v1/translation/status",
        "/api/v1/translation/jobs/missing",
        "/api/v1/sessions/session1/translations?target_lang=en",
    ):
        assert client.get(path, headers={"Authorization": ""}).status_code == 401
    assert client.post("/api/v1/translate", json=payload(event_id="other")).status_code == 404
    client.portal.call(client.app.state.store.execute, "UPDATE sessions SET status='active'")
    assert client.post("/api/v1/translate", json=payload()).status_code == 409
    client.portal.call(
        client.app.state.store.execute, "UPDATE sessions SET owner_uid='someoneelse'"
    )
    assert client.get("/api/v1/sessions/session1/translations?target_lang=en").status_code == 404
    assert client.get("/api/v1/translation/jobs/missing").status_code == 404


@pytest.mark.parametrize(
    "polish_output,expected",
    [
        ("<<0>> The meeting starts at 2:30 PM.", True),
        ("The meeting starts at 2:30 PM.", False),
        ("<<0>> A completely unrelated story about purple elephants.", False),
        ("<<0>> नमस्ते", False),
        (None, False),
    ],
)
def test_job_labels_raw_untouched_and_polish(
    phase3_client: TestClient, polish_output: str | None, expected: bool
) -> None:
    client = phase3_client
    prepare(client)
    state = client.app.state
    state.translation_router = state.translation_jobs.router = FakeTranslationRouter()

    class LLM:
        async def complete(self, req: Any, allow_cloud: bool) -> Any:
            assert allow_cloud
            assert req.purpose == "translation_polish"
            assert "translation only" in req.messages[0].content
            if polish_output is None:
                raise RuntimeError("mock provider offline")
            return ChatResult(polish_output, "groq", "fake-polisher")

    state.translation_jobs.llm = LLM()
    before = client.portal.call(state.store.chunks, "session1")
    response = client.post("/api/v1/translate", json=payload(polish=True))
    assert response.status_code == 202
    job_id = response.json()["job_id"]
    assert wait_job(client, job_id)["status"] == "done"
    row = client.get("/api/v1/sessions/session1/translations?target_lang=en").json()["chunks"][0]
    assert row["engine"] == "indictrans2" and row["model"] == "fake@pinned"
    assert row["source_lang"] == "hi" and row["created_at"]
    assert bool(row["polished_text"]) == expected
    assert row["text"] == "The meeting starts at 2:30 PM."
    after = client.portal.call(state.store.chunks, "session1")
    assert [(c["raw_text"], c["raw_text_full"]) for c in before] == [
        (c["raw_text"], c["raw_text_full"]) for c in after
    ]
    client.portal.call(state.store.execute, "DELETE FROM sessions WHERE id='session1'")
    assert not client.portal.call(state.store.rows, "SELECT * FROM translations")
    assert not client.portal.call(state.store.rows, "SELECT * FROM translation_jobs")


def test_unknown_same_language_and_override(phase3_client: TestClient) -> None:
    client = phase3_client
    prepare(client)
    client.portal.call(client.app.state.store.execute, "UPDATE chunks SET language_uncertain=1")
    response = client.post("/api/v1/translate", json=payload())
    assert wait_job(client, response.json()["job_id"])["status"] == "done"
    row = client.get("/api/v1/sessions/session1/translations?target_lang=en").json()["chunks"][0]
    assert row["error_code"] == "source_unknown" and row["text"] is None
    client.portal.call(client.app.state.store.execute, "UPDATE chunks SET language_requested='en'")
    response = client.post("/api/v1/translate", json=payload())
    assert wait_job(client, response.json()["job_id"])["status"] == "done"
    row = client.get("/api/v1/sessions/session1/translations?target_lang=en").json()["chunks"][0]
    assert row["error_code"] == "same_language"
    assert source_for({"language_requested": "kn", "language_uncertain": 1}) == "kn"


def test_restart_interrupts_translation_jobs(make_settings: Any, tmp_path: Path) -> None:
    async def check() -> None:
        store = Store(tmp_path)
        await store.open()
        await seed(store)
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda r: httpx.Response(500))
        ) as http:
            llm = build_router(make_settings(), http, UsageRecorder(store))
            jobs = TranslationJobService(
                make_settings(),
                store,
                FakeTranslationRouter(),
                lambda: FakeEventRepo(),
                llm,
                None,
                None,
            )
            jobs.accepting = True
            result = await jobs.submit("text", "user-1", payload(polish=False), "request")
            await store.close()
            await store.open()
            rows = await store.rows(
                "SELECT status FROM translation_jobs WHERE id=?", (result["job_id"],)
            )
            assert rows[0]["status"] == "interrupted"
            assert jobs.queue.qsize() == 1  # Durable restart does not enqueue any work itself.
        await store.close()

    asyncio.run(check())


def make_wav() -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(16000)
        writer.writeframes(b"\0\0" * 100)
    return out.getvalue()


@pytest.mark.parametrize(
    "code,enabled,configured,mode,expected",
    [
        ("load_failed", True, True, "cloud_ai", True),
        ("model_files_missing", True, True, "cloud_ai", True),
        ("cuda_unavailable", True, True, "cloud_ai", True),
        ("model_not_ready", True, True, "cloud_ai", True),
        ("audio_decode_failed", True, True, "cloud_ai", False),
        ("transcription_failed", True, True, "cloud_ai", False),
        ("load_failed", False, True, "cloud_ai", False),
        ("load_failed", True, False, "cloud_ai", False),
        ("load_failed", True, True, "local_only", False),
        ("load_failed", True, True, None, False),
    ],
)
def test_audio_fallback_gates_and_multipart(
    make_settings: Any,
    tmp_path: Path,
    code: str,
    enabled: bool,
    configured: bool,
    mode: str | None,
    expected: bool,
) -> None:
    calls = []
    sleeps = []
    audio = make_wav()

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        assert req.url.path.endswith("/audio/translations")
        body = req.content
        for content in (
            b'name="model"',
            b"audio-test-model",
            b'name="response_format"',
            b"json",
            b'name="temperature"',
            b'filename="chunk.wav"',
            b"audio/wav",
            audio,
        ):
            assert content in body
        if len(calls) == 1:
            return httpx.Response(429, headers={"Retry-After": "0.01"})
        return httpx.Response(200, json={"text": "The meeting starts at 2:30 PM."})

    class Repo:
        async def get_event_access(self, event: str) -> Any:
            return EventAccess("user-1", mode)

    async def check() -> None:
        settings = make_settings(
            groq_audio_fallback_enabled=enabled,
            groq_api_key=secrets.token_urlsafe(36) if configured else None,
            groq_audio_translation_model="audio-test-model" if configured else None,
        )
        store = Store(tmp_path)
        await store.open()
        await seed(store)
        await store.execute("UPDATE chunks SET status='failed',raw_text=NULL WHERE sequence=0")
        path = store.audio_dir / "session1"
        path.mkdir()
        (path / "chunk.wav").write_bytes(audio)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            llm = build_router(settings, http, UsageRecorder(store))
            fallback = AudioFallback(settings, http, llm)

            async def sleep(seconds: float) -> None:
                sleeps.append(seconds)

            fallback.retry_options["sleep"] = sleep
            jobs = TranslationJobService(
                settings,
                store,
                FakeTranslationRouter(),
                lambda: Repo(),
                llm,
                fallback,
                type("Broadcaster", (), {"publish": lambda *a: None})(),
            )
            jobs.accepting = True
            session = await store.session("session1")
            chunk = (await store.chunks("session1"))[0]
            chunk["file_name"] = "chunk.wav"
            await fallback.enqueue(jobs, session, chunk, code)
            assert bool(jobs.queue.qsize()) == expected
            if expected:
                job_id, request_id = await jobs.queue.get()
                await jobs.process(job_id, request_id)
                assert len(calls) == 2 and sleeps == [0.01]
                row = (await store.rows("SELECT * FROM translations"))[0]
                assert row["engine"] == "groq-audio-translation"
                assert row["source_lang"] == "und" and row["target_lang"] == "en"
                assert row["model"] == "audio-test-model"
                assert any(
                    e["type"] == "chunk_audio_translated" for e in await store.events("session1")
                )
                raw = (await store.chunks("session1"))[0]
                assert raw["status"] == "failed" and raw["raw_text"] is None
            else:
                assert not calls
        await store.close()

    asyncio.run(check())


def test_audio_size_guard(tmp_path: Path) -> None:
    path = tmp_path / "large.wav"
    with path.open("wb") as file:
        file.truncate(MAX_AUDIO_BYTES + 1)
    with pytest.raises(ValueError, match="file_too_large"):
        wav_bytes(path)


def test_health_uses_cache_only(phase3_client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def fail() -> None:
        raise AssertionError("Health must not probe")

    monkeypatch.setattr(phase3_client.app.state.translation_router, "refresh", fail)
    assert "translation" in phase3_client.get("/health").json()


def test_failed_job_and_preserve_previous_translation(phase3_client: TestClient) -> None:
    client = phase3_client
    prepare(client)
    state = client.app.state

    class FailingRouter(FakeTranslationRouter):
        async def translate(self, *args: Any) -> Any:
            raise unavailable()

    state.translation_router = state.translation_jobs.router = FailingRouter()

    async def save() -> None:
        await state.translation_jobs.save(
            "session1",
            0,
            "en",
            "hi",
            text="Previous translation",
            engine="indictrans2",
            model="fake@pinned",
        )

    client.portal.call(save)
    response = client.post("/api/v1/translate", json=payload())
    assert wait_job(client, response.json()["job_id"])["status"] == "failed"
    row = client.get("/api/v1/sessions/session1/translations?target_lang=en").json()["chunks"][0]
    assert row["text"] == "Previous translation"


def test_bounded_queue_and_running_cancellation(make_settings: Any, tmp_path: Path) -> None:
    async def check() -> None:
        store = Store(tmp_path)
        await store.open()
        await seed(store)
        await store.execute("UPDATE chunks SET detected_language='hi'")
        entered = asyncio.Event()

        class Blocking(FakeTranslationRouter):
            async def translate(self, *args: Any) -> Any:
                entered.set()
                await asyncio.Event().wait()

        jobs = TranslationJobService(
            make_settings(ai_queue_max=1),
            store,
            Blocking(),
            lambda: FakeEventRepo(),
            None,
            None,
            None,
        )
        jobs.accepting = True
        first = await jobs.submit("text", "user-1", payload(polish=False), "id")
        with pytest.raises(AppError, match="queue is full"):
            await jobs.submit("text", "user-1", payload(polish=False), "id")
        assert len(await store.rows("SELECT * FROM translation_jobs")) == 1
        await jobs.start()
        await asyncio.wait_for(entered.wait(), timeout=2)
        second = await jobs.submit("text", "user-1", payload(polish=False), "id")
        await jobs.stop()
        rows = await store.rows("SELECT id,status FROM translation_jobs")
        assert {r["id"] for r in rows} == {first["job_id"], second["job_id"]}
        assert {r["status"] for r in rows} == {"interrupted"}
        await store.close()

    asyncio.run(check())


@pytest.mark.parametrize(
    "code", ["load_failed", "model_files_missing", "cuda_unavailable", "model_not_ready"]
)
def test_terminal_worker_hook(phase3_client: TestClient, code: str) -> None:
    client = phase3_client
    state = client.app.state
    calls = []

    class Audio:
        async def enqueue(self, service: Any, session: Any, chunk: Any, error: str) -> None:
            rows = await state.store.chunks(session["id"])
            assert rows[0]["status"] == "failed" and rows[0]["attempts"] == 2
            calls.append(error)

    state.worker.audio_fallback = Audio()
    state.settings.groq_audio_fallback_enabled = True
    state.settings.groq_api_key = SecretStr(secrets.token_urlsafe(36))
    state.settings.groq_audio_translation_model = "audio-test-model"
    state.settings.chunk_max_attempts = 2
    state.settings.chunk_retry_base_s = 0.001
    assert create_session(client).status_code == 201
    assert upload_chunk(client).status_code == 202
    state.server_state.model_status = "error"
    state.server_state.model_error = code
    client.portal.call(state.worker.notify)
    wait_done(client, "failed")
    deadline = time.monotonic() + 2
    while not calls and time.monotonic() < deadline:
        time.sleep(0.01)
    assert calls == [code]


@pytest.mark.parametrize("mode,cloud", [("local_only", False), ("cloud_ai", True), (None, None)])
def test_polish_privacy(phase3_client: TestClient, mode: str | None, cloud: bool | None) -> None:
    client = phase3_client
    prepare(client)
    state = client.app.state

    class Repo:
        async def get_event_access(self, event: str) -> Any:
            return EventAccess("user-1", mode)

    class LLM:
        async def complete(self, request: Any, allow_cloud: bool) -> Any:
            assert allow_cloud is cloud
            calls.append(allow_cloud)
            return ChatResult("<<0>> The meeting starts at 2:30 PM.", "local_llm", "fake-polisher")

    calls = []
    state.event_repository = Repo()
    state.translation_router = state.translation_jobs.router = FakeTranslationRouter()
    state.translation_jobs.llm = LLM()
    response = client.post("/api/v1/translate", json=payload(polish=True))
    assert wait_job(client, response.json()["job_id"])["status"] == "done"
    assert calls == ([] if cloud is None else [cloud])


@pytest.mark.parametrize("scenario", ["breaker", "rpm", "privacy"])
def test_audio_breaker_rpm_and_privacy_recheck(
    make_settings: Any, tmp_path: Path, scenario: str
) -> None:
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        return httpx.Response(500 if scenario == "breaker" else 200, json={"text": "Hello"})

    class Repo:
        mode = "cloud_ai"

        async def get_event_access(self, event: str) -> Any:
            return EventAccess("user-1", self.mode)

    async def check() -> None:
        settings = make_settings(
            groq_audio_fallback_enabled=True,
            groq_api_key=secrets.token_urlsafe(36),
            groq_audio_translation_model="audio-test-model",
            ai_retry_max_attempts=1,
            ai_circuit_failure_threshold=1,
            groq_max_rpm=1 if scenario == "rpm" else None,
        )
        store = Store(tmp_path)
        await store.open()
        await seed(store)
        repo = Repo()
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            llm = build_router(settings, http, UsageRecorder(store))
            fallback = AudioFallback(settings, http, llm)
            jobs = TranslationJobService(
                settings,
                store,
                FakeTranslationRouter(),
                lambda: repo,
                llm,
                fallback,
                type("Broadcaster", (), {"publish": lambda *a: None})(),
            )
            session = await store.session("session1")
            for i in range(2):
                if i and scenario == "privacy":
                    repo.mode = "local_only"
                job = {"id": f"audio{i}"}
                fallback.buffers[job["id"]] = make_wav()
                result = await fallback.run(jobs, job, session, {"sequence": 0})
                if i:
                    assert result["failed"] == 1
            assert len(calls) == 1
            if scenario == "breaker":
                assert fallback.breaker.status == "circuit_open"
        await store.close()

    asyncio.run(check())
