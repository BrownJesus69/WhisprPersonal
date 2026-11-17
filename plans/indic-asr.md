# Indic ASR: AI4Bharat IndicConformer for Kannada, Hindi and Tamil

Working directory: `E:\Whispr`. The change is in `server/` (Python 3.12, FastAPI). Run from
`server/`:

- `./.venv/Scripts/python -m pytest -q -p no:cacheprovider --basetemp=E:/whispr-build-cache/pytest-indic`
- `./.venv/Scripts/python -m ruff check .`
- `./.venv/Scripts/python -m ruff format --check .`

Read `E:\Whispr\AGENTS.md` first and follow it: secrets, fail closed, no network in tests, error
shape, structured logs, no git commits.

## Why (measured by the architect on the owner's own recordings)

Whisper large-v3-turbo produced garbage for the owner's Kannada even when forced to `kn`, and
dropped half of their Hindi. AI4Bharat IndicConformer 600M (MIT licence; the gated terms were
accepted by the owner) produced coherent, near-complete text for both, at about 1.6 to 1.9 s per
10 s chunk on the CPU.

- Kannada (RNNT decoding): ಇವಾಗ ಕನ್ನಡದಲ್ಲಿ ಮಾತಾಡೋಕ್ಕೆ ಹೋಗ್ತಿದ್ದೀವಿ ಕನ್ನಡ ಅರ್ಥ ಮಾಡಿಕೊಳ್ತಾ …
- Hindi (RNNT decoding): अब हम हिंदी में बात करने जा रहे हैं …

RNNT text was slightly better than CTC text; CTC gives word timestamps.

## Facts you need

- The model is already downloaded, pinned to revision
  `2a77d305038dfc502fd9464e7d028b90381976cb`, at
  `server/models/models--ai4bharat--indic-conformer-600m-multilingual/snapshots/2a77d305038dfc502fd9464e7d028b90381976cb/`.
  It contains `assets/` (ONNX files, `preprocessor.ts`, `vocab.json`, `language_masks.json`),
  `config.json` (`BLANK_ID` 256, `RNNT_MAX_SYMBOLS` 10, `PRED_RNN_LAYERS` 2,
  `PRED_RNN_HIDDEN_DIM` 640, `SOS` 256) and the reference implementation `model_onnx.py`.
  Read `model_onnx.py`. **Do not import or execute it at runtime.** Re-implement the needed
  logic in our own module, using only `torch`, `onnxruntime`, `numpy` and `json`; no
  `transformers`, no `snapshot_download`, no network. Credit "AI4Bharat IndicConformer (MIT)" in
  a comment.
- `server/.venv` now has `torch==2.14.1+cpu` (installed by the architect) and
  `onnxruntime==1.32.0`. Do not install anything.
- Engine boundary: `app/services/transcription.py` defines `TranscriptionEngine`
  (`load_audio`, `speech_seconds`, `detect`, `transcribe(clip, profile, language, hotwords,
  on_segment) -> EngineOutput(raw_text_full, words: list[Word])`) and `FasterWhisperEngine`.
  `app/main.py` builds `app.state.engine = FasterWhisperEngine(...)`.
- `app/workers/transcription_worker.py` calls `engine.transcribe(clip, profile,
  decision.language, hotwords, partial)` and then stitches chunk seams **by word timestamps**
  (`to_absolute(output.words, chunk_start_ms)`, `render`, `restitch`). Chunks overlap by about
  1.2 s, so words need real times. The dictation router (`app/routers/dictation.py`) also uses
  `worker.engine.transcribe`.
- Language detection stays on Whisper (`detect`). Auto mode is unchanged.

## What to build

1. `app/services/indic_asr.py` with an `IndicConformer` class.
   - `load(model_dir)`:
     - the TorchScript preprocessor, on CPU (`torch.jit.load(..., map_location='cpu')`);
     - ONNX sessions with `CPUExecutionProvider` for the encoder, `ctc_decoder`,
       `rnnt_decoder`, `joint_enc`, `joint_pred`, `joint_pre_net`, and `joint_post_net_<lang>`
       **only for the enabled languages**;
     - the vocab and language masks.

     Load lazily on first use and keep it loaded. Guard it with a lock, and serialize inference
     with the worker's existing executor as the Whisper engine does.
   - `transcribe(samples: np.ndarray float32 16 kHz, lang) -> (text, words)`:
     - encode once;
     - CTC decode with word timestamps (port `compute_timestamps('w')`, frame 0.08 s);
     - RNNT greedy decode (port `_rnnt_decode`).

     Text is the RNNT text. Words come from the RNNT words with times from CTC: if the word
     counts match, take the times by index. Otherwise spread the RNNT words across the CTC speech
     span (first CTC word start to last CTC word end) in proportion to character length. Return
     `Word(start_s, end_s, text, index)` objects compatible with `app/services/overlap.py`.
   - Run faster-whisper's VAD (`get_speech_timestamps`) first. If it finds under 0.2 s of speech,
     return empty, so silence never produces text. The worker already checks `speech_seconds`;
     keep the engine safe on its own too.
2. A `CompositeEngine` in `app/services/transcription.py` (or a new module) implementing
   `TranscriptionEngine`.
   - It delegates everything to `FasterWhisperEngine`, except `transcribe` when
     `language in settings.indic_asr_languages` and the Indic model is available. In that case it
     uses IndicConformer, emits a single `SegmentOut` for the chunk via `on_segment`, and
     ignores `hotwords` (log at debug that personal words do not apply).
   - If the Indic model fails to load or run, log a warning (`event: "indic_asr_failed"`, with no
     transcript text) and fall back to Whisper for that chunk. Never fail the chunk because of
     the Indic path.
   - Wire it in `app/main.py`.
3. Settings (`app/config.py` plus `.env.example`; do not touch `.env`):
   - `INDIC_ASR_ENABLED` (default `true`);
   - `INDIC_ASR_MODEL_DIR` (default: the pinned snapshot path above, relative to `MODELS_DIR`);
   - `INDIC_ASR_LANGUAGES` (default `kn,hi,ta`, validated against the server's supported
     languages).

   Availability means enabled, `torch` and `onnxruntime` importable, and the model dir holding
   the required files. Unavailable means `not_configured`, Whisper is used, and nothing errors
   (this matters for the Docker image, which has no torch).
4. Health (`/health`): add
   `indic_asr: {"status": "ready"|"not_loaded"|"not_configured"|"error", "languages": [...],
   "model": "ai4bharat/indic-conformer-600m-multilingual"}`.
   - Never include paths.
   - Update the response schema and the app's health type only if the app's type is strict.
     Check `android/src/lib/server/types.ts`; if the app parses health loosely, leave the app
     alone.
5. `docs/api.md` and `server/README.md`: document the routing, the settings, that personal words
   do not apply to Indic-routed chunks, and that the Docker image does not include it.
6. `server/requirements-windows-gpu.txt`: add `torch==2.14.1` with a comment that the CPU wheel
   comes from `https://download.pytorch.org/whl/cpu`.
7. `server/scripts/indic_asr_check.py`: a manual check, **not** run by pytest. It runs the
   composite engine on every `.wav` under `data/audio/<session>/` for a given session id and
   language, and prints the text and the per-chunk time.

## Tests (pytest; no network; never load the real model)

Use fake ONNX sessions and a fake preprocessor.
- RNNT and CTC decoding, using small synthetic logits.
- Word-time alignment, for equal and unequal word counts.
- Routing:
  - `kn`, `hi` and `ta` go to Indic;
  - `en` goes to Whisper;
  - a language outside the enabled list goes to Whisper.
- Fallback to Whisper on a load error and on a run error, with no text in the logs (`caplog`).
- `not_configured` when torch is missing (monkeypatch the import) or files are missing.
- Silence returns empty.
- The health field is present and has no paths.
- The dictation endpoint uses the composite engine.
- The worker still stitches seams correctly with Indic words.

## Constraints

- Follow `AGENTS.md`. Never open, print, copy or modify `secrets/`,
  `android/app/google-services.json`, or any `.env`. Do not modify `.gitignore` or `AGENTS.md`.
  Do not run `git commit` or `git push`, and do not change git config.
- No new dependencies beyond the already-installed `torch`. No network. Do not modify files under
  `server/models/`.
- Keep the existing behaviour for English and auto mode.

## Done when

- `pytest`, `ruff check` and `ruff format --check` pass.
- The final message lists:
  - each changed file with its reason;
  - anything not done;
  - the exact command the architect should run for `scripts/indic_asr_check.py` on session
    `ses_fcfd170078984cedb8bb2071` (Kannada) and `ses_c19c3dcf89af41a28586af32` (Hindi).
