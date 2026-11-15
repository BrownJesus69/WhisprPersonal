"""Pure, serializable language confidence and hysteresis decisions."""

from dataclasses import dataclass, field
from typing import Any, Literal

from app.config import Settings


@dataclass
class LanguageDecision:
    language: str | None
    confidence: float | None
    source: Literal["override", "auto", "locked"]
    uncertain: bool
    detect: bool
    events: list[tuple[str, dict[str, Any]]] = field(default_factory=list)


class LanguageTracker:
    def __init__(
        self, settings: Settings, mode: str = "auto", expected_languages: list[str] | None = None
    ) -> None:
        self.settings = settings
        self.mode = mode
        self.expected_languages = expected_languages or []
        self.locked: str | None = None
        self.candidate: str | None = None
        self.streak = 0
        self.speech_s = 0.0
        self.switch_candidate: str | None = None
        self.switch_streak = 0

    def needs_detection(self) -> bool:
        return self.mode == "auto"

    def set_mode(self, mode: str) -> None:
        if mode == "auto" and self.mode != "auto":
            self.locked = self.candidate = self.switch_candidate = None
            self.streak = self.switch_streak = 0
            self.speech_s = 0.0
        self.mode = mode

    def decide(
        self, sequence: int, probs: list[tuple[str, float]] | None, speech_s: float
    ) -> LanguageDecision:
        if speech_s < 0.2:
            return LanguageDecision(None, None, "auto", False, False)
        if not self.needs_detection():
            return LanguageDecision(self.mode, None, "override", False, False)
        allowed = self.expected_languages or self.settings.supported_languages
        raw = dict(probs or [])
        total = sum(raw.get(code, 0) for code in allowed)
        normalized = {code: raw.get(code, 0) / total if total else 0 for code in allowed}
        best = max(normalized, key=normalized.get)
        confidence = float(normalized[best])
        outside = bool(raw and max(raw, key=raw.get) not in allowed and max(raw.values()) >= 0.5)
        uncertain = outside or confidence < self.settings.language_uncertain_threshold
        decision = LanguageDecision(best, confidence, "auto", uncertain, True)
        if self.locked is None:
            if confidence >= self.settings.language_lock_threshold:
                if self.candidate != best:
                    self.candidate, self.streak, self.speech_s = best, 0, 0.0
                self.streak += 1
                self.speech_s += speech_s
                if (
                    self.streak >= self.settings.language_lock_min_chunks
                    and self.speech_s >= self.settings.language_detect_window_s
                ):
                    self.locked = best
                    decision.events.append(
                        (
                            "language_locked",
                            {
                                "language": best,
                                "confidence": confidence,
                                "at_sequence": sequence,
                            },
                        )
                    )
            else:
                self.candidate, self.streak, self.speech_s = None, 0, 0.0
        elif best != self.locked and confidence >= self.settings.language_switch_threshold:
            if self.switch_candidate != best:
                self.switch_candidate, self.switch_streak = best, 0
            self.switch_streak += 1
            if self.switch_streak >= self.settings.language_switch_consecutive:
                previous, self.locked = self.locked, best
                self.switch_candidate, self.switch_streak = None, 0
                decision.events.append(
                    (
                        "language_changed",
                        {
                            "from": previous,
                            "to": best,
                            "at_sequence": sequence,
                        },
                    )
                )
        else:
            self.switch_candidate, self.switch_streak = None, 0
            decision.language, decision.source = self.locked, "locked"
            decision.confidence = float(normalized[self.locked])
            decision.uncertain = outside or (
                decision.confidence < self.settings.language_uncertain_threshold
            )
        return decision

    def to_state(self) -> dict[str, Any]:
        return {key: value for key, value in vars(self).items() if key != "settings"}

    @classmethod
    def from_state(cls, state: dict[str, Any], settings: Settings) -> "LanguageTracker":
        tracker = cls(settings)
        for key in tracker.to_state():
            if key in state:
                setattr(tracker, key, state[key])
        return tracker
