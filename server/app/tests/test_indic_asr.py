"""Offline Indic decoding and integration: no real TorchScript/ONNX weights are loaded."""

import json
import logging
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock

import numpy as np
import pytest
from pydantic import ValidationError

from app.services import indic_asr
from app.services.indic_asr import IndicConformer, align_words
from app.services.overlap import Word, render, to_absolute, words_to_json
from app.services.transcription import AudioClip, CompositeEngine
from app.tests.fakes import FakeEngine, create_session, upload_chunk, wait_done
from app.tests.test_dictation import post
from app.tests.test_restitch import db
from app.workers.transcription_worker import restitch


class Tensor:
    def __init__(self, data: Any) -> None:
        self.data = np.asarray(data)

    def cpu(self) -> "Tensor":
        return self

    def numpy(self) -> np.ndarray:
        return self.data


@pytest.fixture
def runtime(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    model_dir = tmp_path / "indic"
    assets = model_dir / "assets"
    assets.mkdir(parents=True)
    config = {
        "BLANK_ID": 3,
        "SOS": 3,
        "RNNT_MAX_SYMBOLS": 2,
        "PRED_RNN_LAYERS": 1,
        "PRED_RNN_HIDDEN_DIM": 2,
    }
    (model_dir / "config.json").write_text(json.dumps(config))
    (assets / "vocab.json").write_text(
        json.dumps({lang: ["\u2581one", "\u2581tw", "o", ""] for lang in ["kn", "hi", "ta"]})
    )
    (assets / "language_masks.json").write_text(
        json.dumps({lang: [4, 1, 5, 0] for lang in ["kn", "hi", "ta"]})
    )
    names = [
        "encoder",
        "ctc_decoder",
        "rnnt_decoder",
        "joint_enc",
        "joint_pred",
        "joint_pre_net",
        "joint_post_net_kn",
        "joint_post_net_hi",
        "joint_post_net_ta",
    ]
    for name in ["preprocessor.ts", *(f"{name}.onnx" for name in names)]:
        (assets / name).touch()
    sessions: dict[str, Any] = {}
    # Non-identity language mask ensures CTC ids are language-local after masking.
    ctc = np.full((1, 9, 6), -10.0, dtype=np.float32)
    for frame, token in enumerate([3, 0, 0, 3, 1, 2, 3, 0, 0]):
        ctc[0, frame, [4, 1, 5, 0][token]] = 10

    class Session:
        def __init__(self, path: str, **kwargs: Any) -> None:
            assert kwargs["providers"] == ["CPUExecutionProvider"]
            self.name = Path(path).stem
            self.calls: list[Any] = []
            self.tokens = iter([0, 3, 1, 2, 3, 3, 3, 3, 3])
            sessions[self.name] = self

        def run(self, outputs: list[str], inputs: dict[str, Any]) -> list[Any]:
            self.calls.append(inputs)
            if self.name == "encoder":
                return [np.zeros((1, 2, 9), np.float32), np.array([7])]
            if self.name == "ctc_decoder":
                return [ctc]
            if self.name == "rnnt_decoder":
                assert inputs["targets"].dtype == np.int32
                assert inputs["states.1"].dtype == np.float32
                return [
                    np.zeros((1, 2, 1), np.float32),
                    np.array([1]),
                    inputs["states.1"] + 1,
                    inputs["onnx::Slice_3"] + 1,
                ]
            if self.name.startswith("joint_post_net"):
                logits = np.full((1, 1, 4), -10, np.float32)
                logits[0, 0, next(self.tokens, 3)] = 10
                return [logits]
            return [inputs["input"]]

    preprocessor = Mock(return_value=(Tensor(np.zeros((1, 2, 9))), Tensor([9])))
    preprocessor.eval = Mock(return_value=preprocessor)
    jit_load = Mock(return_value=preprocessor)
    torch = SimpleNamespace(
        jit=SimpleNamespace(load=jit_load),
        inference_mode=nullcontext,
        from_numpy=Tensor,
        tensor=Tensor,
    )
    ort = SimpleNamespace(InferenceSession=Session, SessionOptions=SimpleNamespace)
    original = indic_asr.importlib.import_module

    def import_module(name: str, *args: Any, **kwargs: Any) -> Any:
        return (
            {"torch": torch, "onnxruntime": ort}[name]
            if name in {"torch", "onnxruntime"}
            else original(name, *args, **kwargs)
        )

    monkeypatch.setattr(indic_asr.importlib, "import_module", import_module)
    monkeypatch.setattr(
        "faster_whisper.vad.get_speech_timestamps",
        lambda samples, **kwargs: [{"start": 0, "end": len(samples)}],
    )
    return SimpleNamespace(
        path=model_dir, sessions=sessions, ctc=ctc, preprocessor=preprocessor, jit_load=jit_load
    )


def test_load_decode_and_real_word_boundaries(runtime: Any) -> None:
    model = IndicConformer(runtime.path, ["kn"])
    assert model.status == "not_loaded" and runtime.sessions == {}
    text, words = model.transcribe(np.zeros(16000, np.float32), "kn")
    assert model.status == "ready"
    assert text == "one two"
    assert words == [Word(0.08, 0.24, " one", 0), Word(0.32, 0.48, " two", 1)]
    assert render(to_absolute(words, 0))[0] == text
    assert len(runtime.sessions["encoder"].calls) == 1  # encode once for both decoders
    assert runtime.jit_load.call_args.kwargs == {"map_location": "cpu"}
    assert not {"joint_post_net_hi", "joint_post_net_ta"} & runtime.sessions.keys()
    decoder_calls = runtime.sessions["rnnt_decoder"].calls
    # A blank does not commit prediction state; hitting max symbols advances the frame.
    assert [int(call["states.1"][0, 0, 0]) for call in decoder_calls[:5]] == [0, 1, 1, 2, 3]
    assert len(decoder_calls) == 9  # ignores two padded encoder frames
    model.transcribe(np.zeros(16000, np.float32), "kn")
    runtime.jit_load.assert_called_once()
    assert runtime.preprocessor.call_count == 2


def test_ctc_blank_repeat_and_tail_without_word_marker(runtime: Any) -> None:
    model = IndicConformer(runtime.path, ["kn"])
    model.load(runtime.path)
    model.vocab["kn"] = ["x", "\u2581y", "z", ""]
    logits = np.full((1, 5, 6), -10.0)
    for frame, token in enumerate([0, 0, 3, 0, 2]):
        logits[0, frame, [4, 1, 5, 0][token]] = 10
    runtime.sessions["ctc_decoder"].run = Mock(return_value=[logits])
    assert model._ctc_decode(np.empty(0), np.array([5]), "kn") == [Word(0, 0.4, "xxz")]


def test_alignment_mismatched_counts() -> None:
    ctc = [Word(1, 2, "ctc"), Word(3, 5, "words")]
    assert align_words("a bbb cc", ctc) == [
        Word(1, 1 + 4 / 6, " a", 0),
        Word(1 + 4 / 6, 1 + 16 / 6, " bbb", 1),
        Word(1 + 16 / 6, 5, " cc", 2),
    ]
    assert align_words("", []) == []
    with pytest.raises(ValueError, match="timestamps_unavailable"):
        align_words("speech", [])


@pytest.mark.parametrize("speech_samples", [0, 3199])
def test_silence_never_loads_or_decodes(
    runtime: Any, monkeypatch: pytest.MonkeyPatch, speech_samples: int
) -> None:
    monkeypatch.setattr(
        "faster_whisper.vad.get_speech_timestamps",
        lambda *args, **kwargs: [{"start": 0, "end": speech_samples}],
    )
    model = IndicConformer(runtime.path, ["kn"])
    assert model.transcribe(np.zeros(16000, np.float32), "kn") == ("", [])
    assert model.status == "not_loaded" and not runtime.sessions


@pytest.mark.parametrize("missing", ["torch", "onnxruntime"])
def test_runtime_missing(runtime: Any, monkeypatch: pytest.MonkeyPatch, missing: str) -> None:
    original = indic_asr.importlib.import_module

    def missing_import(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == missing:
            raise ImportError("unavailable")
        return original(name, *args, **kwargs)

    monkeypatch.setattr(indic_asr.importlib, "import_module", missing_import)
    assert IndicConformer(runtime.path, ["kn"]).status == "not_configured"


def test_missing_files_and_disabled(runtime: Any) -> None:
    assert IndicConformer(runtime.path, ["kn"], False).status == "not_configured"
    assert IndicConformer(runtime.path, []).status == "not_configured"
    (runtime.path / "assets" / "joint_post_net_kn.onnx").unlink()
    assert IndicConformer(runtime.path, ["kn"]).status == "not_configured"


@pytest.mark.parametrize(
    "lang,enabled,indic",
    [
        ("kn", ["kn", "hi", "ta"], True),
        ("hi", ["kn", "hi", "ta"], True),
        ("ta", ["kn", "hi", "ta"], True),
        ("en", ["kn", "hi", "ta"], False),
        ("hi", ["kn"], False),
        ("auto", ["kn", "hi", "ta"], False),
    ],
)
def test_routing(
    runtime: Any, make_settings: Any, lang: str, enabled: list[str], indic: bool
) -> None:
    settings = make_settings(indic_asr_model_dir=runtime.path, indic_asr_languages=enabled)
    whisper = FakeEngine()
    engine = CompositeEngine(whisper, settings)
    segments = []
    clip = AudioClip(np.zeros(16000, np.float32), 1)
    engine.transcribe(clip, "turbo", lang, "private hotwords", segments.append)
    assert any(call[0] == "transcribe" for call in whisper.calls) != indic
    assert segments[0].text == ("one two" if indic else whisper.output.raw_text_full)
    assert len(segments) == 1
    assert engine.detect(clip, "accurate") == [("en", 0.95), ("kn", 0.05)]
    assert engine.speech_seconds(clip) == 16
    assert engine.load_audio(Path("fake.wav")).duration_s == 16


@pytest.mark.parametrize("stage", ["load", "run"])
def test_safe_fallback(
    runtime: Any, make_settings: Any, monkeypatch: pytest.MonkeyPatch, caplog: Any, stage: str
) -> None:
    settings = make_settings(indic_asr_model_dir=runtime.path)
    whisper = FakeEngine()
    engine = CompositeEngine(whisper, settings)
    if stage == "load":
        runtime.jit_load.side_effect = RuntimeError("PRIVATE TRANSCRIPT /private/path")
    else:
        engine.indic.load(runtime.path)
        runtime.sessions["encoder"].run = Mock(
            side_effect=RuntimeError("PRIVATE TRANSCRIPT /private/path")
        )
    with caplog.at_level(logging.DEBUG):
        result = engine.transcribe(
            AudioClip(np.zeros(16000, np.float32), 1),
            "turbo",
            "kn",
            "PRIVATE HOTWORDS",
            lambda segment: None,
        )
    assert result == whisper.output
    assert engine.indic.status == "error"
    assert any(getattr(record, "event", None) == "indic_asr_failed" for record in caplog.records)
    assert "PRIVATE" not in caplog.text and "/private/path" not in caplog.text
    if stage == "load":
        with pytest.raises(RuntimeError):
            engine.indic.load(runtime.path)
        runtime.jit_load.assert_called_once()  # failed cold load isn't repeated each chunk


def test_unavailable_uses_whisper(make_settings: Any) -> None:
    whisper = FakeEngine()
    engine = CompositeEngine(whisper, make_settings())
    assert engine.indic.status == "not_configured"
    assert (
        engine.transcribe(AudioClip(None, 1), "turbo", "kn", None, lambda s: None) == whisper.output
    )


def test_settings_validation(make_settings: Any) -> None:
    assert make_settings(indic_asr_languages="kn, hi,kn").indic_asr_languages == ["kn", "hi"]
    with pytest.raises(ValidationError):
        make_settings(indic_asr_languages="fr")
    assert make_settings(supported_languages="en").indic_asr_languages == []


def test_health_present_without_paths(client: Any) -> None:
    assert isinstance(client.app.state.engine, CompositeEngine)
    health = client.get("/health").json()["indic_asr"]
    assert health == {
        "status": "not_configured",
        "languages": ["kn", "hi", "ta"],
        "model": "ai4bharat/indic-conformer-600m-multilingual",
    }
    assert str(client.app.state.settings.models_dir) not in json.dumps(health)


def test_dictation_uses_composite(runtime: Any, phase3_client: Any) -> None:
    state = phase3_client.app.state
    state.settings.indic_asr_model_dir = runtime.path
    state.worker.engine = CompositeEngine(FakeEngine(), state.settings)
    state.server_state.model_status = "ready"
    result = post(phase3_client, language="kn")
    assert result.status_code == 200
    assert result.json()["text"] == "one two"
    assert not any(call[0] == "transcribe" for call in state.worker.engine.whisper.calls)


def test_worker_stitches_indic_words(runtime: Any, phase3_client: Any) -> None:
    state = phase3_client.app.state
    state.settings.indic_asr_model_dir = runtime.path
    engine = CompositeEngine(FakeEngine(), state.settings)
    # Route real worker inference through Indic, but script two overlapping RNNT/CTC results.
    outputs = iter(
        [
            (
                "\u0ca8\u0cae\u0cb8\u0ccd\u0c95\u0cbe\u0cb0 \u0c95\u0ca8\u0ccd\u0ca8\u0ca1",
                align_words(
                    "\u0ca8\u0cae\u0cb8\u0ccd\u0c95\u0cbe\u0cb0 \u0c95\u0ca8\u0ccd\u0ca8\u0ca1",
                    [Word(1, 2, "a"), Word(15.1, 15.6, "b")],
                ),
            ),
            (
                "\u0c95\u0ca8\u0ccd\u0ca8\u0ca1 \u0cad\u0cbe\u0cb7\u0cc6",
                align_words(
                    "\u0c95\u0ca8\u0ccd\u0ca8\u0ca1 \u0cad\u0cbe\u0cb7\u0cc6",
                    [Word(0.3, 0.8, "b"), Word(1.5, 2, "c")],
                ),
            ),
        ]
    )
    engine.indic.transcribe = Mock(side_effect=lambda *args: next(outputs))
    state.worker.engine = engine
    create_session(phase3_client, language_mode="kn")
    upload_chunk(phase3_client)
    upload_chunk(phase3_client, sequence=1, start_ms="14800", end_ms="30800", overlap_ms="1200")
    state.server_state.model_status = "ready"
    phase3_client.portal.call(state.worker.notify)
    result = wait_done(phase3_client, sequence=1)
    assert [row["raw_text"] for row in result["chunks"]] == [
        "\u0ca8\u0cae\u0cb8\u0ccd\u0c95\u0cbe\u0cb0 \u0c95\u0ca8\u0ccd\u0ca8\u0ca1",
        "\u0cad\u0cbe\u0cb7\u0cc6",
    ]


def test_restitch_preserves_aligned_indic_text() -> None:
    conn = db()
    for seq, start, end, text, times in [
        (0, 0, 5000, "\u0939\u092e \u092f\u0939\u093e\u0901", [(1, 2), (4.1, 4.5)]),
        (1, 3800, 9000, "\u092f\u0939\u093e\u0901 \u0939\u0948\u0902", [(0.3, 0.7), (1.5, 2)]),
    ]:
        words = align_words(text, [Word(a, b, "ctc") for a, b in times])
        absolute = to_absolute(words, start)
        rendered, segments = render(absolute)
        conn.execute(
            "INSERT INTO chunks (session_id,chunk_id,sequence,start_ms,end_ms,status,raw_text,"
            "segments_json,words_json) VALUES ('s',?,?,?,?, 'done',?,?,?)",
            (
                f"c{seq}",
                seq,
                start,
                end,
                rendered,
                json.dumps(segments),
                json.dumps(words_to_json(absolute)),
            ),
        )
    restitch(conn, "s", 1)
    assert [row[0] for row in conn.execute("SELECT raw_text FROM chunks ORDER BY sequence")] == [
        "\u0939\u092e \u092f\u0939\u093e\u0901",
        "\u0939\u0948\u0902",
    ]
    conn.close()
