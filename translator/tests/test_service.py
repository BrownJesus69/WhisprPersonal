import asyncio
import os
import secrets
import sys
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError

from app.config import Settings
from app.engine import DIRECTIONS, IndicTrans2Engine, TranslationError, direction_for, split_segment
from app.main import create_app
from scripts.benchmark import eligible, evaluate
from scripts.download_models import main as download


def settings(tmp_path: Path, **values: Any) -> Settings:
    return Settings(hf_cache_dir=tmp_path / "hf", **values)


@pytest.mark.parametrize("source", ["kn", "ta", "hi", "en"])
@pytest.mark.parametrize("target", ["kn", "ta", "hi", "en"])
def test_pairs(source: str, target: str) -> None:
    if source == target:
        with pytest.raises(TranslationError, match="same_language"):
            direction_for(source, target)
    else:
        expected = "en_indic" if source == "en" else "indic_en" if target == "en" else "indic_indic"
        assert direction_for(source, target) == expected


def test_api_auth_and_missing_models(tmp_path: Path) -> None:
    payload = {
        "source_lang": "kn",
        "target_lang": "en",
        "segments": [{"id": "0", "text": "ನಮಸ್ಕಾರ"}],
    }
    with TestClient(create_app(settings(tmp_path))) as client:
        assert set(client.get("/health").json()["directions"].values()) == {"not_downloaded"}
        response = client.post("/translate", json=payload)
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "translator_not_configured"
    secret = secrets.token_urlsafe(36)
    with TestClient(create_app(settings(tmp_path, shared_secret=secret))) as client:
        assert client.post("/translate", json=payload).status_code == 401
        client.headers["X-WhisprPersonal-Translator-Key"] = secret
        assert (
            client.post("/translate", json=payload).json()["error"]["code"]
            == "model_not_downloaded"
        )
        for source, code in (("en", "same_language"), ("fr", "unsupported_pair")):
            response = client.post("/translate", json={**payload, "source_lang": source})
            assert response.status_code == 422
            assert response.json()["error"]["code"] == code
            assert set(response.json()["error"]) == {"code", "message", "request_id"}


@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.1", "::", "example.com"])
def test_loopback_refusal(tmp_path: Path, host: str) -> None:
    with pytest.raises(ValidationError):
        settings(tmp_path, host=host)
    assert settings(tmp_path, host=host, allow_lan=True).host == host


def test_local_only_and_pin(tmp_path: Path) -> None:
    with pytest.raises(ValidationError):
        settings(tmp_path, local_files_only=False)
    with pytest.raises(ValidationError):
        settings(tmp_path, indic_en_revision="main")


def fake_engine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[IndicTrans2Engine, list[Any]]:
    calls: list[Any] = []

    def loader(direction: str, cpu: bool = False) -> Any:
        calls.append((direction, cpu))
        return object()

    engine = IndicTrans2Engine(settings(tmp_path, idle_unload_s=1), loader, lambda: 100)
    monkeypatch.setattr(engine, "on_disk", lambda d: True)
    monkeypatch.setattr(engine, "_generate", lambda texts, s, t: [text.upper() for text in texts])
    return engine, calls


def test_load_switch_split_rejoin_idle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    engine, calls = fake_engine(tmp_path, monkeypatch)
    monkeypatch.setattr("app.engine.split_segment", lambda t, s, n: t.split("|"))
    assert asyncio.run(engine.translate("kn", "en", ["a|b", "c"])) == ["A B", "C"]
    assert engine.status()["indic_en"] == "loaded"
    assert asyncio.run(engine.translate("ta", "en", ["d"])) == ["D"]
    assert len(calls) == 1
    asyncio.run(engine.translate("en", "hi", ["e"]))
    assert calls[-1] == ("en_indic", False)
    engine.last_used = 90
    engine.unload_idle()
    assert engine.loaded_direction is None and engine.bundle is None
    assert set(engine.status().values()) == {"ready_on_disk"}


def test_sentence_split_and_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    from indicnlp.tokenize import sentence_tokenize

    calls = []

    def split(text: str, lang: str) -> list[str]:
        calls.append(lang)
        return ["ಮೊದಲ ವಾಕ್ಯ.", "ಎರಡನೇ ವಾಕ್ಯ."]

    monkeypatch.setattr(sentence_tokenize, "sentence_split", split)
    assert len(split_segment("a" * 10, "kn", 2)) == 2
    assert calls == ["kn"]

    def fail(*args: Any, **kwargs: Any) -> Any:
        raise ValueError

    monkeypatch.setattr(sentence_tokenize, "sentence_split", fail)
    assert split_segment("long", "ta", 1) == ["long"]


def test_api_success_labels(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    engine, _ = fake_engine(tmp_path, monkeypatch)
    secret = secrets.token_urlsafe(36)
    engine.settings.shared_secret = SecretStr(secret)
    with TestClient(create_app(engine.settings, engine)) as client:
        response = client.post(
            "/translate",
            headers={"X-WhisprPersonal-Translator-Key": secret},
            json={
                "source_lang": "hi",
                "target_lang": "en",
                "segments": [{"id": "a", "text": "hello"}],
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["engine"] == "indictrans2"
        assert data["model"].endswith("@ac3daf0")
        assert data["segments"] == [{"id": "a", "text": "HELLO"}]
        assert data["source_lang"] == "hi" and data["target_lang"] == "en"
        assert data["created_at"]


@pytest.mark.parametrize("retry", [False, True])
def test_oom_retry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, retry: bool) -> None:
    engine, calls = fake_engine(tmp_path, monkeypatch)
    engine.settings.cpu_retry_on_oom = retry

    class OutOfMemoryError(Exception):
        pass

    def generate(texts: list[str], s: str, t: str) -> list[str]:
        if len(calls) == 1:
            raise OutOfMemoryError
        return texts

    monkeypatch.setattr(engine, "_generate", generate)
    if retry:
        assert asyncio.run(engine.translate("hi", "en", ["x"])) == ["x"]
        assert calls == [("indic_en", False), ("indic_en", True)]
    else:
        with pytest.raises(TranslationError, match="cuda_oom"):
            asyncio.run(engine.translate("hi", "en", ["x"]))
        assert engine.status()["indic_en"] == "error"


def test_snapshot_status(tmp_path: Path) -> None:
    engine = IndicTrans2Engine(settings(tmp_path))
    path = engine.snapshot("indic_en")
    path.mkdir(parents=True)
    for name in (
        "config.json",
        "configuration_indictrans.py",
        "modeling_indictrans.py",
        "dict.SRC.json",
        "dict.TGT.json",
        "model.SRC",
        "model.TGT",
        "model.safetensors",
        "generation_config.json",
    ):
        (path / name).write_text("fake", encoding="utf-8")
    assert engine.status()["indic_en"] == "ready_on_disk"
    assert all(engine.status()[d] == "not_downloaded" for d in DIRECTIONS if d != "indic_en")


def test_download_refuses_token(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        download(["--token", "forbidden"])
    assert exc.value.code == 2
    assert "forbidden" not in capsys.readouterr().err


def test_benchmark_math() -> None:
    assert eligible(45, 50) and not eligible(44.9, 50)
    assert eligible(35, None) and not eligible(34.9, None)

    async def exact(s: str, t: str, texts: list[str]) -> list[str]:
        return texts

    result = asyncio.run(
        evaluate(
            {"indictrans2": exact, "libretranslate": exact},
            {lang: ["A conversation about 250 rupees."] * 12 for lang in ("en", "hi", "ta", "kn")},
        )
    )
    metrics = result["engines"]["libretranslate"]["hi-en"]
    assert metrics["chrf"] == 100 and metrics["n"] == 12 and metrics["eligible"]
    assert result["recommendation"]["hi-en"] == "indictrans2"
    assert len(result["engines"]["indictrans2"]) == 12


def test_fake_model_pipeline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    class Processor:
        def preprocess_batch(self, texts: list[str], **kwargs: Any) -> list[str]:
            calls.append(("preprocess", kwargs))
            return texts

        def postprocess_batch(self, texts: list[str], lang: str) -> list[str]:
            calls.append(("postprocess", lang))
            return ["Hello"]

    class Inputs(dict):
        def to(self, device: str) -> Any:
            assert device == "cpu"
            return self

    class Tokenizer:
        def __call__(self, texts: list[str], **kwargs: Any) -> Any:
            calls.append(("tokenize", kwargs))
            return Inputs(input_ids=[1])

        def batch_decode(self, output: Any, skip_special_tokens: bool) -> list[str]:
            assert skip_special_tokens
            calls.append(("decode", output))
            return ["Hello"]

    class Model:
        def generate(self, **kwargs: Any) -> Any:
            assert kwargs == {
                "input_ids": [1],
                "num_beams": 5,
                "max_length": 256,
                "use_cache": False,
            }
            calls.append(("generate", None))
            return [2]

    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(inference_mode=nullcontext))
    engine = IndicTrans2Engine(settings(tmp_path))
    engine.bundle = (Model(), Tokenizer(), Processor(), "cpu")
    assert engine._generate(["ನಮಸ್ಕಾರ"], "kn", "en") == ["Hello"]
    assert [c[0] for c in calls] == ["preprocess", "tokenize", "generate", "decode", "postprocess"]
    assert calls[0][1] == {"src_lang": "kan_Knda", "tgt_lang": "eng_Latn"}


def test_download_is_pinned_and_safetensors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import huggingface_hub

    config = settings(tmp_path)
    calls = []
    monkeypatch.setattr("scripts.download_models.Settings", lambda: config)
    monkeypatch.setattr(huggingface_hub, "snapshot_download", lambda **kw: calls.append(kw))
    assert download([]) == 0
    assert len(calls) == 3
    for call, direction in zip(calls, DIRECTIONS, strict=True):
        repo, revision = config.model_spec(direction)
        assert call["repo_id"] == repo and call["revision"] == revision
        assert call["allow_patterns"] == [
            "*.json",
            "*.py",
            "model.SRC",
            "model.TGT",
            "model.safetensors",
        ]
        assert "token" not in call


@pytest.mark.skipif(
    os.environ.get("TRANSLATOR_RUN_MODEL_TESTS") != "1", reason="Owner opt-in offline models"
)
def test_real_models(tmp_path: Path) -> None:
    engine = IndicTrans2Engine(Settings())
    for source, text in (
        ("kn", "ನಮಸ್ಕಾರ, ಇಂದು ಸಭೆ 2.30ಕ್ಕೆ ಇದೆ."),
        ("ta", "வணக்கம், இன்று கூட்டம் 2.30 மணிக்கு."),
        ("hi", "नमस्ते, आज बैठक 2.30 बजे है।"),
    ):
        out = asyncio.run(engine.translate(source, "en", [text]))[0]
        # English output only: no Indic script may leak through (regression: "2.30ಕ್ಕೆ").
        assert out.strip() and not any("ऀ" <= c <= "෿" for c in out), out
        assert "2:30" in out or "2.30" in out or "two thirty" in out.lower(), out


def test_digit_glued_to_indic_suffix_is_split_and_times_are_tidied() -> None:
    from app.engine import prepare_source, tidy_output

    assert prepare_source("ಸಭೆ 2.30ಕ್ಕೆ ಇದೆ") == "ಸಭೆ 2.30 ಕ್ಕೆ ಇದೆ"
    assert prepare_source("கூட்டம் 10மணிக்கு") == "கூட்டம் 10 மணிக்கு"
    assert prepare_source("हमारे पास 25 लोग") == "हमारे पास 25 लोग"
    assert prepare_source("Room 2B at 10.30") == "Room 2B at 10.30"
    assert tidy_output("starts at 2: 30 pm") == "starts at 2:30 pm"
    assert tidy_output("Note: 30 people") == "Note: 30 people"
