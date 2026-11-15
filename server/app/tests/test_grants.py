"""Local grants exercised with the autouse network prohibition and fake Firebase."""

import asyncio
import hmac
import json
import logging
import os
import secrets
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.core.logging import RedactingFilter, StructuredFormatter
from app.main import create_app
from app.security.auth import DisabledTokenVerifier, VerifiedUser
from app.security.firebase_verifier import FirebaseTokenVerifier
from app.security.grants import GrantService, decode, encode
from app.services.store import Store
from app.tests.fakes import create_session


def issue(client: TestClient) -> dict[str, Any]:
    response = client.post("/api/v1/auth/grant")
    assert response.status_code == 200, response.text
    return response.json()


def test_issue_round_trip_and_no_renewal(phase3_client: Any) -> None:
    client = phase3_client
    data = issue(client)
    assert data["ttl_s"] == 12 * 3600
    _, body, _ = data["grant"].split(".")
    payload = json.loads(decode(body))
    assert payload["exp"] - payload["iat"] == data["ttl_s"]
    assert payload["jti"] == data["grant_id"]
    assert decode(body) == json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    assert client.get("/api/v1/auth/check").json()["auth_method"] == "firebase"
    assert client.get("/api/v1/auth/check").json()["grant_expires_at"] is None
    client.headers["Authorization"] = "Bearer " + data["grant"]
    client.app.state.token_verifier = DisabledTokenVerifier()
    response = client.get("/api/v1/auth/check")
    assert response.status_code == 200
    assert response.json()["auth_method"] == "grant"
    assert response.json()["grant_expires_at"] == data["expires_at"]
    response = client.post("/api/v1/auth/grant")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_auth_token"
    assert response.json()["error"]["message"] == "A Firebase sign-in is required to issue a grant."
    response = client.post("/api/v1/auth/grant", headers={"X-WhisprPersonal-Server-Key": ""})
    assert response.json()["error"]["code"] == "missing_server_key"


def test_firebase_issue_once_and_claims(make_settings: Any, fake_firebase: Any) -> None:
    settings = make_settings(auth_allowed_emails=["owner@example.invalid"])
    verify = Mock(
        return_value={
            "uid": "owner",
            "email": "OWNER@example.invalid",
            "email_verified": True,
            "firebase": {"sign_in_provider": "google.com"},
        }
    )
    app = create_app(
        settings, fake_firebase, FirebaseTokenVerifier(fake_firebase, settings, verify)
    )
    with TestClient(app, client=("127.0.0.1", 1)) as client:
        client.headers.update(
            {
                "X-WhisprPersonal-Server-Key": settings.server_shared_secret.get_secret_value(),
                "Authorization": "Bearer fixture-token",
            }
        )
        data = issue(client)
        assert verify.call_count == 1
        client.headers["Authorization"] = "Bearer " + data["grant"]
        check = client.get("/api/v1/auth/check").json()
        assert check["email_verified"] is True
        assert check["sign_in_provider"] == "google.com"
        assert verify.call_count == 1
        settings.auth_allowed_emails = ["other@example.invalid"]
        assert client.get("/api/v1/auth/check").status_code == 403


@pytest.mark.parametrize("kind", ["payload", "signature", "parts", "encoding", "oversize"])
def test_tampering(phase3_client: Any, kind: str) -> None:
    client = phase3_client
    data = issue(client)
    prefix, body, signature = data["grant"].split(".")
    if kind == "payload":
        payload = json.loads(decode(body))
        payload["uid"] = "attacker"
        body = encode(json.dumps(payload).encode())
    elif kind == "signature":
        signature = encode(bytes(32))
    elif kind == "parts":
        signature += ".extra"
    elif kind == "encoding":
        signature = "%%%"
    else:
        body = "a" * 8192
    response = client.get(
        "/api/v1/auth/check", headers={"Authorization": f"Bearer {prefix}.{body}.{signature}"}
    )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_auth_token"
    assert data["grant"] not in response.text


@pytest.mark.parametrize("kind", ["expired", "future", "wrong_kid", "invalid_claims"])
def test_signed_invalid_claims(phase3_client: Any, kind: str) -> None:
    client = phase3_client
    service = client.app.state.grant_service
    service.clock = lambda: 100_000
    data = issue(client)
    payload = json.loads(decode(data["grant"].split(".")[1]))
    if kind == "expired":
        service.clock = lambda: data["expires_at"] + 5
        token = data["grant"]
    else:
        if kind == "future":
            payload["iat"] += 6
        elif kind == "wrong_kid":
            payload["kid"] = "wrong"
        else:
            payload["exp"] = True
        body = "wpg1." + encode(json.dumps(payload).encode())
        # Sign with this test's generated local key to isolate semantic verification.
        token = (
            body + "." + encode(hmac.digest(service.key_path.read_bytes(), body.encode(), "sha256"))
        )
    response = client.get("/api/v1/auth/check", headers={"Authorization": "Bearer " + token})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == (
        "auth_token_expired" if kind == "expired" else "invalid_auth_token"
    )


def test_revoke_self_and_by_id_and_ownership(phase3_client: Any) -> None:
    client = phase3_client
    first, second = issue(client), issue(client)
    firebase_header = client.headers["Authorization"]
    client.headers["Authorization"] = "Bearer " + first["grant"]
    assert client.post("/api/v1/auth/grant/revoke").json()["revoked"] is True
    assert client.get("/api/v1/auth/check").json()["error"]["code"] == "invalid_auth_token"
    client.headers["Authorization"] = firebase_header
    assert client.post("/api/v1/auth/grant/revoke").status_code == 422
    assert (
        client.post("/api/v1/auth/grant/revoke", json={"grant_id": second["grant_id"]}).status_code
        == 200
    )
    assert client.post("/api/v1/auth/grant/revoke", json={"grant_id": "a" * 32}).status_code == 404

    class OtherUser:
        async def verify(self, id_token: str) -> VerifiedUser:
            return VerifiedUser("other", None, {})

    client.app.state.token_verifier = OtherUser()
    assert (
        client.post("/api/v1/auth/grant/revoke", json={"grant_id": second["grant_id"]}).status_code
        == 404
    )


def test_allowlist_rechecked_on_issue_and_verify(phase3_client: Any) -> None:
    client = phase3_client
    data = issue(client)
    client.app.state.settings.auth_allowed_uids = ["other"]
    assert client.post("/api/v1/auth/grant").status_code == 403
    assert (
        client.get(
            "/api/v1/auth/check", headers={"Authorization": "Bearer " + data["grant"]}
        ).status_code
        == 403
    )


def test_rotation_invalidates_and_persists(phase3_client: Any) -> None:
    client = phase3_client
    service = client.app.state.grant_service
    first = issue(client)
    old_kid = service.kid
    assert client.post("/api/v1/auth/grants/rotate-key").status_code == 403
    # Fixture uid contains a hyphen; use a verified email for the owner allowlist.
    service.settings.auth_allowed_emails = ["owner@example.invalid"]

    class Owner:
        async def verify(self, id_token: str) -> VerifiedUser:
            return VerifiedUser("user-1", "owner@example.invalid", {"email_verified": True})

    client.app.state.token_verifier = Owner()
    assert client.post("/api/v1/auth/grants/rotate-key").json() == {"rotated": True}
    assert service.kid != old_kid
    assert (
        client.get(
            "/api/v1/auth/check", headers={"Authorization": "Bearer " + first["grant"]}
        ).status_code
        == 401
    )
    second = issue(client)
    reloaded = GrantService(service.settings, service.store)
    client.portal.call(reloaded.initialize)
    assert reloaded.kid == service.kid
    assert client.portal.call(reloaded.verify, second["grant"]).uid == "user-1"
    actions = client.portal.call(service.store.rows, "SELECT action FROM audit_log")
    assert {row["action"] for row in actions} >= {"grant_issued", "grant_key_rotated"}


def test_offline_restart_reuses_key_and_revocations(phase3_client: Any) -> None:
    client = phase3_client
    data, revoked = issue(client), issue(client)
    client.post("/api/v1/auth/grant/revoke", json={"grant_id": revoked["grant_id"]})
    settings = client.app.state.settings
    key_path = settings.data_dir / "grant_signing.key"
    stamp = key_path.stat().st_mtime_ns
    with TestClient(create_app(settings), client=("127.0.0.1", 1)) as restarted:
        headers = {
            "Authorization": "Bearer " + data["grant"],
            "X-WhisprPersonal-Server-Key": settings.server_shared_secret.get_secret_value(),
        }
        assert restarted.get("/api/v1/auth/check", headers=headers).status_code == 200
        headers["Authorization"] = "Bearer " + revoked["grant"]
        assert restarted.get("/api/v1/auth/check", headers=headers).status_code == 401
    assert key_path.stat().st_mtime_ns == stamp
    if os.name != "nt":
        assert key_path.stat().st_mode & 0o777 == 0o600


def test_disabled_grants_and_rate_limit(phase3_client: Any) -> None:
    from app.security.rate_limit import TokenBucketLimiter

    client = phase3_client
    data = issue(client)
    client.app.state.settings.auth_grant_enabled = False
    assert client.post("/api/v1/auth/grant").status_code == 503
    assert (
        client.get(
            "/api/v1/auth/check", headers={"Authorization": "Bearer " + data["grant"]}
        ).status_code
        == 503
    )
    assert client.get("/api/v1/auth/check").status_code == 200
    client.app.state.settings.auth_grant_enabled = True
    client.app.state.user_limiter = TokenBucketLimiter(1)
    assert client.post("/api/v1/auth/grant").status_code == 200
    assert client.post("/api/v1/auth/grant").status_code == 429


@pytest.mark.parametrize("ttl", [0.99, 24.01, float("nan"), float("inf")])
def test_ttl_bounds(make_settings: Any, ttl: float) -> None:
    with pytest.raises(ValidationError):
        make_settings(auth_grant_ttl_hours=ttl)


@pytest.mark.parametrize("ttl", [1, 12, 24])
def test_ttl_valid(make_settings: Any, ttl: float) -> None:
    assert make_settings(auth_grant_ttl_hours=ttl).auth_grant_ttl_hours == ttl


def test_environment_key_and_redaction(make_settings: Any, capsys: Any) -> None:
    key = secrets.token_urlsafe(36)
    settings = make_settings(auth_grant_signing_key=key, auth_allowed_uids=["owner"])

    class Owner:
        async def verify(self, id_token: str) -> VerifiedUser:
            return VerifiedUser("owner", None, {})

    with TestClient(
        create_app(settings, token_verifier=Owner()), client=("127.0.0.1", 1)
    ) as client:
        client.headers.update(
            {
                "X-WhisprPersonal-Server-Key": settings.server_shared_secret.get_secret_value(),
                "Authorization": "Bearer fixture-token",
            }
        )
        data = issue(client)
        assert not (settings.data_dir / "grant_signing.key").exists()
        assert key not in str(data)
        response = client.post("/api/v1/auth/grants/rotate-key")
        assert response.status_code == 503
        for path in ("/health", "/api/v1/diagnostics", "/api/v1/auth/check"):
            response = client.get(path)
            assert key not in response.text and data["grant"] not in response.text
        assert client.get("/health").json()["auth"]["grants"] == {"enabled": True, "ttl_hours": 12}
        logging.getLogger(__name__).info(
            "test %s", data["grant"], extra={"nested": {"token": data["grant"], "key": key}}
        )
        audit = client.portal.call(client.app.state.store.rows, "SELECT * FROM audit_log")
        assert key not in str(audit) and data["grant"] not in str(audit)
    output = capsys.readouterr().out
    assert key not in output and data["grant"] not in output
    assert key not in repr(settings) and key not in str(settings.safe_summary())
    record = logging.makeLogRecord(
        {"msg": "unlabelled " + data["grant"], "nested": {"grant": data["grant"]}}
    )
    assert data["grant"] not in StructuredFormatter(RedactingFilter()).format(record)
    with pytest.raises(ValidationError):
        make_settings(auth_grant_signing_key="short")
    assert make_settings(auth_grant_signing_key="").auth_grant_signing_key is None


def test_stream_accepts_grant(phase3_client: Any) -> None:
    client = phase3_client
    create_session(client)
    data = issue(client)
    client.app.state.token_verifier = DisabledTokenVerifier()
    with client.websocket_connect(
        "/api/v1/sessions/session1/stream", headers={"Authorization": "Bearer " + data["grant"]}
    ) as ws:
        assert ws.receive_json()["type"] == "hello"


def test_prune_expired_revocations(tmp_path: Path) -> None:
    async def check() -> None:
        store = Store(tmp_path)
        await store.open()
        await store.execute("INSERT INTO revoked_grants VALUES ('old', 'owner', 1, 'ts')")
        await store.execute("INSERT INTO revoked_grants VALUES ('live', 'owner', 9999999999, 'ts')")
        await store.close()
        await store.open()
        assert [row["jti"] for row in await store.rows("SELECT jti FROM revoked_grants")] == [
            "live"
        ]
        await store.close()

    asyncio.run(check())


def test_invalid_key_fails_closed_without_blocking_firebase(phase3_client: Any) -> None:
    from app.security.grants import GrantVerifier

    client = phase3_client
    data = issue(client)
    state = client.app.state
    # Only damage this test's generated key, never any operator credentials.
    state.grant_service.key_path.write_bytes(b"invalid")
    service = GrantService(state.settings, state.store)
    client.portal.call(service.initialize)
    state.grant_service = service
    state.grant_verifier = GrantVerifier(service)
    assert client.post("/api/v1/auth/grant").json()["error"]["code"] == "auth_not_configured"
    response = client.get(
        "/api/v1/auth/check", headers={"Authorization": "Bearer " + data["grant"]}
    )
    assert response.status_code == 503
    assert client.get("/api/v1/auth/check").status_code == 200


def test_revocation_retained_through_skew_on_restart(phase3_client: Any) -> None:
    client = phase3_client
    state = client.app.state
    data = issue(client)
    client.post("/api/v1/auth/grant/revoke", json={"grant_id": data["grant_id"]})
    # A row whose exp has just passed must survive pruning: verification allows skew.
    import time

    client.portal.call(
        state.store.execute, "UPDATE revoked_grants SET exp=?", (int(time.time()) - 1,)
    )
    with TestClient(create_app(state.settings), client=("127.0.0.1", 1)) as restarted:
        response = restarted.get(
            "/api/v1/auth/check",
            headers={
                "Authorization": "Bearer " + data["grant"],
                "X-WhisprPersonal-Server-Key": (
                    state.settings.server_shared_secret.get_secret_value()
                ),
            },
        )
        assert response.status_code == 401


def test_clock_skew_boundary(phase3_client: Any) -> None:
    client = phase3_client
    service = client.app.state.grant_service
    service.clock = lambda: 100_000
    data = issue(client)
    headers = {"Authorization": "Bearer " + data["grant"]}
    service.clock = lambda: 99_995
    assert client.get("/api/v1/auth/check", headers=headers).status_code == 200
    service.clock = lambda: 99_994
    assert client.get("/api/v1/auth/check", headers=headers).status_code == 401
    service.clock = lambda: data["expires_at"] + 4
    assert client.get("/api/v1/auth/check", headers=headers).status_code == 200
    service.clock = lambda: data["expires_at"] + 5
    assert (
        client.get("/api/v1/auth/check", headers=headers).json()["error"]["code"]
        == "auth_token_expired"
    )
