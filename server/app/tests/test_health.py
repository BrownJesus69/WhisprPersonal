import secrets
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.main import create_app
from app.schemas.health import HealthResponse


def test_health_schema(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    health = HealthResponse.model_validate(response.json())
    assert health.status == "degraded"
    assert health.model.status == "not_loaded"
    assert health.queue.status == "not_started"
    assert health.uptime_s >= 0
    assert all(p["status"] == "not_configured" for p in health.providers.model_dump().values())
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["cache-control"] == "no-store"


def test_provider_config_and_no_leaks(make_settings: Any, tmp_path: Path) -> None:
    key = secrets.token_urlsafe(36)
    settings = make_settings(groq_api_key=key, groq_model="test-model")
    with TestClient(create_app(settings), client=("127.0.0.1", 1)) as client:
        response = client.get("/health")
    assert response.json()["providers"]["groq"]["status"] == "configured_unchecked"
    for forbidden in (key, settings.server_shared_secret.get_secret_value(), str(tmp_path)):
        assert forbidden not in response.text
    settings = make_settings(groq_api_key=key)
    with TestClient(create_app(settings), client=("127.0.0.1", 1)) as client:
        assert client.get("/health").json()["providers"]["groq"]["status"] == "not_configured"
