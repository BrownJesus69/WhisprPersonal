from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.tests.conftest import FakeTokenVerifier


def test_missing_and_wrong(client: TestClient) -> None:
    for headers, code in (
        ({}, "missing_server_key"),
        ({"X-EventScribe-Server-Key": "wrong"}, "invalid_server_key"),
    ):
        response = client.get("/api/v1/diagnostics", headers=headers)
        assert response.status_code == 401
        assert response.json()["error"]["code"] == code


def test_unset(make_settings: Any) -> None:
    with TestClient(
        create_app(make_settings(server_shared_secret=None)), client=("127.0.0.1", 1)
    ) as client:
        response = client.get("/api/v1/diagnostics")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "server_not_configured"


def test_diagnostics(app: FastAPI, client: TestClient, settings: Settings) -> None:
    app.state.token_verifier = FakeTokenVerifier()
    secret = settings.server_shared_secret.get_secret_value()
    response = client.get(
        "/api/v1/diagnostics",
        headers={
            "X-EventScribe-Server-Key": secret,
            "Authorization": "Bearer good-token",
        },
    )
    assert response.status_code == 200
    assert "python_version" in response.json()
    assert "limits" in response.json()
    assert secret not in response.text
    assert str(settings.data_dir) not in response.text
