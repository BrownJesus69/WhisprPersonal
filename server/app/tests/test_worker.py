import time
from typing import Any

import pytest

from app.tests.fakes import FakeEngine, create_session, upload_chunk, wait_done


@pytest.mark.parametrize(
    ("speech", "mode", "expected"), [(0.0, "auto", None), (16, "kn", "kn"), (16, "auto", "en")]
)
def test_worker_results_partials_and_vad(
    phase3_client: Any, speech: float, mode: str, expected: str | None
) -> None:
    client = phase3_client
    state = client.app.state
    engine = FakeEngine(speech=[speech])
    state.worker.engine = engine
    create_session(client, language_mode=mode)
    subscriber = client.portal.call(state.broadcaster.subscribe, "session1")
    upload_chunk(client)
    state.server_state.model_status = "ready"
    client.portal.call(state.worker.notify)
    result = wait_done(client)
    chunk = result["chunks"][0]
    assert chunk["detected_language"] == expected
    assert chunk["no_speech"] == (speech == 0)
    assert any(call[0] == "detect" for call in engine.calls) == (speech > 0 and mode == "auto")
    events = client.portal.call(state.store.events, "session1")
    assert "transcript_final" in [event["type"] for event in events]
    assert "transcript_partial" not in [event["type"] for event in events]

    async def drain() -> list[dict]:
        messages = []
        while not subscriber.queue.empty():
            messages.append(subscriber.queue.get_nowait())
        return messages

    messages = client.portal.call(drain)
    assert any(m["type"] == "transcript_partial" for m in messages) == (speech > 0)


def test_retry_backoff_failure_and_audio_retention(phase3_client: Any) -> None:
    client = phase3_client
    state = client.app.state
    state.worker.engine = FakeEngine(failures=10)
    state.settings.chunk_retry_base_s = 10
    create_session(client)
    upload_chunk(client)
    client.portal.call(state.store.execute, "UPDATE chunks SET raw_text='existing raw text'")
    state.server_state.model_status = "ready"
    client.portal.call(state.worker.notify)
    deadline = time.monotonic() + 5
    rows = []
    while time.monotonic() < deadline:
        rows = client.portal.call(state.store.chunks, "session1")
        if rows[0]["attempts"] == 1:
            break
        time.sleep(0.01)
    assert rows[0]["status"] == "queued" and rows[0]["next_attempt_at"] > time.time() + 7
    state.settings.chunk_retry_base_s = 0.001
    client.portal.call(state.store.execute, "UPDATE chunks SET next_attempt_at=0")
    client.portal.call(state.worker.notify)
    wait_done(client, "failed")
    rows = client.portal.call(state.store.chunks, "session1")
    assert rows[0]["attempts"] == 3
    assert rows[0]["raw_text"] == "existing raw text"
    assert (state.store.audio_dir / "session1" / rows[0]["file_name"]).exists()
    result = client.post("/api/v1/sessions/session1/finalize", json={"expected_chunk_count": 1})
    assert result.json()["transcript_status"] == "partial"


def test_model_not_ready_and_recovery(phase3_client: Any) -> None:
    client = phase3_client
    state = client.app.state
    create_session(client)
    upload_chunk(client)
    rows = client.portal.call(state.store.chunks, "session1")
    assert rows[0]["status"] == "queued" and rows[0]["attempts"] == 0
    client.portal.call(state.store.execute, "UPDATE chunks SET status='processing',attempts=1")
    assert client.portal.call(state.store.recover_on_startup) == {"requeued": 1}
    assert client.portal.call(state.store.chunks, "session1")[0]["attempts"] == 1


def test_cloud_failure_retry_and_delete_audio(phase3_client: Any) -> None:
    client = phase3_client
    state = client.app.state
    state.settings.server_audio_retention = "delete_on_finalize"
    create_session(client)
    upload_chunk(client)
    state.server_state.model_status = "ready"
    client.portal.call(state.worker.notify)
    wait_done(client)
    state.firestore_sync.fail = True
    result = client.post("/api/v1/sessions/session1/finalize", json={"expected_chunk_count": 1})
    assert result.status_code == 200 and result.json()["firestore_sync"] == "failed"
    assert not (state.store.audio_dir / "session1").exists()
    assert len(client.portal.call(state.store.chunks, "session1")) == 1
    state.firestore_sync.fail = False
    client.portal.call(state.worker.retry_sync)
    assert client.get("/api/v1/sessions/session1").json()["firestore_sync"] == "synced"


def test_graceful_stop_finishes_inflight(phase3_client: Any) -> None:
    client = phase3_client
    state = client.app.state
    create_session(client)
    upload_chunk(client)
    state.server_state.model_status = "ready"
    client.portal.call(state.worker.notify)
    wait_done(client)
    client.portal.call(state.worker.stop)
    assert state.server_state.queue_status == "stopping"
    assert client.portal.call(state.store.chunks, "session1")[0]["status"] == "done"


def test_shutdown_timeout_preserves_processing_for_restart(phase3_client: Any) -> None:
    import threading

    client = phase3_client
    state = client.app.state
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()

    class BlockingEngine(FakeEngine):
        def load_audio(self, path: Any) -> Any:
            entered.set()
            assert release.wait(5)
            try:
                return super().load_audio(path)
            finally:
                finished.set()

    state.worker.engine = BlockingEngine()
    state.settings.shutdown_drain_timeout_s = 0.05
    create_session(client)
    upload_chunk(client)
    state.server_state.model_status = "ready"
    client.portal.call(state.worker.notify)
    assert entered.wait(2)
    try:
        assert client.delete("/api/v1/sessions/session1").status_code == 409
        client.portal.call(state.worker.stop)
        chunk = client.portal.call(state.store.chunks, "session1")[0]
        assert chunk["status"] == "processing" and chunk["attempts"] == 0
        assert client.portal.call(state.store.recover_on_startup) == {"requeued": 1}
    finally:
        release.set()
        assert finished.wait(2)


def test_per_chunk_override_and_hotword_limit(phase3_client: Any) -> None:
    client = phase3_client
    state = client.app.state
    create_session(client)
    terms = ["t" * 60 + str(i) for i in range(10)]
    client.post("/api/v1/vocabulary", json={"event_id": "event1", "terms": terms})
    upload_chunk(client, language="hi")
    state.server_state.model_status = "ready"
    client.portal.call(state.worker.notify)
    result = wait_done(client)
    assert result["language"]["mode"] == "auto"
    assert result["chunks"][0]["language_source"] == "override"
    assert not any(call[0] == "detect" for call in state.engine.calls)
    assert len(state.engine.calls[-1][1]["hotwords"]) == 400


def test_start_write_failure_remains_pending(phase3_client: Any) -> None:
    client = phase3_client
    state = client.app.state
    state.firestore_sync.fail = True
    result = create_session(client)
    assert result.status_code == 201 and result.json()["firestore_sync"] == "pending"
    state.firestore_sync.fail = False
    client.portal.call(state.worker.retry_sync)
    assert client.get("/api/v1/sessions/session1").json()["firestore_sync"] == "synced"
