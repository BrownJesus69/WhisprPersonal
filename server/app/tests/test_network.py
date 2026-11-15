import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


@pytest.mark.parametrize(
    "host,status",
    [
        ("8.8.8.8", 403),
        ("100.101.1.2", 200),
        ("testclient", 403),
        ("::1", 200),
        ("::ffff:192.168.1.20", 200),
        ("::ffff:8.8.8.8", 403),
    ],
)
def test_network(app: FastAPI, host: str, status: int) -> None:
    with TestClient(app, client=(host, 1)) as client:
        response = client.get("/health", headers={"X-Forwarded-For": "127.0.0.1"})
    assert response.status_code == status
    if status == 403:
        assert response.json()["error"]["code"] == "network_not_allowed"


def test_websocket_denied(app: FastAPI) -> None:
    @app.websocket("/ws")
    async def ws(socket: WebSocket) -> None:
        await socket.accept()
        await socket.close()

    with TestClient(app, client=("8.8.8.8", 1)) as client:
        with pytest.raises(WebSocketDisconnect) as error, client.websocket_connect("/ws"):
            pass
    assert error.value.code == 1008
