from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.cli import main


def test_qr(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["qr", "http://127.0.0.1:8000"]) == 0
    assert "http://127.0.0.1:8000" in capsys.readouterr().out
    for url in ("http://u:p@host", "http://host?x=1", "http://host/#fragment"):
        with pytest.raises(SystemExit) as error:
            main(["qr", url])
        assert error.value.code == 2


def test_selftest(client: TestClient, capsys: pytest.CaptureFixture[str]) -> None:
    payload = client.get("/health").json()

    def response(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/health"
        return httpx.Response(200, json=payload)

    assert main(["selftest"], transport=httpx.MockTransport(response)) == 0
    assert "PASS" in capsys.readouterr().out


@pytest.mark.parametrize("invalid", [True, False])
def test_selftest_failure(invalid: bool) -> None:
    def response(request: httpx.Request) -> httpx.Response:
        if invalid:
            return httpx.Response(200, text="invalid json")
        raise httpx.ConnectError("offline", request=request)

    assert main(["selftest"], transport=httpx.MockTransport(response)) == 1


def test_docs_disabled(make_settings: Any) -> None:
    from app.main import create_app

    with TestClient(
        create_app(make_settings(enable_api_docs=False)), client=("127.0.0.1", 1)
    ) as client:
        assert client.get("/docs").status_code == 404
        assert client.get("/openapi.json").status_code == 404
