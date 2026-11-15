"""Admin SDK bypasses rules: enforce ownership before accessing event resources."""

import asyncio
import time
from dataclasses import dataclass
from typing import Any, Protocol

from fastapi import Request
from google.api_core.exceptions import GoogleAPICallError, RetryError
from google.auth.exceptions import GoogleAuthError

from app.core.errors import AppError, ErrorCode
from app.models.ids import validate_doc_id
from app.security.auth import VerifiedUser
from app.services.firebase import FirebaseService
from app.services.store import utc_now


@dataclass(frozen=True)
class EventAccess:
    owner_uid: str
    privacy_mode: str | None


class EventOwnershipRepository(Protocol):
    async def get_event_owner(self, event_id: str) -> str | None: ...

    async def get_event_access(self, event_id: str) -> EventAccess | None: ...


class DisabledEventRepository:
    async def get_event_access(self, event_id: str) -> EventAccess | None:
        return None

    async def get_event_owner(self, event_id: str) -> str | None:
        raise AppError(ErrorCode.auth_not_configured, "Firebase is not configured.")


class FirestoreEventRepository:
    def __init__(self, service: FirebaseService, timeout_s: float = 10.0) -> None:
        self.service = service
        # Offline laptop: without a bound the Firestore client retries for minutes.
        self.timeout_s = timeout_s
        # After a failure, fail fast for a while instead of paying the full timeout on every
        # request (measured: 10.0 s per session start offline without this).
        self.fail_fast_s = 30.0
        self._down_until = 0.0

    async def get_event_owner(self, event_id: str) -> str | None:
        access = await self._fetch_access(event_id, ["ownerId"])
        return access.owner_uid if access else None

    async def get_event_access(self, event_id: str) -> EventAccess | None:
        return await self._fetch_access(event_id, ["ownerId", "privacyMode"])

    async def _fetch_access(self, event_id: str, fields: list[str]) -> EventAccess | None:
        validate_doc_id(event_id, "event_id")

        def fetch() -> EventAccess | None:
            snapshot = (
                self.service.firestore()
                .collection("events")
                .document(event_id)
                .get(field_paths=fields)
            )
            data = snapshot.to_dict() if snapshot.exists else None
            owner = data.get("ownerId") if data else None
            mode = data.get("privacyMode") if data else None
            return (
                EventAccess(owner, mode if isinstance(mode, str) else None)
                if isinstance(owner, str)
                else None
            )

        unavailable = AppError(ErrorCode.firestore_unavailable, "Event storage is unavailable.")
        if time.monotonic() < self._down_until:
            raise unavailable
        try:
            owner = await asyncio.wait_for(asyncio.to_thread(fetch), timeout=self.timeout_s)
        # GoogleAuthError covers TransportError/RefreshError raised when the laptop is offline
        # and the service-account access token cannot be refreshed.
        except (GoogleAPICallError, RetryError, GoogleAuthError, TimeoutError, OSError):
            self._down_until = time.monotonic() + self.fail_fast_s
            raise unavailable from None
        self._down_until = 0.0
        return owner


async def require_event_owner(
    event_id: str, user: VerifiedUser, repo: EventOwnershipRepository
) -> None:
    validate_doc_id(event_id, "event_id")
    require_owner(await repo.get_event_owner(event_id), user)


async def check_event_owner_offline_tolerant(
    event_id: str, user: VerifiedUser, repo: EventOwnershipRepository, store: Any
) -> bool:
    """Verify event ownership, tolerating an unreachable Firestore.

    Returns True when ownership is verified now (and caches it) or from a previous online
    verification; False when Firestore is unreachable and the event was never verified on this
    laptop. Raises 404 when Firestore (or the cache) says the event belongs to someone else.
    Callers given False must keep the resulting data local until verified online.
    """
    validate_doc_id(event_id, "event_id")
    try:
        owner = await repo.get_event_owner(event_id)
    except AppError as exc:
        if exc.code != ErrorCode.firestore_unavailable:
            raise
        rows = await store.rows("SELECT owner_uid FROM event_owners WHERE event_id=?", (event_id,))
        if rows:
            require_owner(rows[0]["owner_uid"], user)
            return True
        return False
    require_owner(owner, user)
    await store.execute(
        "INSERT INTO event_owners (event_id, owner_uid, verified_at) VALUES (?,?,?) "
        "ON CONFLICT(event_id) DO UPDATE SET owner_uid=excluded.owner_uid, "
        "verified_at=excluded.verified_at",
        (event_id, owner, utc_now()),
    )
    return True


def require_owner(resource_owner_id: str | None, user: VerifiedUser) -> None:
    if resource_owner_id is None or resource_owner_id != user.uid:
        raise AppError(ErrorCode.not_found, "Event not found.")


def get_event_repository(request: Request) -> EventOwnershipRepository:
    return request.app.state.event_repository
