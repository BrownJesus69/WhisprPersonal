from typing import Any

from app.services.language import LanguageTracker


def test_forced_and_silence(make_settings: Any) -> None:
    tracker = LanguageTracker(make_settings(), "kn")
    assert not tracker.needs_detection()
    decision = tracker.decide(0, None, 16)
    assert (decision.language, decision.source, decision.confidence, decision.detect) == (
        "kn",
        "override",
        None,
        False,
    )
    assert tracker.decide(1, None, 0).language is None


def test_lock_window_switch_and_reset(make_settings: Any) -> None:
    settings = make_settings()
    tracker = LanguageTracker(settings)
    for seq in range(2):
        tracker.decide(seq, [("en", 0.9), ("kn", 0.1)], 4)
        assert tracker.locked is None
    locked = tracker.decide(2, [("en", 0.9), ("kn", 0.1)], 8)
    assert tracker.locked == "en"
    assert locked.events[0][0] == "language_locked"
    spike = tracker.decide(3, [("kn", 0.9), ("en", 0.1)], 8)
    assert spike.language == "kn" and spike.source == "auto" and tracker.locked == "en"
    stable = tracker.decide(4, [("en", 0.9), ("kn", 0.1)], 8)
    assert stable.source == "locked" and tracker.switch_streak == 0
    tracker.decide(5, [("kn", 0.9), ("en", 0.1)], 8)
    changed = tracker.decide(6, [("kn", 0.9), ("en", 0.1)], 8)
    assert changed.events == [("language_changed", {"from": "en", "to": "kn", "at_sequence": 6})]
    assert LanguageTracker.from_state(tracker.to_state(), settings).to_state() == tracker.to_state()
    tracker.set_mode("hi")
    tracker.set_mode("auto")
    assert tracker.locked is None and tracker.streak == 0


def test_expected_restriction_and_uncertainty(make_settings: Any) -> None:
    tracker = LanguageTracker(make_settings(), expected_languages=["kn", "en"])
    decision = tracker.decide(0, [("te", 0.55), ("kn", 0.35), ("en", 0.1)], 16)
    assert decision.language == "kn" and decision.uncertain
    assert abs(decision.confidence - 0.35 / 0.45) < 0.0001
    tracker = LanguageTracker(make_settings())
    decision = tracker.decide(0, [("kn", 0.3), ("en", 0.3), ("hi", 0.2), ("ta", 0.2)], 16)
    assert decision.uncertain and tracker.locked is None
    tracker.decide(1, [("en", 0.9), ("kn", 0.1)], 16)
    tracker.decide(2, [("en", 0.9), ("kn", 0.1)], 16)
    decision = tracker.decide(3, [("kn", 0.7), ("en", 0.3)], 16)
    assert decision.language == "en" and decision.uncertain and decision.confidence == 0.3
