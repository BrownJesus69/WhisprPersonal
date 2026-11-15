import asyncio
import logging
from typing import Any
from unittest.mock import Mock

import pytest
from firebase_admin import auth
from pydantic import ValidationError

from app.core.errors import AppError, error_response
from app.security.auth import VerifiedUser, enforce_allowlist
from app.security.firebase_verifier import FirebaseTokenVerifier


def test_valid_filtered_claims(make_settings: Any, fake_firebase: Any) -> None:
    verify = Mock(
        return_value={
            "uid": "testuser",
            "email": "test@example.invalid",
            "email_verified": True,
            "auth_time": 1,
            "exp": 2,
            "iat": 1,
            "firebase": {"sign_in_provider": "custom", "identities": {"private": "hidden"}},
            "private": "hidden",
        }
    )
    settings = make_settings(firebase_check_revoked=True, firebase_clock_skew_s=12)
    user = asyncio.run(
        FirebaseTokenVerifier(fake_firebase, settings, verify).verify("fixture-token")
    )
    assert user.uid == "testuser"
    assert user.email == "test@example.invalid"
    assert "private" not in user.claims
    assert user.claims["firebase"] == {"sign_in_provider": "custom"}
    verify.assert_called_once_with(
        "fixture-token", app=fake_firebase.app, check_revoked=True, clock_skew_seconds=12
    )


@pytest.mark.parametrize(
    ("exception", "code", "status"),
    [
        (auth.ExpiredIdTokenError("sensitive", None), "auth_token_expired", 401),
        (auth.RevokedIdTokenError("sensitive"), "invalid_auth_token", 401),
        (auth.UserDisabledError("sensitive"), "account_not_allowed", 403),
        (auth.InvalidIdTokenError("sensitive"), "invalid_auth_token", 401),
        (auth.CertificateFetchError("sensitive", None), "auth_unavailable", 503),
        (ValueError("sensitive"), "invalid_auth_token", 401),
        (RuntimeError("sensitive"), "auth_unavailable", 503),
    ],
)
def test_exception_mapping(
    make_settings: Any,
    fake_firebase: Any,
    caplog: Any,
    exception: Exception,
    code: str,
    status: int,
) -> None:
    token = "private-token-canary"  # noqa: S105 -- deliberate leak-detection fixture
    verify = Mock(side_effect=exception)
    with caplog.at_level(logging.WARNING), pytest.raises(AppError) as caught:
        asyncio.run(FirebaseTokenVerifier(fake_firebase, make_settings(), verify).verify(token))
    assert (caught.value.code, caught.value.status_code) == (code, status)
    output = error_response(caught.value).body.decode() + caplog.text
    assert token not in output and "sensitive" not in output


@pytest.mark.parametrize("token", ["a" * 8193, "a b", "a\tb", "a\nb", ""])
def test_invalid_before_sdk(make_settings: Any, fake_firebase: Any, token: str) -> None:
    verify = Mock()
    with pytest.raises(AppError) as caught:
        asyncio.run(FirebaseTokenVerifier(fake_firebase, make_settings(), verify).verify(token))
    assert caught.value.code == "invalid_auth_token"
    verify.assert_not_called()


@pytest.mark.parametrize("claims", [{}, {"uid": ""}, {"uid": None}, {"uid": " "}])
def test_missing_uid(make_settings: Any, fake_firebase: Any, claims: dict[str, Any]) -> None:
    with pytest.raises(AppError) as caught:
        asyncio.run(
            FirebaseTokenVerifier(fake_firebase, make_settings(), Mock(return_value=claims)).verify(
                "fixture"
            )
        )
    assert caught.value.code == "invalid_auth_token"


@pytest.mark.parametrize(
    ("uids", "emails", "verified", "allowed"),
    [
        (["testuser"], [], False, True),
        ([], ["TEST@EXAMPLE.INVALID"], True, True),
        ([], ["test@example.invalid"], False, False),
        (["another"], [], True, False),
        ([], [], False, True),
    ],
)
def test_allowlist(
    make_settings: Any, uids: list[str], emails: list[str], verified: bool, allowed: bool
) -> None:
    settings = make_settings(auth_allowed_uids=uids, auth_allowed_emails=emails)
    user = VerifiedUser("testuser", "TEST@example.invalid", {"email_verified": verified})
    if allowed:
        enforce_allowlist(user, settings)
    else:
        with pytest.raises(AppError) as caught:
            enforce_allowlist(user, settings)
        assert caught.value.code == "account_not_allowed"
        assert caught.value.status_code == 403
    summary = settings.safe_summary()
    assert summary["auth_allowed_uids_count"] == len(uids)
    assert "auth_allowed_uids" not in summary and "auth_allowed_emails" not in summary


def test_allowlist_config(make_settings: Any) -> None:
    settings = make_settings(
        auth_allowed_uids="testuser, another", auth_allowed_emails="TEST@EXAMPLE.INVALID"
    )
    assert settings.auth_allowed_uids == ["testuser", "another"]
    assert settings.auth_allowed_emails == ["test@example.invalid"]
    for uid in ("bad-uid", "a/b", "a" * 129):
        with pytest.raises(ValidationError):
            make_settings(auth_allowed_uids=[uid])
