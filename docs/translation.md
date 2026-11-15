# Local-first translation (Phase 10a)

Core transcription does not require a translator, translation model, cloud key, or translation
process. Nothing translates live text by default. Owners explicitly request translation of
finalized sessions, including completed chunks of partial finalized transcripts. Original
`raw_text` and `raw_text_full` remain unchanged. A failed engine returns the non-blocking warning
**Translation unavailable; showing the original transcript.** Display the original alongside it.
Phone UI is available in Phase 10b: finalized sessions and saved transcripts offer a target
picker and a separately labelled Translation tab; optional export inclusion defaults off.

## Engines and labels

1. A separate FastAPI process on `127.0.0.1:8100` serves self-hosted AI4Bharat IndicTrans2.
   Kannada (`kn`), Tamil (`ta`), Hindi (`hi`), and English (`en`) support all directed pairs
   except same-language requests. FLORES codes are `kan_Knda`, `tam_Taml`, `hin_Deva`, `eng_Latn`.
   Only one direction resides in memory, serialized behind a lock; inference runs in a thread.
   Sentence splitting uses the source ISO code. The processor port is used unchanged:
   preprocess → tokenize → generate (5 beams, max length 256) → decode → postprocess.
2. Self-hosted LibreTranslate/Argos on `127.0.0.1:5000` is eligible only for benchmarked,
   explicitly enabled pairs when IndicTrans2 cannot serve them. The installed packs support
   only `en-hi` and `hi-en`; there are no Kannada/Tamil packs. Never use a public instance,
   `libretranslate.com`, Google Cloud Translation, a Google billing project, or a translation key.
3. Groq `/audio/translations` is an emergency audio-to-English path, described below. It is
   never used for text-to-text translation.

SQLite migration 6 stores translations separately, keyed by session, chunk sequence, and target.
Every successful result carries engine, model, source/target language and UTC timestamp.
IndicTrans2 labels the pinned repo plus revision prefix; LibreTranslate labels its model family
`argos` (not an individual pack version). Unknown/uncertain source rows get `source_unknown`;
same-language rows get `same_language`. Per-chunk language overrides take priority. Silent and
failed chunks are excluded from text jobs. A failed repeat request preserves an earlier success.
Deleting a session cascades its translations and linked jobs, including multi-session jobs.

Optional `polish:true` runs only after a dedicated engine succeeds. The existing provider router
uses Groq → SambaNova → local LLM, with cloud disabled for `local_only`. Privacy is checked again
before each polish request. Markers, similarity ≥ 0.6, length bounds and target script must pass.
`polished_text`, provider, model and timestamp are separate; display them as **AI-polished**.
Provider or validation failures leave the dedicated translation intact. No LLM is authoritative.

## Download pinned gated models

The owner must accept each model's HF terms and run `hf auth login` outside the sandbox.
Authentication stays in the existing HF login; no token flags, code, config or logs.

| Repo | Pinned revision |
| --- | --- |
| `ai4bharat/indictrans2-en-indic-1B` | `89cd0007fd7b9e0693a2fd4404d187e07dac79fd` |
| `ai4bharat/indictrans2-indic-en-1B` | `ac3daf0ecd37be3b6957764a9179ab2b07fa9d6a` |
| `ai4bharat/indictrans2-indic-indic-1B` | `24d732922a0a91d0998d5568e3af37b7a21cd705` |

From `translator/`, using its existing venv:

```powershell
.\.venv\Scripts\python.exe -m scripts.download_models
```

This explicit owner command downloads JSON/Python metadata, SentencePiece files and
`model.safetensors`, never the duplicate `pytorch_model.bin`. The default HF cache is
`E:/whispr-models/hf-cache`, outside the repo. Change it with `TRANSLATOR_HF_CACHE_DIR`.
Remote code always receives the full pinned revision and `trust_remote_code=True`.
Runtime loads always use `local_files_only=True`; absent files report `not_downloaded`.

## Run services

Provide the same private shared secret through `TRANSLATOR_SHARED_SECRET` in each process's
environment. It is a `SecretStr` and travels only in `X-WhisprPersonal-Translator-Key` on the
loopback call. Missing service secret fails closed with 503 `translator_not_configured`.
Missing server-side secret disables its IndicTrans2 client. No credentials are shown in health.

From the repository root, in separate terminals:

```powershell
.\translator\run_translator.ps1
.\translator\run_libretranslate.ps1
```

The translator launcher validates `TRANSLATOR_HOST` (default `127.0.0.1`) and
`TRANSLATOR_PORT` (8100). A non-loopback host requires explicit `TRANSLATOR_ALLOW_LAN=true`;
use the launcher, rather than overriding host via a separate Uvicorn CLI. The main server
accepts only loopback URLs for both engines and follows no redirects or environment proxies.
LibreTranslate runs with `--load-only en,hi --disable-web-ui`, without `--api-keys`.
Its XDG data/config/cache live at `E:/whispr-models/argos/{share,config,cache}`.
Do not install/download packs during runtime or put model files in git.

Other translator environment settings use the `TRANSLATOR_` prefix: `DEVICE=auto|cuda|cpu`,
`DTYPE=float16|float32` (CPU always float32), `NUM_BEAMS=5`, `MAX_LENGTH=256`, `BATCH_SIZE=8`,
`MAX_SEGMENT_CHARS=1000`, `MAX_SEGMENTS=500`, `IDLE_UNLOAD_S=300`.
`CPU_RETRY_ON_OOM=false` enables one CPU retry only when explicitly set true.
Service errors are `model_not_downloaded`, `unsupported_pair`, `same_language`, `cuda_oom`,
or `translation_failed`; no exception payloads or transcript text are logged.

## Benchmark and enable a fallback pair

Run both services and, from `translator/`:

```powershell
.\.venv\Scripts\python.exe -m scripts.benchmark
```

The fixed `benchmark_data.json` has 12 aligned event/conversation sentences per language,
including names, numbers, times and punctuation. The report at `translator/benchmarks/latest.json`
contains corpus chrF, median per-sentence latency and sample counts for available pairs.
Missing engines/packs have no score. LibreTranslate is eligible only if chrF ≥ 35 and
chrF ≥ 90% of IndicTrans2 for that pair, or IndicTrans2 is unavailable for that pair.
IndicTrans2 stays primary even if LibreTranslate scores higher.

Review the translations and report, then explicitly set `LIBRETRANSLATE_ENABLED_PAIRS=hi-en`
(or another eligible directed pair) in the server process environment. The server rereads the
report by mtime and independently checks scores and a minimum 12 samples. Missing, malformed,
deleted or failing reports disable fallback; an enabled-pair list alone cannot authorize it.
Cached, bounded `/languages` probes also confirm the self-hosted process serves the pair.
No pairs are shipped enabled and no measured scores are fabricated.

## Emergency audio fallback

Enable only with `GROQ_AUDIO_FALLBACK_ENABLED=true`, an existing `GROQ_API_KEY`, and an explicit
`GROQ_AUDIO_TRANSLATION_MODEL`. There is no default model ID. The owner-verified Groq documentation
lists `whisper-large-v3` as translation capable; configure it explicitly when desired.
This path works independently of the text LLM model setting.

Only a **terminal** local-ASR failure with `load_failed`, `model_files_missing`,
`cuda_unavailable`, or `model_not_ready` can enqueue it. Decode/audio errors never trigger it.
Event ownership and `cloud_ai` privacy must be verified before admission and each upload/retry;
unknown/offline consent fails closed. Uploads use multipart WAV, model, `response_format=json`,
`temperature=0`, with no prompt. Stored non-WAV uploads are decoded to WAV in a worker thread.
Both original input and final WAV are capped at 25,000,000 bytes. Oversize yields `file_too_large`.

An independent bounded queue has one audio consumer. Groq capacity, optional RPM and breaker
are shared with Phase 8a; retries respect Retry-After and existing retry bounds. WAV snapshots
are kept only in bounded process memory before finalization retention can delete the source.
Queued/running jobs become `interrupted` on restart and never automatically run again.

Results have `source_lang=und`, `target_lang=en`, engine `groq-audio-translation` and the configured
model. The original chunk remains failed without a raw transcript. The persisted WebSocket event
`chunk_audio_translated` includes sequence/target/engine, never text; fetch the owner-only
translations endpoint for text. No emergency result is represented as a transcript.

## Checks and troubleshooting

Run `python -m pytest -q`, `python -m ruff check .` and `python -m ruff format --check .`
inside each existing venv and project directory. Tests deny network and use fake generation and
HTTP MockTransport. Set `TRANSLATOR_RUN_MODEL_TESTS=1` for the owner-run offline real-model test
after downloading. It tests Kannada/Tamil/Hindi → English and fails if any Indic script leaks
into the English output.

### Verified on this laptop (2026-11-16, RTX 4080 Laptop 12 GB)

- **Transformers must be 4.x** (`4.57.6` pinned): IndicTrans2's remote code imports
  `transformers.onnx`, which 5.x removed. Generation runs with `use_cache=False` because the
  remote code indexes legacy tuple caches and crashes on 4.57's Cache objects; measured
  ~0.15–0.18 s per sentence, ~2.2 GB VRAM per loaded direction (one direction at a time).
- Digits glued to an Indic suffix (`2.30ಕ್ಕೆ`) are split before preprocessing; otherwise the
  numeral placeholder swallowed the suffix and Kannada leaked into English output
  (`"at 2.30ಕ್ಕೆ Bangalore"` → now `"The meeting will begin at 2:30 p.m."`).
- Remote-code modules are cached at `E:/whispr-models/hf-modules` (not the C: profile); the
  service sets `HF_HUB_OFFLINE=1` before loading.
- Live service over HTTP: kn→en, en→ta and ta→hi translated correctly, labelled with the pinned
  `repo@revision`; a wrong shared secret returns 401 `invalid_translator_key`.
- Benchmark (`translator/benchmarks/latest.json`, 12 sentences per language, chrF): IndicTrans2
  69.5–87.1 on all 12 kn/ta/hi/en pairs. LibreTranslate en→hi 70.5 (not eligible: < 90 % of
  IndicTrans2's 87.1), hi→en 72.6 (eligible: 95 % of 76.7). Recommendation: IndicTrans2 for every
  pair; LibreTranslate stays disabled unless `hi-en` is explicitly added to
  `LIBRETRANSLATE_ENABLED_PAIRS`. The evaluation set is small and simple — treat scores as
  relative, not absolute quality.

- `not_downloaded`: download all required files for the exact revision into the configured cache.
- `translator_not_configured`: supply the shared secret privately to both processes.
- `error` / `translation_failed`: check model/cache compatibility; health never exposes paths/text.
- `cuda_oom`: unload other GPU workloads, use CPU, or explicitly enable one CPU retry.
- No LibreTranslate fallback: check installed directed packs, report eligibility and enabled list.
- Cloud fallback absent: check terminal code, explicit configuration and current event privacy.
- Core transcription works with both services stopped; `/health` reads cached translation status
  only. Loopback status probes run separately, bounded to two seconds and cached for 30 seconds.
