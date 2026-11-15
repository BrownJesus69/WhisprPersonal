"""Firebase ID token verification off the event loop, with safe error mapping."""

import asyncio
import logging
from collections.abc import Callable, Mapping
from typing import Any

from firebase_admin import auth

from app.config import Settings
from app.core.errors import AppError, ErrorCode
from app.security.auth import VerifiedUser, enforce_allowlist
from app.services.firebase import FirebaseService


class FirebaseTokenVerifier:
    def __init__(
        self,
        service: FirebaseService,
        settings: Settings,
        verify_fn: Callable[..., Mapping[str, Any]] | None = None,
    ) -> None:
        self.service = service
        self.settings = settings
        self.verify_fn = verify_fn if verify_fn is not None else auth.verify_id_token

    async def verify(self, id_token: str) -> VerifiedUser:
        if not id_token or len(id_token) > 8192 or any(c.isspace() for c in id_token):
            raise AppError(ErrorCode.invalid_auth_token, "Token is invalid.")
        app = self.service.app
        try:
            claims = await asyncio.to_thread(
                self.verify_fn,
                id_token,
                app=app,
                check_revoked=self.settings.firebase_check_revoked,
                clock_skew_seconds=self.settings.firebase_clock_skew_s,
            )
        except auth.ExpiredIdTokenError:
            raise AppError(
                ErrorCode.auth_token_expired, "Token expired. Refresh and retry once."
            ) from None
        except auth.RevokedIdTokenError:
            raise AppError(
                ErrorCode.invalid_auth_token, "Sign-in was revoked. Sign in again."
            ) from None
        except auth.UserDisabledError:
            raise AppError(ErrorCode.account_not_allowed, "Account is not allowed.") from None
        except auth.InvalidIdTokenError:
            raise AppError(ErrorCode.invalid_auth_token, "Token is invalid.") from None
        except auth.CertificateFetchError:
            raise AppError(
                ErrorCode.auth_unavailable, "Token verification is unavailable."
            ) from None
        except ValueError:
            raise AppError(ErrorCode.invalid_auth_token, "Token is invalid.") from None
        except Exception as exc:
            logging.getLogger(__name__).warning(
                "Token verification failed",
                extra={"event": "auth_verify_error", "exc_type": type(exc).__name__},
            )
            raise AppError(
                ErrorCode.auth_unavailable, "Token verification is unavailable."
            ) from None
        uid = claims.get("uid")
        if not isinstance(uid, str) or not uid.strip():
            raise AppError(ErrorCode.invalid_auth_token, "Token is invalid.")
        filtered = {
            key: claims[key]
            for key in ("uid", "email", "email_verified", "auth_time", "exp", "iat")
            if key in claims
        }
        firebase = claims.get("firebase")
        if isinstance(firebase, Mapping) and "sign_in_provider" in firebase:
            filtered["firebase"] = {"sign_in_provider": firebase["sign_in_provider"]}
        email = claims.get("email")
        user = VerifiedUser(
            uid=uid, email=email if isinstance(email, str) else None, claims=filtered
        )
        enforce_allowlist(user, self.settings)
        return user
