"""Credentials probe for the Connect-laptop screen."""

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app import __version__
from app.security.auth import VerifiedUser
from app.security.rate_limit import authenticated_user

router = APIRouter()


class AuthCheckResponse(BaseModel):
    uid: str
    email: str | None
    email_verified: bool
    sign_in_provider: str | None
    server_version: str


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
    )
