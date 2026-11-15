"""Durable SQLite queue. All connection access is locked and off the event loop."""

import asyncio
import json
import sqlite3
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TypeVar

T = TypeVar("T")

MIGRATIONS = [
    """
CREATE TABLE sessions (
 id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, event_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','finalizing','finalized')),
 transcript_status TEXT NOT NULL CHECK(transcript_status IN ('pending','complete','partial')),
 model_profile TEXT NOT NULL CHECK(model_profile IN ('turbo','accurate')), model_name TEXT,
 language_mode TEXT, expected_languages TEXT, overlap_ms INTEGER,
 expected_chunk_count INTEGER, force_finalize INTEGER NOT NULL DEFAULT 0,
 tracker_state TEXT, firestore_sync TEXT CHECK(firestore_sync IN
 ('pending','synced','failed','disabled')), firestore_error TEXT,
 created_at TEXT, updated_at TEXT, finalized_at TEXT, error_code TEXT
);
CREATE TABLE chunks (
 session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, chunk_id TEXT,
 sequence INTEGER, start_ms INTEGER, end_ms INTEGER, overlap_ms INTEGER,
 continues INTEGER, file_name TEXT, sha256 TEXT, size_bytes INTEGER, content_type TEXT,
 status TEXT CHECK(status IN ('queued','processing','done','failed')), attempts INTEGER DEFAULT 0,
 next_attempt_at REAL DEFAULT 0, language_requested TEXT, detected_language TEXT,
 language_confidence REAL, language_source TEXT, language_uncertain INTEGER DEFAULT 0,
 no_speech INTEGER DEFAULT 0, raw_text TEXT, raw_text_full TEXT, segments_json TEXT,
 error_code TEXT, processing_ms INTEGER, created_at TEXT, updated_at TEXT,
 PRIMARY KEY(session_id,chunk_id), UNIQUE(session_id,sequence)
);
CREATE INDEX queue_ready ON chunks(status,next_attempt_at,created_at);
CREATE TABLE session_events (
 session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, seq INTEGER,
 type TEXT, payload_json TEXT, created_at TEXT, PRIMARY KEY(session_id,seq)
);
CREATE TABLE vocabulary (
 event_id TEXT PRIMARY KEY, owner_uid TEXT, terms_json TEXT, replacements_json TEXT, updated_at TEXT
);
CREATE TABLE audit_log (
 id INTEGER PRIMARY KEY, ts TEXT, uid TEXT, session_id TEXT, chunk_id TEXT,
 action TEXT, outcome TEXT, duration_ms INTEGER, model TEXT, detail_json TEXT
);
""",
    # 2: untrimmed timed words per chunk (session-timeline ms) for two-sided seam stitching.
    "ALTER TABLE chunks ADD COLUMN words_json TEXT;",
    # 3: persistent local grant revocations.
    "CREATE TABLE revoked_grants (jti TEXT PRIMARY KEY, uid TEXT, exp INTEGER, revoked_at TEXT);",
    # 4: offline-tolerant event ownership. event_owners caches Firestore-verified owners;
    # ownership_pending marks sessions created while Firestore was unreachable (never synced to
    # Firestore until ownership is verified online).
    """
CREATE TABLE event_owners (event_id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, verified_at TEXT);
ALTER TABLE sessions ADD COLUMN ownership_pending INTEGER NOT NULL DEFAULT 0;
""",
    # 5: optional AI output is separate from immutable speech text.
    """
ALTER TABLE chunks ADD COLUMN polished_text TEXT;
ALTER TABLE chunks ADD COLUMN polished_level TEXT;
ALTER TABLE chunks ADD COLUMN polish_error TEXT;
ALTER TABLE chunks ADD COLUMN polished_at TEXT;
CREATE TABLE ai_jobs (
 id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('cleanup','brief')),
 event_id TEXT NOT NULL, session_ids TEXT NOT NULL, params_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','interrupted')),
 provider TEXT, model TEXT, result_json TEXT, error_code TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX ai_jobs_owner ON ai_jobs(owner_uid, created_at);
CREATE TABLE ai_usage (
 id INTEGER PRIMARY KEY, ts TEXT NOT NULL, job_id TEXT, uid TEXT, provider TEXT NOT NULL,
 model TEXT, purpose TEXT NOT NULL, outcome TEXT NOT NULL, error_kind TEXT,
 latency_ms INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER
);
""",
]


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def insert(connection: sqlite3.Connection, table: str, values: dict[str, Any]) -> None:
    # Identifiers are internal constants; all client values are bound parameters.
    columns = ",".join(values)
    placeholders = ",".join("?" for _ in values)
    connection.execute(
        f"INSERT INTO {table} ({columns}) VALUES ({placeholders})",  # noqa: S608
        tuple(values.values()),
    )  # noqa: S608


def update(
    connection: sqlite3.Connection,
    table: str,
    values: dict[str, Any],
    where: str,
    args: tuple[Any, ...],
) -> None:
    assignments = ",".join(f"{key}=?" for key in values)
    connection.execute(f"UPDATE {table} SET {assignments} WHERE {where}", (*values.values(), *args))  # noqa: S608


def event_in(
    connection: sqlite3.Connection, session_id: str, kind: str, payload: dict[str, Any]
) -> dict[str, Any]:
    seq = connection.execute(
        "SELECT COALESCE(MAX(seq),0)+1 FROM session_events WHERE session_id=?", (session_id,)
    ).fetchone()[0]
    ts = utc_now()
    insert(
        connection,
        "session_events",
        {
            "session_id": session_id,
            "seq": seq,
            "type": kind,
            "payload_json": json.dumps(payload),
            "created_at": ts,
        },
    )
    return {"type": kind, "seq": seq, "session_id": session_id, "ts": ts, "data": payload}


def audit_in(
    connection: sqlite3.Connection,
    action: str,
    session_id: str | None = None,
    chunk_id: str | None = None,
    uid: str | None = None,
    outcome: str = "ok",
    duration_ms: int | None = None,
    model: str | None = None,
    detail: dict[str, Any] | None = None,
) -> None:
    insert(
        connection,
        "audit_log",
        {
            "ts": utc_now(),
            "uid": uid,
            "session_id": session_id,
            "chunk_id": chunk_id,
            "action": action,
            "outcome": outcome,
            "duration_ms": duration_ms,
            "model": model,
            "detail_json": json.dumps(detail or {}),
        },
    )


class Store:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.audio_dir = data_dir / "audio"
        self.lock = threading.Lock()
        self.connection: sqlite3.Connection | None = None
        # Serialize filesystem/queue admission and session mutations across await points.
        self.mutation_lock = asyncio.Lock()

    async def open(self) -> None:
        def initialize() -> None:
            with self.lock:
                self.audio_dir.mkdir(parents=True, exist_ok=True)
                self.connection = sqlite3.connect(
                    self.data_dir / "whisprpersonal.sqlite3", check_same_thread=False
                )
                self.connection.row_factory = sqlite3.Row
                for pragma in (
                    "journal_mode=WAL",
                    "synchronous=NORMAL",
                    "foreign_keys=ON",
                    "busy_timeout=5000",
                ):
                    self.connection.execute(f"PRAGMA {pragma}")
                version = self.connection.execute("PRAGMA user_version").fetchone()[0]
                if version > len(MIGRATIONS):
                    raise RuntimeError("Unsupported store version")
                for index in range(version, len(MIGRATIONS)):
                    self.connection.executescript(
                        "BEGIN IMMEDIATE;\n"
                        + MIGRATIONS[index]
                        + f"\nPRAGMA user_version={index + 1};\nCOMMIT;"
                    )
                with self.connection:
                    self.connection.execute(
                        "UPDATE ai_jobs SET status='interrupted', updated_at=? "
                        "WHERE status IN ('queued','running')",
                        (utc_now(),),
                    )
                    self.connection.execute(
                        # Retain through the maximum supported verifier clock skew (60s).
                        "DELETE FROM revoked_grants WHERE exp < ?",
                        (int(time.time()) - 60,),
                    )

        await asyncio.to_thread(initialize)

    async def transaction(self, operation: Callable[[sqlite3.Connection], T]) -> T:
        def run() -> T:
            with self.lock:
                if self.connection is None:
                    raise RuntimeError("Store is closed")
                with self.connection:
                    return operation(self.connection)

        return await asyncio.to_thread(run)

    async def rows(self, sql: str, args: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        return await self.transaction(lambda conn: [dict(row) for row in conn.execute(sql, args)])

    async def execute(self, sql: str, args: tuple[Any, ...] = ()) -> None:
        def run(conn: sqlite3.Connection) -> None:
            conn.execute(sql, args)

        await self.transaction(run)

    async def session(self, session_id: str) -> dict[str, Any] | None:
        rows = await self.rows("SELECT * FROM sessions WHERE id=?", (session_id,))
        return rows[0] if rows else None

    async def chunks(self, session_id: str) -> list[dict[str, Any]]:
        return await self.rows(
            "SELECT * FROM chunks WHERE session_id=? ORDER BY sequence", (session_id,)
        )

    async def queue_depth(self) -> int:
        rows = await self.rows(
            "SELECT COUNT(*) AS n FROM chunks WHERE status IN ('queued','processing')"
        )
        return int(rows[0]["n"])

    async def recover_on_startup(self) -> dict[str, int]:
        def recover(conn: sqlite3.Connection) -> dict[str, int]:
            count = conn.execute(
                "UPDATE chunks SET status='queued' WHERE status='processing'"
            ).rowcount
            return {"requeued": count}

        return await self.transaction(recover)

    async def append_event(self, session_id: str, kind: str, payload: dict[str, Any]) -> int:
        result = await self.transaction(lambda conn: event_in(conn, session_id, kind, payload))
        return int(result["seq"])

    async def events(self, session_id: str, after_seq: int = 0) -> list[dict[str, Any]]:
        rows = await self.rows(
            "SELECT * FROM session_events WHERE session_id=? AND seq>? ORDER BY seq",
            (session_id, after_seq),
        )
        return [
            {
                "session_id": session_id,
                "seq": row["seq"],
                "type": row["type"],
                "ts": row["created_at"],
                "data": json.loads(row["payload_json"]),
            }
            for row in rows
        ]

    async def audit(
        self,
        action: str,
        session_id: str | None = None,
        chunk_id: str | None = None,
        uid: str | None = None,
        outcome: str = "ok",
        duration_ms: int | None = None,
        model: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> None:
        await self.transaction(
            lambda conn: audit_in(
                conn, action, session_id, chunk_id, uid, outcome, duration_ms, model, detail
            )
        )

    async def close(self) -> None:
        def close() -> None:
            with self.lock:
                if self.connection is not None:
                    self.connection.close()
                    self.connection = None

        await asyncio.to_thread(close)
