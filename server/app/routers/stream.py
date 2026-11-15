"""Header-authenticated WebSocket with subscribe-before-replay delivery."""

import asyncio
import json
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from app.core.errors import AppError, ErrorCode
from app.models.ids import validate_doc_id
from app.routers.sessions import change_language, owned
from app.schemas.stream import SetLanguage
from app.security.auth import enforce_allowlist, require_auth
from app.security.rate_limit import rate_error
from app.services.store import utc_now

router = APIRouter()


@router.websocket("/api/v1/sessions/{session_id}/stream")
async def stream(websocket: WebSocket, session_id: str) -> None:
    await websocket.accept()
    state = websocket.app.state
    try:
        user = await require_auth(websocket)
        enforce_allowlist(user, state.settings)
        decision = state.user_limiter.check(user.uid)
        if not decision.allowed:
            raise rate_error(decision)
        validate_doc_id(session_id, "session_id")
        try:
            after_seq = int(websocket.query_params.get("after_seq", "0"))
            if after_seq < 0:
                raise ValueError
        except ValueError:
            raise AppError(ErrorCode.validation_error, "Invalid event cursor.") from None
        async with state.store.mutation_lock:
            session = await owned(state, session_id, user)
            subscriber = state.broadcaster.subscribe(session_id)
    except AppError as exc:
        code = {401: 4401, 403: 4403, 404: 4404, 429: 4429, 503: 4503}.get(exc.status_code, 4400)
        await websocket.send_json({"type": "error", "code": exc.code, "message": exc.message})
        await websocket.close(code)
        return
    receive_task: asyncio.Task[str] | None = None
    queue_task: asyncio.Task[dict] | None = None
    try:
        replay = await state.store.events(session_id, after_seq)
        seq_rows = await state.store.rows(
            "SELECT COALESCE(MAX(seq),0) AS seq FROM session_events WHERE session_id=?",
            (session_id,),
        )
        await websocket.send_json(
            {
                "type": "hello",
                "session_id": session_id,
                "status": session["status"],
                "last_event_seq": seq_rows[0]["seq"],
                "server_time": utc_now(),
            }
        )
        last_seq = after_seq
        for message in replay:
            await websocket.send_json(message)
            last_seq = message["seq"]
        receive_task = asyncio.create_task(
            websocket.receive_text(), name="Stream input (~connection lifetime)"
        )
        queue_task = asyncio.create_task(
            subscriber.queue.get(), name="Stream delivery (~connection lifetime)"
        )
        last_ping = time.monotonic()
        while True:
            if subscriber.overflowed:
                await websocket.close(4008)
                return
            done, _ = await asyncio.wait(
                {receive_task, queue_task}, timeout=1, return_when=asyncio.FIRST_COMPLETED
            )
            if queue_task in done:
                message = queue_task.result()
                if "seq" not in message or message["seq"] > last_seq:
                    await websocket.send_json(message)
                    last_seq = message.get("seq", last_seq)
                    if message["type"] == "session_deleted":
                        await websocket.close(1000)
                        return
                queue_task = asyncio.create_task(
                    subscriber.queue.get(), name="Stream delivery (~connection lifetime)"
                )
            if receive_task in done:
                raw = receive_task.result()
                try:
                    if len(raw.encode("utf-8")) > 4096:
                        raise ValueError
                    data = json.loads(raw)
                    if not isinstance(data, dict):
                        raise ValueError
                    if data.get("type") == "set_language":
                        command = SetLanguage.model_validate(data)
                        decision = state.user_limiter.check(user.uid)
                        if not decision.allowed:
                            raise rate_error(decision)
                        await change_language(state, session_id, command.language, user)
                    elif data.get("type") != "pong":
                        raise ValueError
                except (ValueError, ValidationError):
                    await websocket.send_json(
                        {
                            "type": "error",
                            "code": "bad_request",
                            "message": "Invalid stream command.",
                        }
                    )
                except AppError as exc:
                    await websocket.send_json(
                        {"type": "error", "code": exc.code, "message": exc.message}
                    )
                receive_task = asyncio.create_task(
                    websocket.receive_text(), name="Stream input (~connection lifetime)"
                )
            if time.monotonic() - last_ping >= 20:
                await websocket.send_json({"type": "ping"})
                last_ping = time.monotonic()
    except WebSocketDisconnect:
        pass
    finally:
        state.broadcaster.unsubscribe(session_id, subscriber)
        tasks = [task for task in (receive_task, queue_task) if task is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
