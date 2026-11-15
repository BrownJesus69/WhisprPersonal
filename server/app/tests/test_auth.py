import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.tests.conftest import FakeTokenVerifier


@pytest.mark.parametrize("authorization", ["", "Basic abc", "Bearer", "Bearer   ", "Bearer a b"])
def test_missing_token(client: TestClient, settings: Settings, authorization: str) -> None:
    response = client.get(
        "/api/v1/diagnostics",
        headers={
            "X-WhisprPersonal-Server-Key": settings.server_shared_secret.get_secret_value(),
            "Authorization": authorization,
        },
    )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "missing_auth_token"


def test_disabled_and_bad(app: FastAPI, client: TestClient, settings: Settings) -> None:
    headers = {
        "X-WhisprPersonal-Server-Key": settings.server_shared_secret.get_secret_value(),
        "Authorization": "bEaReR bad-token",
    }
    response = client.get("/api/v1/diagnostics", headers=headers)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "auth_not_configured"
    app.state.token_verifier = FakeTokenVerifier()
    response = client.get("/api/v1/diagnostics", headers=headers)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_auth_token"
