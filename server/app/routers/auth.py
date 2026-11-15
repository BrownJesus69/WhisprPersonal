"""Credentials probe for the Connect-laptop screen."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app import __version__
from app.security.auth import VerifiedUser, require_firebase_auth
from app.security.rate_limit import authenticated_user, limit_user

router = APIRouter()


class AuthCheckResponse(BaseModel):
    uid: str
    email: str | None
    email_verified: bool
    sign_in_provider: str | None
    server_version: str
    auth_method: Literal["firebase", "grant"]
    grant_expires_at: int | None


@router.get("/api/v1/auth/check", response_model=AuthCheckResponse)
async def auth_check(
    user: Annotated[VerifiedUser, Depends(authenticated_user)],
) -> AuthCheckResponse:
    return AuthCheckResponse(
        uid=user.uid,
        email=user.email,
        email_verified=user.claims.get("email_verified") is True,
        sign_in_provider=user.claims.get("firebase", {}).get("sign_in_provider"),
        server_version=__version__,
        auth_method="grant" if user.claims.get("auth_method") == "grant" else "firebase",
        grant_expires_at=user.claims.get("exp")
        if user.claims.get("auth_method") == "grant"
        else None,
    )


class GrantResponse(BaseModel):
    grant: str
    expires_at: int
    ttl_s: int
    grant_id: str


class RevokeRequest(BaseModel):
    grant_id: str | None = Field(None, pattern=r"^[0-9a-f]{32}$")


class RevokeResponse(BaseModel):
    grant_id: str
    revoked: bool = True


class RotateResponse(BaseModel):
    rotated: bool = True


@router.post("/api/v1/auth/grant", response_model=GrantResponse)
async def issue_grant(
    request: Request,
    user: Annotated[VerifiedUser, Depends(require_firebase_auth)],
) -> GrantResponse:
    limit_user(request, user)
    return GrantResponse(**await request.app.state.grant_service.issue(user))


@router.post("/api/v1/auth/grant/revoke", response_model=RevokeResponse)
async def revoke_grant(
    request: Request,
    user: Annotated[VerifiedUser, Depends(authenticated_user)],
    body: RevokeRequest | None = None,
) -> RevokeResponse:
    grant_id = await request.app.state.grant_service.revoke(user, body.grant_id if body else None)
    return RevokeResponse(grant_id=grant_id)


@router.post("/api/v1/auth/grants/rotate-key", response_model=RotateResponse)
async def rotate_grant_key(
    request: Request,
    user: Annotated[VerifiedUser, Depends(authenticated_user)],
) -> RotateResponse:
    await request.app.state.grant_service.rotate_key(user)
    return RotateResponse()
