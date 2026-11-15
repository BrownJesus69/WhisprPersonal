"""Seam stitching. Word timings below are taken from real large-v3-turbo runs on this repo's
fixture (see overlap.py docstring); each case reproduced a loss or duplicate under an earlier,
single-chunk rule."""

from app.services.overlap import (
    AbsWord,
    ChunkWords,
    Word,
    normalize_word,
    render,
    seam,
    stitch,
    to_absolute,
    words_from_json,
    words_to_json,
)


def chunk(start: int, end: int, words: list[tuple[str, int, int]]) -> ChunkWords:
    return ChunkWords(start, end, [AbsWord(s, e, f" {t}") for t, s, e in words])


def stitched_text(*chunks: ChunkWords) -> str:
    parts = []
    for i, own in enumerate(chunks):
        previous = chunks[i - 1] if i else None
        following = chunks[i + 1] if i + 1 < len(chunks) else None
        parts.append(render(stitch(own, previous, following))[0])
    return " ".join(p for p in parts if p)


def test_word_cut_at_earlier_end_prefers_later_full_word() -> None:
    # 0-9 s | 8-16 s. "transcription" truncated to "transcripts." in the earlier chunk and
    # "about secure" garbled to "outsecure" at the start of the later one.
    earlier = chunk(
        0, 9000, [("about", 7200, 7500), ("secure", 7600, 8200), ("transcripts.", 8300, 9000)]
    )
    later = chunk(
        8000,
        16130,
        [("outsecure", 8000, 8250), ("transcription", 8560, 9100), ("systems", 9100, 9600)],
    )
    assert stitched_text(earlier, later) == "about secure transcription systems"


def test_text_anchor_handles_misheard_head_word() -> None:
    # Cut 8.1 s, overlap 1 s: the later chunk hears "will" as "we'll".
    earlier = chunk(
        0,
        8100,
        [("today", 6940, 7260), ("will", 7260, 7480), ("talk", 7480, 7760), ("about", 7760, 8000)],
    )
    later = chunk(
        7100,
        16130,
        [
            ("Today", 7100, 7280),
            ("we'll", 7280, 7520),
            ("talk", 7520, 7760),
            ("about", 7760, 8080),
            ("secure", 8080, 8460),
        ],
    )
    assert stitched_text(earlier, later) == "today will talk about secure"


def test_word_missing_from_later_chunk_is_not_lost() -> None:
    # Cut 5.0 s, overlap 1.5 s: Whisper skipped "summit in Bengaluru" in the later chunk.
    earlier = chunk(
        0, 5000, [("summit", 3840, 4320), ("in", 4320, 4580), ("Bengaluru.", 4580, 4980)]
    )
    later = chunk(3500, 16130, [("Our", 5520, 6160), ("first", 6160, 6520)])
    assert stitched_text(earlier, later) == "summit in Bengaluru. Our first"


def test_smeared_neighbour_is_not_treated_as_duplicate() -> None:
    # Cuts 6.45 s, overlap 1.5 s: earlier dropped trailing "Our"; later's "Our" is stretched
    # over Bengaluru's end (34% overlap) and must survive.
    earlier = chunk(0, 6450, [("in", 4320, 4580), ("Bengaluru.", 4580, 5140)])
    later = chunk(4950, 12600, [("Our", 4950, 6230), ("first", 6230, 6530)])
    assert stitched_text(earlier, later) == "in Bengaluru. Our first"


def test_exact_repeat_in_overlap_is_removed_once() -> None:
    earlier = chunk(0, 3100, [("Welcome", 1860, 2500), ("to", 2500, 2700), ("the", 2700, 2940)])
    later = chunk(2100, 9000, [("to", 2480, 2700), ("the", 2700, 2950), ("annual", 2950, 3220)])
    assert stitched_text(earlier, later) == "Welcome to the annual"


def test_middle_chunk_is_stitched_on_both_sides() -> None:
    first = chunk(0, 5000, [("a", 3000, 3400), ("b", 4200, 4600)])
    middle = chunk(4000, 10000, [("b", 4200, 4600), ("c", 6000, 6400), ("d", 9200, 9600)])
    last = chunk(9000, 15000, [("d", 9200, 9600), ("e", 11000, 11400)])
    assert stitched_text(first, middle, last) == "a b c d e"


def test_no_overlap_keeps_everything() -> None:
    earlier = chunk(0, 5000, [("x", 4800, 4990)])
    later = chunk(5000, 9000, [("x", 5000, 5200)])
    assert seam(earlier, later) == (set(), set())


def test_unknown_neighbour_keeps_all_words() -> None:
    own = chunk(8000, 16000, [("outsecure", 8000, 8250), ("transcription", 8560, 9100)])
    assert render(stitch(own, None, None))[0] == "outsecure transcription"


def test_normalize_keeps_indic_marks_and_strips_punctuation() -> None:
    assert normalize_word(" Bengaluru.") == "bengaluru"
    assert normalize_word("ಕನ್ನಡ,") == "ಕನ್ನಡ"  # Kannada virama/vowel signs are preserved
    assert normalize_word(" Hello") == "hello"


def test_absolute_conversion_render_and_json_round_trip() -> None:
    words = to_absolute([Word(0.25, 0.5, " hi", 0), Word(0.5, 0.9, " there.", 1)], 10000)
    assert words == [AbsWord(10250, 10500, " hi", 0), AbsWord(10500, 10900, " there.", 1)]
    text, segments = render(words)
    assert text == "hi there."
    assert segments == [
        {"start_ms": 10250, "end_ms": 10500, "text": "hi"},
        {"start_ms": 10500, "end_ms": 10900, "text": "there."},
    ]
    assert words_from_json(words_to_json(words)) == words
    assert words_from_json(None) == []
