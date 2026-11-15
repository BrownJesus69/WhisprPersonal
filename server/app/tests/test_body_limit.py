from typing import Any

from fastapi import Request
from fastapi.testclient import TestClient

from app.main import create_app


def test_limits(make_settings: Any) -> None:
    app = create_app(make_settings(max_json_body_bytes=10, max_chunk_upload_bytes=100))

    @app.post("/api/v1/sessions/abc/chunks")
    @app.post("/body")
    async def body(request: Request) -> dict[str, int]:
        return {"size": len(await request.body())}

    # Exercise middleware in isolation before the included Phase 3 session router.
    app.router.routes[:] = app.router.routes[-2:] + app.router.routes[:-2]

    with TestClient(app, client=("127.0.0.1", 1)) as client:
        response = client.post("/body", content=b"x" * 20)
        assert response.status_code == 413
        assert response.json()["error"]["code"] == "payload_too_large"
        assert client.post("/api/v1/sessions/abc/chunks", content=b"x" * 20).status_code == 200
        response = client.post("/body", content=iter([b"x" * 6, b"x" * 6]))
        assert response.status_code == 413
        assert response.json()["error"]["code"] == "payload_too_large"
