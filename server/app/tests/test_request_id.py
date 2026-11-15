import re

from fastapi.testclient import TestClient


def test_valid_request_id(client: TestClient) -> None:
    assert (
        client.get("/health", headers={"X-Request-ID": "client-id-123"}).headers["x-request-id"]
        == "client-id-123"
    )


def test_invalid_request_id(client: TestClient) -> None:
    value = client.get("/health", headers={"X-Request-ID": "bad id!"}).headers["x-request-id"]
    assert re.fullmatch(r"[a-f0-9]{32}", value)
