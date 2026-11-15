from typing import Any

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.main import create_app
from app.security.rate_limit import TokenBucketLimiter, per_user_rate_limit
from app.tests.conftest import FakeTokenVerifier


def test_bucket() -> None:
    now = [0.0]
    limiter = TokenBucketLimiter(2, max_keys=2, clock=lambda: now[0])
    assert limiter.check("a").allowed
    assert limiter.check("a").allowed
    assert not limiter.check("a").allowed
    assert limiter.check("a").retry_after_s == 30
    now[0] = 30
    assert limiter.check("a").allowed
    limiter.check("b")
    limiter.check("a")  # a is now most recently seen
    limiter.check("c")
    assert limiter.key_count == 2
    assert list(limiter._buckets) == ["a", "c"]


def test_per_ip(make_settings: Any) -> None:
    with TestClient(
        create_app(make_settings(rate_limit_per_ip_per_minute=2)), client=("127.0.0.1", 1)
    ) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/health").status_code == 200
        response = client.get("/health")
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "rate_limited"
    assert int(response.headers["retry-after"]) >= 1


def test_global_limit(make_settings: Any) -> None:
    with TestClient(
        create_app(make_settings(rate_limit_global_per_minute=1)), client=("127.0.0.1", 1)
    ) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/health").json()["error"]["code"] == "rate_limited"


def test_verified_user_limit(make_settings: Any) -> None:
    settings = make_settings(rate_limit_per_user_per_minute=1)
    app: FastAPI = create_app(settings)

    @app.get("/user", dependencies=[Depends(per_user_rate_limit)])
    async def user_route() -> dict[str, bool]:
        return {"ok": True}

    with TestClient(app, client=("127.0.0.1", 1)) as client:
        app.state.token_verifier = FakeTokenVerifier()
        headers = {
            "Authorization": "Bearer good-token",
            "X-WhisprPersonal-Server-Key": settings.server_shared_secret.get_secret_value(),
        }
        assert client.get("/user", headers=headers).status_code == 200
        assert client.get("/user", headers=headers).status_code == 429
