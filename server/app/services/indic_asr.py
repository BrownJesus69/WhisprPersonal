"""Local CPU inference, adapted from AI4Bharat IndicConformer (MIT).

The downloaded reference module is never imported. Optional runtimes and model
weights are loaded separately so Docker can continue using Whisper alone.
"""

import importlib
import json
from pathlib import Path
from threading import RLock
from typing import Any, Literal

import numpy as np

from app.services.overlap import Word

# Decoding and ONNX interfaces adapted from AI4Bharat IndicConformer (MIT).


def align_words(text: str, ctc_words: list[Word]) -> list[Word]:
    """Keep RNNT text, borrowing CTC boundaries or its character-weighted span."""
    tokens = text.split()
    if not tokens:
        return []
    if not ctc_words:
        # There is no defensible speech span. Let the composite fall back to Whisper.
        raise ValueError("indic_timestamps_unavailable")
    if len(tokens) == len(ctc_words):
        return [
            Word(w.start, w.end, " " + token, i)
            for i, (token, w) in enumerate(zip(tokens, ctc_words, strict=True))
        ]
    start, end = ctc_words[0].start, ctc_words[-1].end
    total = sum(len(token) for token in tokens)
    words = []
    used = 0
    for i, token in enumerate(tokens):
        t0 = start + (end - start) * used / total
        used += len(token)
        words.append(Word(t0, start + (end - start) * used / total, " " + token, i))
    return words


class IndicConformer:
    def __init__(self, model_dir: Path, languages: list[str], enabled: bool = True) -> None:
        self.model_dir = model_dir
        self.languages = list(languages)
        self.lock = RLock()
        self.models: dict[str, Any] = {}
        self.vocab: dict[str, list[str]] = {}
        self.language_masks: dict[str, list[int]] = {}
        self.config: dict[str, Any] = {}
        self.status: Literal["ready", "not_loaded", "not_configured", "error"] = "not_configured"
        self.torch: Any = None
        self.ort: Any = None
        self._load_failed = False
        if not enabled or not languages or not self.files_present(model_dir):
            return
        try:
            self.torch = importlib.import_module("torch")
            self.ort = importlib.import_module("onnxruntime")
        except Exception:
            return
        self.status = "not_loaded"

    def component_names(self) -> list[str]:
        return [
            "encoder",
            "ctc_decoder",
            "rnnt_decoder",
            "joint_enc",
            "joint_pred",
            "joint_pre_net",
            *(f"joint_post_net_{lang}" for lang in self.languages),
        ]

    def files_present(self, model_dir: Path) -> bool:
        required = [model_dir / "config.json"] + [
            model_dir / "assets" / name
            for name in [
                "preprocessor.ts",
                "vocab.json",
                "language_masks.json",
                *(f"{name}.onnx" for name in self.component_names()),
            ]
        ]
        try:
            return all(path.is_file() for path in required)
        except OSError:
            return False

    @property
    def available(self) -> bool:
        return self.status != "not_configured"

    def load(self, model_dir: Path) -> None:
        """Load once under the same lock used by inference; retain no partial load."""
        with self.lock:
            if self.models:
                return
            if not self.available or self._load_failed:
                raise RuntimeError("indic_model_unavailable")
            try:
                assets = model_dir / "assets"
                config = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
                vocab = json.loads((assets / "vocab.json").read_text(encoding="utf-8"))
                masks = json.loads((assets / "language_masks.json").read_text(encoding="utf-8"))
                models = {
                    "preprocessor": self.torch.jit.load(
                        str(assets / "preprocessor.ts"), map_location="cpu"
                    ).eval()
                }
                # Suppress native diagnostics containing local paths on load/run failures.
                options = self.ort.SessionOptions()
                options.log_severity_level = 4
                for name in self.component_names():
                    models[name] = self.ort.InferenceSession(
                        str(assets / f"{name}.onnx"),
                        sess_options=options,
                        providers=["CPUExecutionProvider"],
                    )
                self.config, self.vocab, self.language_masks = config, vocab, masks
                self.models = models
                self.status = "ready"
            except Exception:
                self.status = "error"
                self._load_failed = True
                raise RuntimeError("indic_load_failed") from None

    def _ctc_decode(self, encoded: np.ndarray, lengths: np.ndarray, lang: str) -> list[Word]:
        logits = self.models["ctc_decoder"].run(["logprobs"], {"encoder_output": encoded})[0]
        # Slice separately: numpy's advanced indexing otherwise moves the vocab axis first.
        path = logits[0, : int(lengths[0])][:, self.language_masks[lang]].argmax(axis=-1)
        segments: list[tuple[str, float, float]] = []
        current, start = None, 0
        blank = self.config["BLANK_ID"]
        for frame, token in enumerate([*path, blank]):
            token = int(token)
            if token != current:
                if current is not None and current != blank:
                    segments.append((self.vocab[lang][current], start * 0.08, frame * 0.08))
                current, start = token, frame
        words: list[Word] = []
        text, t0, t1 = "", 0.0, 0.0
        for token, begin, end in segments:
            if "\u2581" in token:
                if text:
                    words.append(Word(t0, t1, text))
                text, t0 = token.replace("\u2581", ""), begin
            else:
                if not text:
                    t0 = begin
                text += token
            t1 = end
        if text:
            words.append(Word(t0, t1, text))
        return words

    def _rnnt_decode(self, encoded: np.ndarray, lengths: np.ndarray, lang: str) -> str:
        projected = self.models["joint_enc"].run(["output"], {"input": encoded.transpose(0, 2, 1)})[
            0
        ]
        hyp = [self.config["SOS"]]
        shape = (self.config["PRED_RNN_LAYERS"], 1, self.config["PRED_RNN_HIDDEN_DIM"])
        state = (np.zeros(shape, dtype=np.float32), np.zeros(shape, dtype=np.float32))
        for frame in range(min(int(lengths[0]), projected.shape[1])):
            for _ in range(self.config["RNNT_MAX_SYMBOLS"]):
                g, _, h, c = self.models["rnnt_decoder"].run(
                    ["outputs", "prednet_lengths", "states", "162"],
                    {
                        "targets": np.array([[hyp[-1]]], dtype=np.int32),
                        "target_length": np.array([1], dtype=np.int32),
                        "states.1": state[0],
                        "onnx::Slice_3": state[1],
                    },
                )
                g = self.models["joint_pred"].run(["output"], {"input": g.transpose(0, 2, 1)})[0]
                joint = self.models["joint_pre_net"].run(
                    ["output"], {"input": projected[:, frame : frame + 1, :] + g}
                )[0]
                logits = self.models[f"joint_post_net_{lang}"].run(["output"], {"input": joint})[0]
                token = int(logits.argmax(axis=-1).item())
                if token == self.config["BLANK_ID"]:
                    break
                hyp.append(token)
                state = (h, c)
        return "".join(self.vocab[lang][token] for token in hyp[1:]).replace("\u2581", " ").strip()

    def transcribe(self, samples: np.ndarray, lang: str) -> tuple[str, list[Word]]:
        from faster_whisper.vad import get_speech_timestamps

        with self.lock:
            speech = get_speech_timestamps(samples, sampling_rate=16000)
            if sum(item["end"] - item["start"] for item in speech) / 16000 < 0.2:
                return "", []
            try:
                self.load(self.model_dir)
                with self.torch.inference_mode():
                    signal, length = self.models["preprocessor"](
                        input_signal=self.torch.from_numpy(
                            np.asarray(samples, dtype=np.float32)[None]
                        ),
                        length=self.torch.tensor([len(samples)]),
                    )
                encoded, lengths = self.models["encoder"].run(
                    ["outputs", "encoded_lengths"],
                    {"audio_signal": signal.cpu().numpy(), "length": length.cpu().numpy()},
                )
                ctc_words = self._ctc_decode(encoded, lengths, lang)
                # Encoder frame rounding may exceed the clip duration by less than one frame.
                duration = len(samples) / 16000
                for word in ctc_words:
                    word.start, word.end = min(word.start, duration), min(word.end, duration)
                text = " ".join(self._rnnt_decode(encoded, lengths, lang).split())
                words = align_words(text, ctc_words)
                self.status = "ready"
                return text, words
            except Exception:
                self.status = "error"
                raise RuntimeError("indic_inference_failed") from None
