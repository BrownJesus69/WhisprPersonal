"""Stitch overlapping chunks without losing or duplicating words.

Designed from real-GPU evidence (large-v3-turbo, a 16 s clip cut at 13 positions with 1.0 s and
1.5 s overlaps):
- A word cut by a chunk edge is garbled in that chunk ("transcription" -> "transcripts." at the
  end of one chunk; "about secure" -> "outsecure" / "will" -> "we'll" at the start of the next).
- The two chunks disagree on word timing near the seam by up to ~0.3 s.
- Whisper may silently skip a partial phrase at the very start of a clip ("summit in Bengaluru"
  was absent from the later chunk), so neither chunk can decide alone without losing words.

Each seam is therefore decided from BOTH chunks' words:
1. Text alignment: if words in the overlap region match (case/punctuation-insensitive, with
   consistent timing), cut at the last matched pair: the earlier chunk keeps up to it, the later
   chunk continues after it.
2. Otherwise pair words that overlap in time; keep the copy not truncated by a cut edge (or, if
   neither/both are, the one on the correct side of the overlap midpoint).
3. Any word without a counterpart in the other chunk is kept (losing raw words is worse than a
   rare duplicate).
A chunk's text is recomputed whenever a neighbour finishes, so the worker emits
`transcript_revised` for a chunk whose stitched text changed.
"""

import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any


@dataclass
class Word:
    """Engine output: seconds relative to the chunk start."""

    start: float
    end: float
    text: str
    segment: int = 0


@dataclass(frozen=True)
class AbsWord:
    """Stored form: milliseconds on the session timeline."""

    start_ms: int
    end_ms: int
    text: str
    segment: int = 0

    @property
    def centre_ms(self) -> float:
        return (self.start_ms + self.end_ms) / 2


@dataclass
class ChunkWords:
    start_ms: int
    end_ms: int
    words: list[AbsWord]


# A word whose edge lies within this distance of a chunk cut was heard only partially.
EDGE_MS = 100
# Timing slack when selecting words near the overlap region and validating text matches.
REGION_SLACK_MS = 300
MATCH_MAX_SKEW_MS = 600
SAME_SLOT_RATIO = 0.5


def normalize_word(text: str) -> str:
    """Case-fold and drop whitespace/Unicode punctuation; Indic combining marks are kept."""
    return "".join(
        ch
        for ch in text.casefold()
        if not ch.isspace() and not unicodedata.category(ch).startswith("P")
    )


def to_absolute(words: list[Word], chunk_start_ms: int) -> list[AbsWord]:
    return [
        AbsWord(
            chunk_start_ms + int(round(w.start * 1000)),
            chunk_start_ms + int(round(w.end * 1000)),
            w.text,
            w.segment,
        )
        for w in words
    ]


def words_to_json(words: list[AbsWord]) -> list[list[Any]]:
    return [[w.start_ms, w.end_ms, w.text, w.segment] for w in words]


def words_from_json(rows: list[list[Any]] | None) -> list[AbsWord]:
    return [AbsWord(int(r[0]), int(r[1]), str(r[2]), int(r[3])) for r in rows or []]


def _same_slot(a: AbsWord, b: AbsWord) -> bool:
    """Plausibly the same spoken word: they overlap for >= half of the shorter one.

    Real cases: truncated/full pairs overlap ~80% ("transcripts."/"transcription",
    "secure"/"outsecure"); a neighbouring word with smeared timing overlapped only 34%
    ("Bengaluru." vs a stretched "Our"), and must not be treated as a duplicate.
    """
    overlap = min(a.end_ms, b.end_ms) - max(a.start_ms, b.start_ms)
    shorter = max(1, min(a.end_ms - a.start_ms, b.end_ms - b.start_ms))
    return overlap > 0 and overlap / shorter >= SAME_SLOT_RATIO


def _covered(word: AbsWord, others: list[AbsWord]) -> bool:
    return any(_same_slot(word, other) for other in others)


def seam(earlier: ChunkWords, later: ChunkWords) -> tuple[set[int], set[int]]:
    """Return (indices to drop from earlier, indices to drop from later)."""
    lo, hi = later.start_ms, earlier.end_ms
    if hi <= lo:
        return set(), set()
    p_idx = [i for i, w in enumerate(earlier.words) if w.end_ms > lo - REGION_SLACK_MS]
    l_idx = [j for j, w in enumerate(later.words) if w.start_ms < hi + REGION_SLACK_MS]
    if not p_idx or not l_idx:
        return set(), set()

    # 1. Text alignment, anchored at the last time-consistent matching pair.
    p_tok = [normalize_word(earlier.words[i].text) for i in p_idx]
    l_tok = [normalize_word(later.words[j].text) for j in l_idx]
    anchor: tuple[int, int] | None = None
    for block in SequenceMatcher(None, p_tok, l_tok, autojunk=False).get_matching_blocks():
        for k in range(block.size):
            pi, lj = p_idx[block.a + k], l_idx[block.b + k]
            if not p_tok[block.a + k]:
                continue
            skew = abs(earlier.words[pi].start_ms - later.words[lj].start_ms)
            if skew <= MATCH_MAX_SKEW_MS:
                anchor = (pi, lj)
    if anchor is not None:
        pi, lj = anchor
        # Words on the "wrong" side of the anchor are dropped only when the other chunk has a
        # word covering the same time (Whisper may have skipped them in the other chunk).
        later_after = [later.words[j] for j in range(lj + 1, len(later.words))]
        earlier_upto = [earlier.words[i] for i in range(pi + 1)]
        return (
            {i for i in p_idx if i > pi and _covered(earlier.words[i], later_after)},
            {j for j in l_idx if j <= lj and _covered(later.words[j], earlier_upto)},
        )

    # 2. No textual agreement: resolve only words that overlap in time.
    mid = (lo + hi) / 2
    drop_p: set[int] = set()
    drop_l: set[int] = set()
    for i in p_idx:
        p = earlier.words[i]
        for j in l_idx:
            q = later.words[j]
            if not _same_slot(p, q):
                continue
            p_cut = p.end_ms >= hi - EDGE_MS
            q_cut = q.start_ms <= lo + EDGE_MS
            if p_cut and not q_cut:
                drop_p.add(i)
            elif q_cut and not p_cut:
                drop_l.add(j)
            elif (p.centre_ms + q.centre_ms) / 2 < mid:
                drop_l.add(j)
            else:
                drop_p.add(i)
    return drop_p, drop_l


def stitch(
    own: ChunkWords, previous: ChunkWords | None, following: ChunkWords | None
) -> list[AbsWord]:
    """A chunk's kept words given whichever neighbours are already transcribed."""
    drop: set[int] = set()
    if previous is not None:
        drop |= seam(previous, own)[1]
    if following is not None:
        drop |= seam(own, following)[0]
    return [w for i, w in enumerate(own.words) if i not in drop]


def _join(words: list[AbsWord]) -> str:
    # Whisper word tokens carry their own leading space only where a word boundary exists
    # (" 2" + ".30" -> " 2.30"). Stripping each token and joining with spaces produced
    # "2 .30" (found in the Phase 5 real-GPU check), so concatenate raw tokens and only
    # normalise whitespace runs.
    return " ".join("".join(w.text for w in words).split())


def render(words: list[AbsWord]) -> tuple[str, list[dict[str, Any]]]:
    """Raw text and segments (grouped by the engine's original segments)."""
    groups: dict[int, list[AbsWord]] = {}
    for word in words:
        groups.setdefault(word.segment, []).append(word)
    segments = [
        {"start_ms": group[0].start_ms, "end_ms": group[-1].end_ms, "text": _join(group)}
        for group in groups.values()
    ]
    return _join(words), segments
