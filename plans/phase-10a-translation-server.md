# Phase 10a — Local-first translation: IndicTrans2 service, LibreTranslate fallback, Groq audio emergency fallback

**Working directory:** `E:\Whispr`. Read `E:\Whispr\AGENTS.md` (wins). **No network** in your
sandbox. Never write temp output into `E:\Whispr\output\`. Do not touch `secrets/`, any `.env`
(edit `.env.example` files only), `.gitignore`, `AGENTS.md`, `android/` (that is Phase 10b). Do
not run `git commit`. No new dependencies beyond what is already installed in each venv.

## Owner's translation rules (verbatim intent — all mandatory)
- **No Google Cloud Translation**, no Google billing, no Google translation key anywhere.
- Primary engine **AI4Bharat IndicTrans2**, self-hosted, separate FastAPI service on **port
  8100**, never a dependency of core transcription. kn, ta, hi, en; Indic→English,
  English→Indic, Indic→Indic.
- Fallback **self-hosted LibreTranslate (Argos)** only for pairs IndicTrans2 does not cover
  well; **never** the public libretranslate.com / API-key path; **not enabled for any pair
  until benchmarked**.
- Emergency **Groq `/audio/translations`** only when local Whisper is unavailable; audio →
  English only; never text-to-text; respect rate limits; queue.
- Optional LLM polishing (Groq → SambaNova) **only after** a dedicated engine produced a
  translation; labelled **AI-polished**; never overwrites the original transcript or the
  dedicated translation. An LLM is never the authoritative translator.
- Preserve the original transcript permanently; store translations separately; label every
  translation with engine, model, source language, target language, timestamp; no translation
  during live transcription by default; translate finalized chunks / completed transcript only;
  if unavailable, show the original + a non-blocking warning.

## Verified facts (architect, 2026-11-16)
- Models (HF, MIT, **gated** — owner accepts terms and runs `hf auth login`; never put a token
  in code/config/logs): `ai4bharat/indictrans2-en-indic-1B` @
  `89cd0007fd7b9e0693a2fd4404d187e07dac79fd`, `ai4bharat/indictrans2-indic-en-1B` @
  `ac3daf0ecd37be3b6957764a9179ab2b07fa9d6a`, `ai4bharat/indictrans2-indic-indic-1B` @
  `24d732922a0a91d0998d5568e3af37b7a21cd705`. Files: `config.json`,
  `configuration_indictrans.py`, `modeling_indictrans.py`, `tokenization_indictrans.py` (if
  present), `dict.SRC.json`, `dict.TGT.json`, `model.SRC`, `model.TGT`,
  `generation_config.json`, `model.safetensors` (+ a duplicate `pytorch_model.bin` — never
  download it). They require `trust_remote_code=True` → **always pass the pinned `revision`**.
- FLORES codes: kn `kan_Knda`, ta `tam_Taml`, hi `hin_Deva`, en `eng_Latn`.
- `IndicTransToolkit` has no Windows wheel; the architect ported its `IndicProcessor` to pure
  Python: `translator/app/indic_processor.py` (MIT attribution + `INDICTRANSTOOLKIT_LICENSE`).
  Verified: `preprocess_batch(['ನಮಸ್ಕಾರ, ಇಂದು ಸಭೆ 2.30ಕ್ಕೆ ಇದೆ.'], src_lang='kan_Knda',
  tgt_lang='eng_Latn')` → `['kan_Knda eng_Latn नमस्कार , इंदु सभॆ < ID1 > इदॆ .']`. Use it as
  the reference HF usage does: preprocess → tokenizer → `model.generate(num_beams=5,
  max_length=256, ...)` → `tokenizer.batch_decode(skip_special_tokens=True)` →
  `ip.postprocess_batch(..., lang=tgt)`. Do not edit the port's logic.
- `translator/.venv` (Python 3.12): torch 2.14.1+cu126 (CUDA available, RTX 4080 Laptop 12 GB),
  transformers 5.23.0, sentencepiece, sacremoses, regex, indic-nlp-library-itt, sacrebleu,
  fastapi, uvicorn, pydantic-settings, httpx, pytest, ruff (`translator/requirements.txt`).
  Whether IndicTrans2's remote code runs on transformers 5.x is **unverified** (models not yet
  downloaded) — code must not depend on version-specific internals beyond the documented usage.
- LibreTranslate 1.9.6 in `translator/libretranslate/.venv`; its Argos data lives **outside the
  repo** at `E:/whispr-models/argos/{share,config,cache}` via `XDG_DATA_HOME`,
  `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` (keep all model data out of git). The Argos
  index has **only en→hi and hi→en** among kn/ta/hi (installed). No Kannada or Tamil packs.
  Smoke: hi→en rendered "ढाई बजे" as "Dai PM" — benchmark gating matters.
- Groq audio translation: `POST {GROQ_BASE_URL}/audio/translations` multipart (`file`, `model`,
  optional `prompt` ≤ 224 tokens, `response_format` json|verbose_json|text, `temperature`),
  English only, 25 MB direct-upload cap; Groq docs list `whisper-large-v3` as the only
  translation-capable model — still **configure it** (`GROQ_AUDIO_TRANSLATION_MODEL`), no
  default.

## A. Translator service `translator/` (separate process, own venv, port 8100)
- `app/config.py` (pydantic-settings, prefix `TRANSLATOR_`): host **127.0.0.1** (refuse to
  start on a non-loopback host unless `TRANSLATOR_ALLOW_LAN=true`), port 8100, `shared_secret:
  SecretStr|None` (header `X-WhisprPersonal-Translator-Key`; **fail closed** with 503
  `translator_not_configured` when unset), model repo ids + pinned revisions (defaults above),
  `hf_cache_dir` (default `E:/whispr-models/hf-cache`, outside the repo; env-configurable),
  `local_files_only=true` (never download at runtime), device `cuda|cpu|auto`, dtype
  `float16` on CUDA, `num_beams=5`, `max_length=256`, `batch_size=8`, `max_segment_chars=1000`,
  `max_segments=500`, `idle_unload_s=300`.
- `app/engine.py`: `IndicTrans2Engine` — lazily loads **one direction at a time** (en-indic,
  indic-en, indic-indic) behind a lock, unloads after idle, runs generation in a worker thread
  (never on the event loop), splits long segments at sentence boundaries
  (`indicnlp.tokenize.sentence_tokenize` with the iso code; fall back to the whole text) and
  rejoins. `status()` per direction: `not_downloaded | ready_on_disk | loaded | error`
  (detect files in the HF cache without network). Map errors to codes:
  `model_not_downloaded`, `unsupported_pair`, `cuda_oom` (retry once on CPU only if configured),
  `translation_failed`.
- `app/main.py`: `GET /health` (no secret; statuses only), `POST /translate`
  `{source_lang, target_lang, segments: [{id, text}]}` → `{engine: "indictrans2", model:
  "<repo>@<rev7>", source_lang, target_lang, segments: [{id, text}], created_at}`; same-language
  requests → 422 `same_language`; pairs among kn/ta/hi/en only (`unsupported_pair` otherwise).
  Error envelope identical to the main server's. Logs: counts and durations only, never text.
- `scripts/download_models.py`: `huggingface_hub.snapshot_download(repo_id, revision=<pinned>,
  cache_dir=<hf_cache_dir>, allow_patterns=[*.json, *.py, model.SRC, model.TGT,
  model.safetensors])`; uses the owner's existing HF login implicitly; prints a clear message on
  `GatedRepoError` ("accept the terms at <url> and run `hf auth login`") — never accepts tokens
  as arguments or prints them.
- `scripts/benchmark.py`: runs a fixed built-in evaluation set
  (`benchmark_data.json`: ≥ 12 short conversational/event sentences per language in kn, ta, hi
  with English references, plus the same English sentences for en→X; write them carefully,
  numbers/times/names included) through every available engine (IndicTrans2 via the service,
  LibreTranslate via `http://127.0.0.1:5000/translate` if running), computes **chrF**
  (`sacrebleu`) and median latency per pair, and writes
  `translator/benchmarks/latest.json` `{created_at, engines: {name: {pair: {chrf, latency_ms,
  n}}}, recommendation: {pair: engine}}`. A LibreTranslate pair is *eligible* only if its chrF
  ≥ `0.9 × IndicTrans2 chrF` for that pair (or IndicTrans2 is unavailable for it) and ≥ 35.
- `run_translator.ps1` / `run_libretranslate.ps1` (repo-relative paths, E: data dirs,
  `--host 127.0.0.1 --port 5000 --load-only en,hi --disable-web-ui` for LibreTranslate; never
  `--api-keys` public mode, never the public URL).
- `pyproject.toml` (ruff line length 100, pytest config). Tests (`translator/tests`) with a
  **fake model** (no torch model loading): routing per pair, same-language, unsupported pair,
  shared-secret fail-closed, loopback enforcement, sentence split/rejoin, idle unload,
  status without network, download script refuses token args, benchmark chrF/eligibility math
  with injected engines. Opt-in real test `TRANSLATOR_RUN_MODEL_TESTS=1` that translates the
  kn/ta/hi samples (architect runs it after download).

## B. Main server orchestration (`server/`)
- Config: `translator_url` (default `http://127.0.0.1:8100`), `translator_shared_secret`
  (SecretStr), `translator_timeout_s=60`, `libretranslate_url` (default
  `http://127.0.0.1:5000`, **loopback only**, reject public hosts like libretranslate.com),
  `libretranslate_enabled_pairs: list[str] = []` (e.g. `hi-en`), `translation_benchmark_path`
  (default `../translator/benchmarks/latest.json`), `groq_audio_fallback_enabled=false`,
  `groq_audio_translation_model: str|None = None`. `.env.example` + `test_config.py`.
- `app/services/translation/`: `TranslatorClient` (IndicTrans2 service), `LibreTranslateClient`
  (`POST /translate {q, source, target, format:"text"}`), `TranslationRouter`: for a pair use
  IndicTrans2 if available; else LibreTranslate **only if** the pair is in
  `libretranslate_enabled_pairs` **and** the benchmark file marks it eligible (re-read, cached
  by mtime) — otherwise `translation_unavailable`. Health/status never block (≤ 2 s loopback
  probe, cached 30 s).
- Store migration 6: `translations(session_id, sequence, target_lang, source_lang, text,
  engine, model, created_at, polished_text, polish_provider, polish_model, polished_at,
  error_code, PRIMARY KEY(session_id, sequence, target_lang))` and
  `translation_jobs` (same columns/lifecycle as `ai_jobs`: queued|running|done|failed|
  interrupted, interrupted on restart, never auto re-run). Deleting a session cascades.
- Job (reuse the AI job queue pattern; separate queue + worker, one at a time): for each
  finalized session owned by uid+event, each `done`, non-no-speech chunk: source =
  `detected_language` (override if present); skip `language_uncertain`/unknown with
  `source_unknown`; skip source == target (`same_language`); batch by language to the router;
  store results per chunk with labels. Original `raw_text` is never touched. Optional
  `polish: true` → after the dedicated translation, call the existing `ProviderRouter` (cloud
  only if the event is `cloud_ai`, Groq → SambaNova; local LLM allowed for local_only) with a
  prompt that improves fluency **of the given translation only**, must keep meaning, must not
  add content; validate (marker per chunk, similarity ≥ 0.6 to the dedicated translation,
  script of target unchanged); store in `polished_*` columns; failures keep the dedicated
  translation unchanged.
- Endpoints (protected, owner-only): `POST /api/v1/translate {event_id, session_ids[1..20],
  target_lang: kn|ta|hi|en, polish=false}` → 202 job (only finalized sessions; 409 otherwise;
  503 `translation_unavailable` with message "Translation unavailable; showing the original
  transcript." when no engine can serve any needed pair), `GET /api/v1/translation/jobs/{id}`,
  `GET /api/v1/sessions/{id}/translations?target_lang=` → `{session_id, target_lang, chunks:
  [{sequence, source_lang, text, engine, model, created_at, polished_text, polish_provider,
  polish_model, polished_at, error_code}]}`, `GET /api/v1/translation/status` → engines
  (indictrans2 per direction, libretranslate pairs enabled/eligible, groq_audio fallback
  configured) — booleans/status words only. Replace any old translate placeholder.
  `/health` gains a `translation` block from the cached status (no blocking calls).
- **Groq audio emergency fallback**: in the transcription worker, when a chunk fails
  **terminally** with a local-ASR-unavailable code (`load_failed`, `model_files_missing`,
  `cuda_unavailable`, `model_not_ready`) — not for audio/decode errors — and
  `groq_audio_fallback_enabled` and Groq key + `groq_audio_translation_model` are set and the
  event is `cloud_ai` (privacy gate as Phase 8a, fail closed): enqueue an audio-translation job
  (bounded queue, concurrency 1, reuse Phase 8a retry/Retry-After/circuit breaker, per-provider
  RPM if set). Upload the stored chunk WAV (≤ 25 MB else skip `file_too_large`) multipart with
  `model`, `response_format=json`, `temperature=0`; store into `translations` with
  `source_lang='und'`, `target_lang='en'`, `engine='groq-audio-translation'`, model from config;
  publish a persisted WS event `chunk_audio_translated {sequence, target_lang:'en', engine}`
  (extend the stream event union/docs; the phone fetches text via the translations endpoint).
  The chunk stays `failed` (no raw transcript was produced) — it is not a transcript.
- Never translate during live transcription; nothing runs until an explicit request, except
  the emergency fallback which only triggers on terminal local-ASR failure.
- Tests (mock HTTP via `httpx.MockTransport`, no network): router precedence; LibreTranslate
  refused when not enabled / not eligible / non-loopback URL; benchmark file parsing; job
  lifecycle; labels stored; raw untouched; polish validation + failure keeps dedicated
  translation; privacy gates; Groq audio fallback triggers only on the listed codes, only when
  enabled + configured + cloud_ai, multipart payload exact, 25 MB guard, 429 Retry-After,
  breaker; endpoints auth/ownership; `/health` non-blocking. All existing tests stay green.

## C. Docs
`docs/translation.md` (new: architecture, engines, privacy, labels, how to download models
after accepting HF terms, how to run both services, benchmark procedure and how a pair gets
enabled, Groq audio fallback conditions, troubleshooting), `docs/api.md`, `docs/architecture.md`,
`docs/security.md` (loopback-only services, shared secret, gated-model token stays in the HF
login only, no Google), `docs/setup.md`, `server/.env.example`, `translator/README.md`.

## Done when
`translator` tests + ruff green; server tests + ruff green; with no models downloaded the
translator reports `not_downloaded`, the server reports translation unavailable without errors,
and transcription is unaffected. Report files changed, test counts, deviations.
