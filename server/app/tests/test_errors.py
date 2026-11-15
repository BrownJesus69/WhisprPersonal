from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel


class Payload(BaseModel):
    number: int


def test_not_found(client: TestClient) -> None:
    response = client.get("/unknown")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert response.json()["error"]["request_id"] == response.headers["x-request-id"]
    response = client.post("/health")
    assert response.status_code == 405
    assert response.json()["error"]["code"] == "method_not_allowed"


def test_validation(app: FastAPI, client: TestClient) -> None:
    @app.post("/validate")
    async def validate(payload: Payload) -> Payload:
        return payload

    response = client.post("/validate", json={"number": "private-input"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert "private-input" not in response.text
    assert all(set(d) == {"loc", "msg", "type"} for d in response.json()["error"]["details"])


def test_unhandled(app: FastAPI) -> None:
    @app.get("/api/v1/crash")
    async def crash() -> None:
        raise RuntimeError("secret-ish detail")

    with TestClient(app, client=("127.0.0.1", 1), raise_server_exceptions=False) as client:
        response = client.get("/api/v1/crash")
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"
    assert response.json()["error"]["request_id"] == response.headers["x-request-id"]
    assert response.headers["cache-control"] == "no-store"
    assert "Traceback" not in response.text
    assert "secret-ish detail" not in response.text
