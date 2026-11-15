from typing import Any

from app.tests.fakes import create_session, upload_chunk, wait_done


def test_vocabulary_normalization_and_hotwords(phase3_client: Any) -> None:
    client = phase3_client
    data = {
        "event_id": "event1",
        "terms": [" Bengaluru ", "Bengaluru", "summit", ""],
        "replacements": [{"from": "Bengaluru", "to": "changed"}],
    }
    result = client.post("/api/v1/vocabulary", json=data)
    assert result.status_code == 200 and result.json()["terms"] == ["Bengaluru", "summit"]
    assert client.get("/api/v1/vocabulary?event_id=event1").json() == result.json()
    assert client.post("/api/v1/vocabulary", json={**data, "event_id": "other"}).status_code == 404
    assert client.post("/api/v1/vocabulary", json={**data, "terms": ["a" * 65]}).status_code == 422
    create_session(client)
    upload_chunk(client)
    state = client.app.state
    state.server_state.model_status = "ready"
    client.portal.call(state.worker.notify)
    result = wait_done(client)
    assert result["chunks"][0]["raw_text"] == "technology summit Bengaluru"
    assert state.engine.calls[-1][1]["hotwords"] == "Bengaluru, summit"
