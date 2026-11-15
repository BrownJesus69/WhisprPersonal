"""Final-only Firestore projection; local transcription never depends on cloud writes."""

import asyncio
from datetime import datetime
from typing import Any

from app.services.firebase import FirebaseService


class FirestoreSyncError(Exception):
    pass


def timestamp(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def session_fields(session: dict[str, Any], chunks: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "ownerId": session["owner_uid"],
        "status": session["status"],
        "model": session["model_name"],
        "languageMode": session["language_mode"],
        "detectedLanguages": sorted(
            {c["detected_language"] for c in chunks if c["detected_language"]}
        ),
        "startedAt": timestamp(session["created_at"]),
        "endedAt": timestamp(session["finalized_at"]),
        "durationMs": max((c["end_ms"] for c in chunks), default=0),
        "serverSessionId": session["id"],
        "transcriptStatus": session["transcript_status"],
        "error": session["error_code"],
    }


def chunk_fields(chunk: dict[str, Any]) -> dict[str, Any]:
    return {
        "sequence": chunk["sequence"],
        "startMs": chunk["start_ms"],
        "endMs": chunk["end_ms"],
        "uploadStatus": "uploaded",
        "transcriptionStatus": chunk["status"],
        "detectedLanguage": chunk["detected_language"],
        "languageConfidence": chunk["language_confidence"],
        "languageSource": chunk["language_source"],
        "userOverride": chunk["language_source"] == "override",
        "rawText": chunk["raw_text"] or "",
        "polishedText": None,
        "error": chunk["error_code"],
        "createdAt": timestamp(chunk["created_at"]),
        "updatedAt": timestamp(chunk["updated_at"]),
    }


class DisabledFirestoreSync:
    enabled = False

    async def session_started(self, session: dict[str, Any]) -> None:
        pass

    async def session_finalized(
        self, session: dict[str, Any], chunks: list[dict[str, Any]]
    ) -> None:
        pass

    async def delete_session(self, event_id: str, session_id: str) -> None:
        pass


class FirestoreSync:
    enabled = True

    def __init__(self, firebase_service: FirebaseService, timeout_s: float = 10.0) -> None:
        self.service = firebase_service
        # Without a bound, google-cloud-firestore retries for minutes when the laptop is
        # offline, which would stall callers. Every operation must finish within this budget.
        self.timeout_s = timeout_s

    def reference(self, event_id: str, session_id: str) -> Any:
        return (
            self.service.firestore()
            .collection("events")
            .document(event_id)
            .collection("sessions")
            .document(session_id)
        )

    async def session_started(self, session: dict[str, Any]) -> None:
        def write() -> None:
            self.reference(session["event_id"], session["id"]).set(
                session_fields(session, []), merge=True
            )

        await self._run(write)

    async def session_finalized(
        self, session: dict[str, Any], chunks: list[dict[str, Any]]
    ) -> None:
        def write() -> None:
            client = self.service.firestore()
            reference = self.reference(session["event_id"], session["id"])
            operations = [
                (reference.collection("chunks").document(c["chunk_id"]), chunk_fields(c))
                for c in chunks
            ]
            # Publish session completion only after every chunk batch succeeds.
            for offset in range(0, len(operations), 450):
                batch = client.batch()
                for ref, data in operations[offset : offset + 450]:
                    batch.set(ref, data, merge=True)
                batch.commit()
            reference.set(session_fields(session, chunks), merge=True)

        await self._run(write)

    async def delete_session(self, event_id: str, session_id: str) -> None:
        def delete() -> None:
            client = self.service.firestore()
            reference = self.reference(event_id, session_id)
            while True:
                docs = list(reference.collection("chunks").limit(450).stream())
                if not docs:
                    break
                batch = client.batch()
                for doc in docs:
                    batch.delete(doc.reference)
                batch.commit()
            reference.delete()

        await self._run(delete)

    async def _run(self, operation: Any) -> None:
        try:
            # The thread cannot be killed on timeout; it finishes in the background and its
            # result is discarded. Writes are idempotent (merge/delete), so a late success is safe.
            await asyncio.wait_for(asyncio.to_thread(operation), timeout=self.timeout_s)
        except Exception:
            raise FirestoreSyncError("firestore_unavailable") from None
