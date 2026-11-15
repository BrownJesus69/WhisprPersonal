import json
import sqlite3

from app.services.overlap import AbsWord, render, words_to_json
from app.services.store import MIGRATIONS
from app.workers.transcription_worker import restitch, revised_payload


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    for migration in MIGRATIONS:
        conn.executescript(migration)
    conn.execute(
        "INSERT INTO sessions (id, owner_uid, event_id, status, transcript_status, model_profile) "
        "VALUES ('s', 'u', 'e', 'active', 'pending', 'turbo')"
    )
    return conn


def add(
    conn: sqlite3.Connection, seq: int, start: int, end: int, words: list[tuple[str, int, int]]
) -> None:
    absolute = [AbsWord(s, e, f" {t}") for t, s, e in words]
    text, segments = render(absolute)  # what the worker stores before stitching
    conn.execute(
        "INSERT INTO chunks (session_id, chunk_id, sequence, start_ms, end_ms, status, raw_text, "
        "segments_json, words_json, language_uncertain, no_speech) "
        "VALUES ('s', ?, ?, ?, ?, 'done', ?, ?, ?, 0, 0)",
        (
            f"c{seq}",
            seq,
            start,
            end,
            text,
            json.dumps(segments),
            json.dumps(words_to_json(absolute)),
        ),
    )


def text(conn: sqlite3.Connection, seq: int) -> str:
    return conn.execute("SELECT raw_text FROM chunks WHERE sequence=?", (seq,)).fetchone()[0]


def test_late_middle_chunk_revises_both_neighbours() -> None:
    conn = db()
    add(conn, 0, 0, 5000, [("a", 1000, 1400), ("b", 4200, 4600)])
    add(conn, 2, 8800, 15000, [("garbled", 8800, 9000), ("d", 9200, 9600), ("e", 11000, 11400)])
    assert restitch(conn, "s", 2).keys() == {2}  # no neighbour yet: nothing trimmed
    assert text(conn, 2) == "garbled d e"

    # Chunk 1 heard "x" in full where chunk 2 (starting mid-word) heard a "garbled" fragment.
    add(
        conn,
        1,
        3500,
        10300,
        [("b", 4200, 4600), ("c", 6000, 6400), ("x", 8750, 9050), ("d", 9200, 9600)],
    )
    changed = restitch(conn, "s", 1)
    assert set(changed) == {1, 2}  # chunk 0 unchanged; chunk 2 revised
    assert [text(conn, i) for i in range(3)] == ["a b", "c x d", "e"]
    payload = revised_payload(changed[2])
    assert payload["sequence"] == 2 and payload["raw_text"] == "e"
    assert payload["language_uncertain"] is False


def test_head_word_without_counterpart_is_kept() -> None:
    # Lossless rule: a word at the start of the later chunk that the earlier chunk never heard
    # (Whisper skipped it) must survive stitching.
    conn = db()
    add(conn, 0, 0, 9000, [("c", 6000, 6400)])
    add(conn, 1, 8000, 15000, [("skipped", 8100, 8500), ("e", 11000, 11400)])
    restitch(conn, "s", 1)
    assert [text(conn, 0), text(conn, 1)] == ["c", "skipped e"]


def test_rows_without_words_are_left_untouched() -> None:
    conn = db()
    conn.execute(
        "INSERT INTO chunks (session_id, chunk_id, sequence, start_ms, end_ms, status, raw_text, "
        "segments_json, words_json) VALUES ('s', 'legacy', 0, 0, 5000, 'done', 'kept', '[]', NULL)"
    )
    add(conn, 1, 4000, 9000, [("x", 6000, 6400)])
    restitch(conn, "s", 1)
    assert text(conn, 0) == "kept"
    assert text(conn, 1) == "x"
