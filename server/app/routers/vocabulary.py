"""Event-owned vocabulary; raw transcripts never receive replacements."""

import json
from typing import Any

from fastapi import APIRouter, Request

from app.core.errors import AppError, ErrorCode
from app.models.ids import DocId
from app.routers.sessions import User
from app.schemas.vocabulary import VocabularyIn
from app.security.ownership import check_event_owner_offline_tolerant, require_owner
from app.services.store import utc_now

router = APIRouter(prefix="/api/v1/vocabulary")


@router.post("")
async def save(body: VocabularyIn, request: Request, user: User) -> dict[str, Any]:
    state = request.app.state
    # Local-only data: allowed offline for unverified events; known other owner -> 404.
    await check_event_owner_offline_tolerant(
        body.event_id, user, state.event_repository, state.store
    )
    if len(body.terms) > state.settings.vocabulary_max_terms:
        raise AppError(ErrorCode.validation_error, "Too many vocabulary terms.")
    replacements = [item.model_dump(by_alias=True) for item in body.replacements]
    await state.store.execute(
        "INSERT INTO vocabulary VALUES (?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET "
        "owner_uid=excluded.owner_uid,terms_json=excluded.terms_json,"
        "replacements_json=excluded.replacements_json,updated_at=excluded.updated_at",
        (body.event_id, user.uid, json.dumps(body.terms), json.dumps(replacements), utc_now()),
    )
    return {"event_id": body.event_id, "terms": body.terms, "replacements": replacements}


@router.get("")
async def get(event_id: DocId, request: Request, user: User) -> dict[str, Any]:
    state = request.app.state
    await check_event_owner_offline_tolerant(event_id, user, state.event_repository, state.store)
    rows = await state.store.rows("SELECT * FROM vocabulary WHERE event_id=?", (event_id,))
    if not rows:
        return {"event_id": event_id, "terms": [], "replacements": []}
    require_owner(rows[0]["owner_uid"], user)
    return {
        "event_id": event_id,
        "terms": json.loads(rows[0]["terms_json"]),
        "replacements": json.loads(rows[0]["replacements_json"]),
    }
