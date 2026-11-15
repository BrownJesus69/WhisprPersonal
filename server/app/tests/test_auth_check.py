from typing import Any
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from firebase_admin import auth

from app.main import create_app
from app.security.firebase_verifier import FirebaseTokenVerifier


def test_auth_order_and_one_verification(make_settings: Any, fake_firebase: Any) -> None:
    settings = make_settings(rate_limit_per_user_per_minute=2)
    verify = Mock(
        return_value={
            "uid": "testuser",
            "email_verified": True,
            "firebase": {"sign_in_provider": "custom"},
        }
    )
    verifier = FirebaseTokenVerifier(fake_firebase, settings, verify)
    app = create_app(settings, firebase_service=fake_firebase, token_verifier=verifier)
    headers = {"Authorization": "Bearer fixture-token"}
    with TestClient(app, client=("127.0.0.1", 1)) as client:
        response = client.get("/api/v1/auth/check", headers=headers)
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "missing_server_key"
        verify.assert_not_called()
        headers["X-WhisprPersonal-Server-Key"] = settings.server_shared_secret.get_secret_value()
        response = client.get("/api/v1/auth/check", headers=headers)
        assert response.status_code == 200
        assert response.json()["uid"] == "testuser"
        assert response.json()["sign_in_provider"] == "custom"
        assert response.json()["email_verified"] is True
        assert verify.call_count == 1
        assert client.get("/api/v1/diagnostics", headers=headers).status_code == 200
        assert verify.call_count == 2
        assert client.get("/api/v1/auth/check", headers=headers).status_code == 429
        assert verify.call_count == 3


def test_expired(make_settings: Any, fake_firebase: Any) -> None:
    settings = make_settings()
    verify = Mock(side_effect=auth.ExpiredIdTokenError("fixture-token", None))
    app = create_app(
        settings, fake_firebase, FirebaseTokenVerifier(fake_firebase, settings, verify)
    )
    with TestClient(app, client=("127.0.0.1", 1)) as client:
        response = client.get(
            "/api/v1/auth/check",
            headers={
                "Authorization": "Bearer fixture-token",
                "X-WhisprPersonal-Server-Key": settings.server_shared_secret.get_secret_value(),
            },
        )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "auth_token_expired"
    assert "fixture-token" not in response.text


def test_no_credentials(client: TestClient, settings: Any) -> None:
    response = client.get(
        "/api/v1/auth/check",
        headers={
            "Authorization": "Bearer fixture-token",
            "X-WhisprPersonal-Server-Key": settings.server_shared_secret.get_secret_value(),
        },
    )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "auth_not_configured"


@pytest.mark.parametrize("email_verified", [True, False])
def test_allowlist_after_verification(
    make_settings: Any, fake_firebase: Any, email_verified: bool
) -> None:
    settings = make_settings(auth_allowed_emails=["allowed@example.invalid"])
    verify = Mock(
        return_value={
            "uid": "testuser",
            "email": "ALLOWED@example.invalid",
            "email_verified": email_verified,
        }
    )
    app = create_app(
        settings, fake_firebase, FirebaseTokenVerifier(fake_firebase, settings, verify)
    )
    with TestClient(app, client=("127.0.0.1", 1)) as client:
        response = client.get(
            "/api/v1/auth/check",
            headers={
                "Authorization": "Bearer fixture-token",
                "X-WhisprPersonal-Server-Key": settings.server_shared_secret.get_secret_value(),
            },
        )
    assert response.status_code == (200 if email_verified else 403)
    if not email_verified:
        assert response.json()["error"]["code"] == "account_not_allowed"
    assert verify.call_count == 1
