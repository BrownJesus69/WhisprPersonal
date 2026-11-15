"""Admin SDK bypasses rules: enforce ownership before accessing event resources."""

import asyncio
from typing import Protocol

from fastapi import Request
from google.api_core.exceptions import GoogleAPICallError, RetryError
from google.auth.exceptions import GoogleAuthError

from app.core.errors import AppError, ErrorCode
from app.models.ids import validate_doc_id
from app.security.auth import VerifiedUser
from app.services.firebase import FirebaseService


class EventOwnershipRepository(Protocol):
    async def get_event_owner(self, event_id: str) -> str | None: ...


class DisabledEventRepository:
    async def get_event_owner(self, event_id: str) -> str | None:
        raise AppError(ErrorCode.auth_not_configured, "Firebase is not configured.")


class FirestoreEventRepository:
    def __init__(self, service: FirebaseService) -> None:
        self.service = service

    async def get_event_owner(self, event_id: str) -> str | None:
        validate_doc_id(event_id, "event_id")

        def fetch() -> str | None:
            snapshot = (
                self.service.firestore()
                .collection("events")
                .document(event_id)
                .get(field_paths=["ownerId"])
            )
            data = snapshot.to_dict() if snapshot.exists else None
            owner = data.get("ownerId") if data else None
            return owner if isinstance(owner, str) else None

        try:
            return await asyncio.to_thread(fetch)
        # GoogleAuthError covers TransportError/RefreshError raised when the laptop is offline
        # and the service-account access token cannot be refreshed.
        except (GoogleAPICallError, RetryError, GoogleAuthError, TimeoutError, OSError):
            raise AppError(
                ErrorCode.firestore_unavailable, "Event storage is unavailable."
            ) from None


async def require_event_owner(
    event_id: str, user: VerifiedUser, repo: EventOwnershipRepository
) -> None:
    validate_doc_id(event_id, "event_id")
    require_owner(await repo.get_event_owner(event_id), user)


def require_owner(resource_owner_id: str | None, user: VerifiedUser) -> None:
    if resource_owner_id is None or resource_owner_id != user.uid:
        raise AppError(ErrorCode.not_found, "Event not found.")


def get_event_repository(request: Request) -> EventOwnershipRepository:
    return request.app.state.event_repository
