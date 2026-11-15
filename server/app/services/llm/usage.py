"""Attempt audit: only allowlisted metadata, never prompts or outputs."""

import logging
from contextvars import ContextVar
from dataclasses import dataclass

from app.core.request_context import request_id_var
from app.services.llm.base import ChatResult, LLMProvider
from app.services.store import Store, insert, utc_now


@dataclass(frozen=True)
class UsageContext:
    job_id: str
    uid: str
    request_id: str


usage_context: ContextVar[UsageContext | None] = ContextVar("ai_usage_context", default=None)


class UsageRecorder:
    def __init__(self, store: Store) -> None:
        self.store = store

    async def record(
        self,
        provider: LLMProvider,
        purpose: str,
        latency_ms: int,
        result: ChatResult | None,
        error_kind: str | None,
    ) -> None:
        context = usage_context.get()
        values = {
            "ts": utc_now(),
            "job_id": context.job_id if context else None,
            "uid": context.uid if context else None,
            "provider": provider.name,
            "model": provider.model,
            "purpose": purpose,
            "outcome": "error" if error_kind else "ok",
            "error_kind": error_kind,
            "latency_ms": latency_ms,
            "prompt_tokens": result.prompt_tokens if result else None,
            "completion_tokens": result.completion_tokens if result else None,
        }
        await self.store.transaction(lambda conn: insert(conn, "ai_usage", values))
        logging.getLogger(__name__).info(
            "ai_call",
            extra={
                **values,
                "event": "ai_call",
                "request_id": context.request_id if context else request_id_var.get(),
            },
        )
