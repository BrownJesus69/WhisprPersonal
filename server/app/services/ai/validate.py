"""Reject edits that lose speech, change script or exceed conservative similarity bounds."""

import re
import unicodedata
from collections import Counter
from difflib import SequenceMatcher
from typing import Any

from app.services.llm.prompts import HEADINGS

MARKER = re.compile(r"<<([0-9]+)>>")


def tokens(text: str) -> list[str]:
    text = unicodedata.normalize("NFC", text).lower()
    return "".join(c if not unicodedata.category(c).startswith("P") else " " for c in text).split()


def script(text: str) -> str | None:
    counts: Counter[str] = Counter()
    for char in unicodedata.normalize("NFC", text):
        if unicodedata.category(char).startswith("L"):
            name = unicodedata.name(char, "UNKNOWN")
            # Unicode letter names begin with their script (including Indic scripts).
            counts[name.split()[0]] += 1
    return counts.most_common(1)[0][0] if counts else None


def validate_cleanup(
    output: str, chunks: list[dict[str, Any]], level: str
) -> dict[int, tuple[str | None, str | None]]:
    matches = list(MARKER.finditer(output))
    sequences = [int(m.group(1)) for m in matches]
    expected = [c["sequence"] for c in chunks]
    counts = Counter(sequences)
    parsed = {
        int(m.group(1)): output[
            m.end() : matches[i + 1].start() if i + 1 < len(matches) else None
        ].strip()
        for i, m in enumerate(matches)
    }
    # Unexpected/reordered markers make chunk attribution unsafe.
    ordered = [n for n in sequences if n in expected] == [n for n in expected if n in sequences]
    results = {}
    for chunk in chunks:
        seq = chunk["sequence"]
        raw = chunk["raw_text"]
        text = parsed.get(seq, "")
        error = None
        if (
            counts[seq] != 1
            or not ordered
            or any(n not in expected for n in sequences)
            or any(m.group(1) != str(int(m.group(1))) for m in matches)
        ):
            error = "missing_marker"
        elif not text:
            error = "empty"
        elif script(text) != script(raw):
            error = "script_changed"
        elif not 0.6 <= len(text) / max(1, len(raw)) <= 1.5 or SequenceMatcher(
            None, tokens(raw), tokens(text), autojunk=False
        ).ratio() < (0.85 if level == "conservative" else 0.6):
            error = "too_different"
        results[seq] = (None if error else text, error)
    return results


def validate_brief(text: str, brief_type: str) -> tuple[str, dict[str, Any] | None, str | None]:
    text = re.sub(r"\A\s*```[^\n]*\n", "", text)
    text = re.sub(r"\n?```\s*\Z", "", text).strip()[:100000]
    matches = list(re.finditer(r"^## (.+?)\s*$", text, re.M))
    if not all(any(m.group(1) == h for m in matches) for h in HEADINGS[brief_type]):
        return text, None, "unstructured_output"
    structured = {}
    for i, match in enumerate(matches):
        if match.group(1) not in HEADINGS[brief_type]:
            continue
        value = text[match.end() : matches[i + 1].start() if i + 1 < len(matches) else None].strip()
        lines = value.splitlines()
        structured[match.group(1)] = (
            [re.sub(r"^\s*[-*]\s+", "", line) for line in lines if line.strip()]
            if lines and all(not line.strip() or re.match(r"^\s*[-*]\s+", line) for line in lines)
            else value
        )
    return text, structured, None
