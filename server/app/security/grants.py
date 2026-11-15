"""Laptop-signed offline grants. Verification uses only the local key and SQLite."""

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sqlite3
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.config import Settings
from app.core.errors import AppError, ErrorCode
from app.security.auth import VerifiedUser, enforce_allowlist
from app.services.store import Store, audit_in, utc_now


def encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def decode(value: str) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ValueError("Invalid encoding")
    decoded = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    if encode(decoded) != value:
        raise ValueError("Noncanonical encoding")
    return decoded


def invalid_grant() -> AppError:
    return AppError(ErrorCode.invalid_auth_token, "Token is invalid.")


class GrantService:
    def __init__(
        self, settings: Settings, store: Store, clock: Callable[[], float] = time.time
    ) -> None:
        self.settings = settings
        self.store = store
        self.clock = clock
        self._key: bytes | None = None
        self._lock = asyncio.Lock()

    @property
    def key_path(self) -> Path:
        return self.settings.data_dir / "grant_signing.key"

    @property
    def kid(self) -> str:
        return hashlib.sha256(self._require_key()).hexdigest()[:8]

    def _require_key(self) -> bytes:
        if not self.settings.auth_grant_enabled or self._key is None:
            raise AppError(ErrorCode.auth_not_configured, "Offline grants are not configured.")
        return self._key

    async def initialize(self) -> None:
        if not self.settings.auth_grant_enabled:
            return

        def load() -> bytes:
            if self.settings.auth_grant_signing_key is not None:
                return self.settings.auth_grant_signing_key.get_secret_value().encode("utf-8")
            self.key_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                fd = os.open(self.key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                key = self.key_path.read_bytes()
                if len(key) != 32:
                    raise ValueError("Invalid signing key file") from None
                return key
            key = secrets.token_bytes(32)
            with os.fdopen(fd, "wb") as file:
                file.write(key)
                file.flush()
                os.fsync(file.fileno())
            return key

        try:
            self._key = await asyncio.to_thread(load)
        except (OSError, ValueError):
            # Core transcription can still use Firebase; never reveal paths or key data.
            logging.getLogger(__name__).warning(
                "Offline grants unavailable", extra={"event": "grant_not_configured"}
            )

    async def issue(self, user: VerifiedUser) -> dict[str, Any]:
        enforce_allowlist(user, self.settings)
        async with self._lock:
            key = self._require_key()
            now = int(self.clock())
            ttl = int(self.settings.auth_grant_ttl_hours * 3600)
            payload = {
                "uid": user.uid,
                "email": user.email,
                "email_verified": user.claims.get("email_verified") is True,
                "sign_in_provider": user.claims.get("firebase", {}).get("sign_in_provider"),
                "iat": now,
                "exp": now + ttl,
                "jti": uuid4().hex,
                "kid": self.kid,
            }
            body = "wpg1." + encode(
                json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
            )
            grant = body + "." + encode(hmac.digest(key, body.encode("ascii"), "sha256"))
            await self.store.audit(
                "grant_issued",
                uid=user.uid,
                detail={"grant_id": payload["jti"], "exp": payload["exp"]},
            )
            return {
                "grant": grant,
                "expires_at": payload["exp"],
                "ttl_s": ttl,
                "grant_id": payload["jti"],
            }

    async def verify(self, token: str) -> VerifiedUser:
        async with self._lock:
            key = self._require_key()
            try:
                if len(token) > 8192:
                    raise ValueError
                prefix, body, signature = token.split(".")
                if prefix != "wpg1" or not hmac.compare_digest(
                    hmac.digest(key, (prefix + "." + body).encode("ascii"), "sha256"),
                    decode(signature),
                ):
                    raise ValueError
                payload = json.loads(decode(body))
                if not isinstance(payload, dict) or set(payload) != {
                    "uid",
                    "email",
                    "email_verified",
                    "sign_in_provider",
                    "iat",
                    "exp",
                    "jti",
                    "kid",
                }:
                    raise ValueError
                if (
                    not isinstance(payload["uid"], str)
                    or not payload["uid"].strip()
                    or not isinstance(payload["jti"], str)
                    or re.fullmatch(r"[0-9a-f]{32}", payload["jti"]) is None
                    or payload["kid"] != self.kid
                    or type(payload["iat"]) is not int
                    or type(payload["exp"]) is not int
                    or payload["exp"] <= payload["iat"]
                    or type(payload["email_verified"]) is not bool
                    or (payload["email"] is not None and not isinstance(payload["email"], str))
                    or (
                        payload["sign_in_provider"] is not None
                        and not isinstance(payload["sign_in_provider"], str)
                    )
                ):
                    raise ValueError
                now = self.clock()
                skew = self.settings.firebase_clock_skew_s
                if payload["iat"] > now + skew:
                    raise ValueError
            except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
                raise invalid_grant() from None
            if payload["exp"] <= now - skew:
                raise AppError(
                    ErrorCode.auth_token_expired, "Reconnect to the internet to renew sign-in."
                )
            if await self.store.rows(
                "SELECT jti FROM revoked_grants WHERE jti=?", (payload["jti"],)
            ):
                raise invalid_grant()
            user = VerifiedUser(
                uid=payload["uid"],
                email=payload["email"],
                claims={
                    **payload,
                    "auth_method": "grant",
                    "firebase": {"sign_in_provider": payload["sign_in_provider"]},
                },
            )
            enforce_allowlist(user, self.settings)
            return user

    async def revoke(self, user: VerifiedUser, grant_id: str | None) -> str:
        self._require_key()
        enforce_allowlist(user, self.settings)
        grant_id = grant_id or (
            user.claims.get("jti") if user.claims.get("auth_method") == "grant" else None
        )
        if not isinstance(grant_id, str) or re.fullmatch(r"[0-9a-f]{32}", grant_id) is None:
            raise AppError(ErrorCode.validation_error, "A valid grant_id is required.")

        def revoke_in(conn: sqlite3.Connection) -> None:
            row = conn.execute(
                "SELECT detail_json FROM audit_log WHERE action='grant_issued' AND uid=? "
                "AND json_extract(detail_json, '$.grant_id')=? LIMIT 1",
                (user.uid, grant_id),
            ).fetchone()
            if row is None:
                raise AppError(ErrorCode.not_found, "Grant not found.")
            exp = json.loads(row["detail_json"])["exp"]
            conn.execute(
                "INSERT OR IGNORE INTO revoked_grants (jti,uid,exp,revoked_at) VALUES (?,?,?,?)",
                (grant_id, user.uid, exp, utc_now()),
            )
            audit_in(conn, "grant_revoked", uid=user.uid, detail={"grant_id": grant_id, "exp": exp})

        await self.store.transaction(revoke_in)
        return grant_id

    async def rotate_key(self, user: VerifiedUser) -> None:
        # An empty allowlist admits project users, not administrators.
        if not (self.settings.auth_allowed_uids or self.settings.auth_allowed_emails):
            raise AppError(
                ErrorCode.forbidden, "Key rotation requires an explicit owner allowlist."
            )
        enforce_allowlist(user, self.settings)
        self._require_key()
        if self.settings.auth_grant_signing_key is not None:
            raise AppError(
                ErrorCode.feature_disabled,
                "Rotate the configured signing key externally and restart the server.",
            )
        async with self._lock:
            key = secrets.token_bytes(32)

            def replace() -> None:
                temp = self.key_path.with_name("grant_signing." + uuid4().hex + ".tmp")
                try:
                    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(fd, "wb") as file:
                        file.write(key)
                        file.flush()
                        os.fsync(file.fileno())
                    os.replace(temp, self.key_path)
                finally:
                    temp.unlink(missing_ok=True)

            try:
                await asyncio.to_thread(replace)
            except OSError:
                raise AppError(ErrorCode.auth_unavailable, "Key rotation is unavailable.") from None
            self._key = key
            await self.store.audit("grant_key_rotated", uid=user.uid)


class GrantVerifier:
    def __init__(self, service: GrantService) -> None:
        self.service = service

    async def verify(self, id_token: str) -> VerifiedUser:
        return await self.service.verify(id_token)
