# Phase 3 — Whisper transcription engine (server)

**Working directory:** `E:\Whispr`. Server code: `E:\Whispr\server`.
**Read `E:\Whispr\AGENTS.md` first and obey every non-negotiable.** Phases 1–2 are committed:
read the existing code and follow its patterns (pure-ASGI middleware, `AppError`/`ErrorCode`,
`authenticated_user` dependency = server key → Firebase token → per-user rate limit,
`require_owner` / `require_event_owner`, `DocId`, offline `conftest.py` with `no_network`).
Project name: **WhisprPersonal**.

## Goal

Chunked, durable, GPU-serialized transcription: Android uploads audio chunks over HTTP
multipart; the server persists them, queues them in SQLite, runs VAD → language decision →
faster-whisper `large-v3-turbo` on one worker, preserves raw text, streams partial and final
results over a WebSocket with resume, and writes finalized results to Firestore.

## Out of scope

LLM cleanup/briefs/translation (Phase 8, never call any LLM here), Android code, export,
App Check. Vocabulary *replacements* are stored but NOT applied to transcripts in this phase.

## Facts verified by the architect on this machine (do not re-derive; do not reinstall)

Installed in `server/.venv`: `faster-whisper==1.2.1`, `ctranslate2==4.9.0`, `av==17.0.0`,
`onnxruntime==1.32.0`, `numpy==2.5.4`, `huggingface_hub==2.4.0`; Windows-only GPU runtime
wheels `nvidia-cublas-cu12==12.9.2.10`, `nvidia-cudnn-cu12==9.28.1.4`.

1. **Pin `av==17.0.0`** in requirements.txt with a comment: av 19 removed the
   `metadata_errors` kwarg that `faster_whisper.decode_audio` passes → every decode fails.
2. **Windows CUDA DLLs:** ctranslate2 loads cuBLAS/cuDNN lazily. Before importing
   `ctranslate2`/`faster_whisper`, for every `<site-packages>/nvidia/*/bin` directory call
   `os.add_dll_directory(d)` **and** prepend it to `os.environ["PATH"]` (PATH is required;
   `add_dll_directory` alone fails with "cublas64_12.dll is not found"). No-op on non-Windows
   or if the dirs don't exist (Docker image has CUDA libs system-wide).
3. Model alias `"large-v3-turbo"` → `mobiuslabsgmbh/faster-whisper-large-v3-turbo`; fallback
   `"large-v3"` → `Systran/faster-whisper-large-v3`. The turbo model is already downloaded to
   `E:\Whispr\server\models` (download_root). Load = 1.5 s with `local_files_only=True`.
4. APIs: `WhisperModel(model_size_or_path, device='auto', device_index=0,
   compute_type='default', cpu_threads=0, num_workers=1, download_root=None,
   local_files_only=False, ...)`;
   `WhisperModel.detect_language(audio=None, features=None, vad_filter=False,
   vad_parameters=None, language_detection_segments=1, language_detection_threshold=0.5)
   -> (lang, prob, [(lang, prob), ...])` (sorted desc);
   `WhisperModel.transcribe(audio, language=None, ..., beam_size, ...,
   condition_on_previous_text, ..., word_timestamps, ..., vad_filter, vad_parameters, ...,
   hotwords, ...) -> (generator[Segment], TranscriptionInfo)` — the generator decodes lazily;
   `Segment.words[i].start/end` and segment start/end are **numpy.float64** seconds → cast to
   `float`/int ms before JSON. `info.duration`, `info.duration_after_vad`.
   `faster_whisper.decode_audio(input_file, sampling_rate=16000, split_stereo=False)` →
   float32 mono ndarray (handles .wav and AAC .m4a — verified).
   `faster_whisper.vad.get_speech_timestamps(audio, vad_options=None, sampling_rate=16000)`
   → list of `{start, end}` sample dicts; `VadOptions` dataclass.
   `faster_whisper.utils.download_model(size_or_id, output_dir=None, local_files_only=False,
   cache_dir=None, ...)`. Use `cache_dir=models_dir` so it matches `download_root`.
   Language codes: `faster_whisper.tokenizer._LANGUAGE_CODES` includes kn, ta, hi, en, te, ml,
   mr, bn, gu, pa.
5. Measured on RTX 4080 (float16): 16 s English speech → detect 0.16 s (warm), transcribe
   0.33 s, output exact. **On pure silence, `transcribe` returns no text but
   `detect_language` still returns `en` p≈0.52 → you must run VAD first and skip language
   detection when there is no speech.**
6. Windows HF cache has no symlinks: set `HF_HUB_DISABLE_SYMLINKS_WARNING=1` in the process
   before downloads.

## Files

Create:
```
server/requirements-windows-gpu.txt     # nvidia-cublas-cu12==12.9.2.10, nvidia-cudnn-cu12==9.28.1.4
server/app/models/languages.py
server/app/schemas/sessions.py
server/app/schemas/stream.py
server/app/schemas/vocabulary.py
server/app/services/cuda_windows.py
server/app/services/store.py
server/app/services/model_manager.py
server/app/services/transcription.py     # engine protocol + FasterWhisperEngine
server/app/services/language.py          # pure LanguageTracker
server/app/services/overlap.py           # pure word trimming
server/app/services/broadcaster.py
server/app/services/firestore_sync.py
server/app/workers/transcription_worker.py
server/app/routers/sessions.py
server/app/routers/stream.py
server/app/routers/vocabulary.py
server/app/tests/fakes.py               # FakeEngine, FakeEventRepo, FakeFirestoreSync, helpers
server/app/tests/test_languages.py
server/app/tests/test_language_tracker.py
server/app/tests/test_overlap.py
server/app/tests/test_store.py
server/app/tests/test_model_manager.py
server/app/tests/test_sessions_api.py
server/app/tests/test_worker.py
server/app/tests/test_stream.py
server/app/tests/test_vocabulary.py
server/app/tests/test_firestore_sync.py
server/app/tests/test_whisper_gpu.py    # opt-in real-model test (skipped by default)
```
Modify: `requirements.txt` (+ `faster-whisper==1.2.1`, `ctranslate2==4.9.0`, `av==17.0.0`,
`numpy==2.5.4`), `config.py`, `core/errors.py`, `core/request_context.py` (bind
session_id/chunk_id contextvars in routes/worker), `main.py`, `schemas/health.py`,
`routers/health.py`, `routers/diagnostics.py`, `services/state.py`, `cli.py`
(+ `download-models`), `.env.example`, `Dockerfile` (no change needed unless required),
`scripts/start.ps1` + `start.sh` (wait for model ready), `pyproject.toml` (register pytest
marker `gpu`), docs (`api.md`, `architecture.md`, `setup.md`, `security.md`,
`event-runbook.md` language-test section), `README.md` phase table.
Fixture already present: `server/app/tests/fixtures/en_sample.m4a` (16 s synthetic English
TTS: "Good morning everyone. Welcome to the annual technology summit in Bengaluru. ...").

## Design

### Config (new Settings fields; add all to `.env.example` with comments)
- `whisper_compute_type` stays `float16`; if the resolved device is `cpu` and compute type is
  `float16`/`bfloat16`, use `int8` (log it).
- `whisper_beam_size: int = 5` (1–10); `whisper_local_files_only: bool = False` (set true for
  offline events after `download-models`); `whisper_preload: bool = True`;
  `whisper_max_loaded_models: int = 1` (1–2).
- `supported_languages: list[str]` (comma list) default `kn,ta,hi,en`; each must be in
  `_LANGUAGE_CODES` (validate at startup; config error otherwise).
- Language tuning: `language_detect_window_s: float = 15` (10–20),
  `language_lock_min_chunks: int = 2`, `language_lock_threshold: float = 0.6`,
  `language_uncertain_threshold: float = 0.5`, `language_switch_threshold: float = 0.8`,
  `language_switch_consecutive: int = 2`.
- `max_chunk_duration_s: int = 30`, `max_overlap_ms: int = 3000`, `chunk_max_attempts: int = 3`,
  `chunk_retry_base_s: float = 2.0`, `shutdown_drain_timeout_s: float = 20`
  (must stay < compose `stop_grace_period` 30 s), `server_audio_retention:
  Literal["keep","delete_on_finalize"] = "keep"`, `firestore_sync_retry_s: int = 60`,
  `allowed_audio_extensions` default `m4a,mp4,aac,3gp,wav,ogg,webm,flac,mp3`.
- `vocabulary_max_terms: int = 200`, hotwords string capped at 400 chars.

### `models/languages.py`
`LanguageCode = Annotated[str, AfterValidator(...)]` that lower-cases and requires membership in
the **configured** `supported_languages` (validate in the route using settings, since validators
can't see settings — provide `validate_language(code, settings)`); `LanguageMode` = `"auto"` or
a supported code. `LANGUAGE_NAMES = {"kn": "Kannada", "ta": "Tamil", "hi": "Hindi", "en":
"English", ...}` for display. Designed so adding Indian languages = config only.

### `services/cuda_windows.py`
`prepare_cuda_dlls() -> list[str]` per fact #2; idempotent; returns dirs added (for diagnostics,
do NOT expose full paths in API — count only). Call it inside `model_manager` right before the
lazy `import faster_whisper`.

### `services/store.py` — SQLite (stdlib `sqlite3`)
- File `data_dir / "whisprpersonal.sqlite3"`; `data_dir/audio/` for chunk files. Create dirs.
- One connection (`check_same_thread=False`), `threading.Lock` around every operation, all
  public async methods use `asyncio.to_thread`. `PRAGMA journal_mode=WAL`,
  `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`. Schema versioned with
  `PRAGMA user_version` + ordered migrations list.
- Tables:
  - `sessions(id TEXT PRIMARY KEY, owner_uid, event_id, status TEXT CHECK in ('active',
    'finalizing','finalized'), transcript_status CHECK in ('pending','complete','partial'),
    model_profile CHECK in ('turbo','accurate'), model_name, language_mode, expected_languages
    (JSON), overlap_ms INT, expected_chunk_count INT NULL, tracker_state (JSON),
    firestore_sync CHECK in ('pending','synced','failed','disabled'), firestore_error,
    created_at, updated_at, finalized_at, error_code)`.
  - `chunks(session_id REFERENCES sessions ON DELETE CASCADE, chunk_id, sequence INT,
    start_ms INT, end_ms INT, overlap_ms INT, continues INT, file_name, sha256, size_bytes,
    content_type, status CHECK in ('queued','processing','done','failed'), attempts INT,
    next_attempt_at REAL, language_requested, detected_language, language_confidence REAL,
    language_source, language_uncertain INT, no_speech INT, raw_text, raw_text_full,
    segments_json, error_code, processing_ms INT, created_at, updated_at,
    PRIMARY KEY(session_id, chunk_id), UNIQUE(session_id, sequence))`; index on
    `(status, next_attempt_at, created_at)`.
  - `session_events(session_id REFERENCES sessions ON DELETE CASCADE, seq INT, type,
    payload_json, created_at, PRIMARY KEY(session_id, seq))`.
  - `vocabulary(event_id PRIMARY KEY, owner_uid, terms_json, replacements_json, updated_at)`.
  - `audit_log(id INTEGER PRIMARY KEY, ts, uid, session_id, chunk_id, action, outcome,
    duration_ms, model, detail_json)` — actions: `chunk_uploaded`, `chunk_transcribed`,
    `chunk_failed`, `session_created`, `session_finalized`, `session_deleted`,
    `language_override`, `firestore_sync`. Never store audio/transcript text in the audit log.
- `recover_on_startup()`: `processing` → `queued` (keep attempts); returns counts (logged).
- `append_event(session_id, type, payload) -> seq` assigns `MAX(seq)+1` inside the lock.
- Timestamps stored as UTC ISO strings (`next_attempt_at` as epoch float).

### `services/language.py` — pure `LanguageTracker` (no model access, fully unit-tested)
```python
@dataclass
class LanguageDecision:
    language: str | None            # None only when no_speech
    confidence: float | None        # None when forced
    source: Literal["override", "auto", "locked"]
    uncertain: bool
    detect: bool                    # whether the engine must run detect_language
    events: list[tuple[str, dict]]  # e.g. ("language_locked", {...})
```
API: `needs_detection() -> bool` (False when forced); `decide(sequence, probs:
list[tuple[str,float]] | None, speech_s: float) -> LanguageDecision`; `set_mode(mode)`;
`to_state()/from_state()` (persisted in `sessions.tracker_state` after every decision).
Rules:
- **Forced** (mode is a code, from session `language_mode` or override): language=mode,
  source="override", confidence=None, uncertain=False, no detection.
- **Auto, restricted:** if `expected_languages` non-empty, consider only those codes:
  renormalize their probs to sum 1, pick best; `confidence` = renormalized prob. If the raw
  global top-1 is outside the expected set with raw prob ≥ 0.5, set `uncertain=True` (e.g.
  Kannada misdetected as Telugu). If empty, use all `supported_languages` the same way.
- **Before lock:** language = best; uncertain if confidence < `language_uncertain_threshold`.
  Streak counts consecutive chunks with the same best and confidence ≥ `lock_threshold`,
  accumulating speech seconds. Lock when streak ≥ `lock_min_chunks` AND accumulated speech ≥
  `language_detect_window_s` → event `language_locked {language, confidence, at_sequence}`.
- **After lock:** detection still runs each chunk (cheap). If best ≠ locked and confidence ≥
  `switch_threshold`: transcribe this chunk in `best` (source="auto"), increment switch streak;
  when streak ≥ `switch_consecutive` → locked=best, event `language_changed {from, to,
  at_sequence}`. Otherwise language=locked, source="locked", reset switch streak; uncertain if
  the locked language's confidence < uncertain threshold.
- `set_mode("auto")` from a forced mode resets lock and streaks; `set_mode(code)` emits
  nothing itself (route emits `language_override`).
- Never claims accuracy: always return confidence when detection ran.

### `services/overlap.py` — pure midpoint trimming
Input: words `[(start_s, end_s, text)]` relative to chunk start, `duration_ms`,
`head_overlap_ms` (this chunk overlaps the previous one by this much), `tail_overlap_ms`
(= session `overlap_ms` when the chunk `continues`, else 0). Keep a word iff
`start_ms >= head_overlap_ms/2` (when head>0) and `start_ms < duration_ms - tail_overlap_ms/2`
(when tail>0). Return kept words, `raw_text` (joined, whitespace-normalized) and rebuilt
segments `[{start_ms, end_ms, text}]` (absolute = chunk.start_ms + relative) grouping kept words
by their original segment. `raw_text_full` = untrimmed text. Unit-test boundaries, zero overlap,
last chunk (continues=False), words exactly at midpoint.

### `services/transcription.py`
```python
class TranscriptionEngine(Protocol):
    def load_audio(self, path: Path) -> AudioClip                  # samples + duration_s
    def speech_seconds(self, clip: AudioClip) -> float             # Silero VAD (get_speech_timestamps)
    def detect(self, clip: AudioClip, profile: str) -> list[tuple[str, float]]
    def transcribe(self, clip: AudioClip, profile: str, language: str, hotwords: str | None,
                   on_segment: Callable[[SegmentOut], None]) -> EngineOutput
```
`FasterWhisperEngine(model_manager, settings)`: `transcribe(..., language=language,
vad_filter=True, word_timestamps=True, beam_size=settings.whisper_beam_size,
condition_on_previous_text=False, hotwords=hotwords)`; iterate the generator, call
`on_segment` per segment (relative ms), collect words; convert numpy floats. All methods are
**synchronous** and run only on the worker's single-thread executor (that executor *is* the GPU
lock; also hold `model_manager.lock` while using a model). Decode errors →
`EngineError("audio_decode_failed")`; duration > `max_chunk_duration_s` + overlap →
`EngineError("chunk_too_long")`; CUDA OOM / other → `EngineError("transcription_failed")`.

### `services/model_manager.py`
- `ModelManager(settings, state, model_factory=None)` — factory injectable for tests (default
  lazily imports `faster_whisper.WhisperModel` after `prepare_cuda_dlls()` and sets
  `HF_HUB_DISABLE_SYMLINKS_WARNING`).
- Profiles: `turbo` → `settings.whisper_model`, `accurate` → `settings.whisper_fallback_model`.
- Device: `auto` → cuda if `ctranslate2.get_cuda_device_count() > 0` else cpu; compute type
  per config rule above.
- `async preload()` (startup, when `whisper_preload`): loads turbo on the worker executor;
  updates `server_state.model_status` (`loading`→`ready`/`error`), `model_name`,
  `model_device`, `model_load_s`, `model_error` (safe codes: `model_files_missing` when
  `local_files_only` and files absent, `cuda_unavailable`, `load_failed`). Never crash startup.
- `get(profile)` (sync, worker thread): loads on demand; if loaded count would exceed
  `whisper_max_loaded_models`, unload the least recently used first (`del` + `gc.collect()`).
- `threading.Lock` `lock`.

### `services/broadcaster.py`
Per-session set of subscriber `asyncio.Queue(maxsize=256)`. `publish(session_id, message)`
non-blocking; if a queue is full, mark that subscriber `overflowed` (the WS handler closes with
code 4008 so the client reconnects and resumes via `after_seq`). Thread-safe entry
`publish_threadsafe(loop, ...)` using `loop.call_soon_threadsafe`.

### `services/firestore_sync.py`
`FirestoreSync(firebase_service)` with `async session_started(session)`,
`async session_finalized(session, chunks)`, `async delete_session(event_id, session_id)`.
`DisabledFirestoreSync` when Firebase isn't ready (sessions get `firestore_sync='disabled'`).
Writes (Admin SDK, `asyncio.to_thread`, `set(..., merge=True)`, batches ≤ 450 ops):
- session doc `events/{eventId}/sessions/{sessionId}`: `ownerId, status, model,
  languageMode, detectedLanguages, startedAt, endedAt, durationMs, serverSessionId,
  transcriptStatus, error` (exact Phase-2 field names).
- chunk docs `.../chunks/{chunkId}` on finalize only: `sequence, startMs, endMs,
  uploadStatus ("uploaded"), transcriptionStatus, detectedLanguage, languageConfidence,
  languageSource, userOverride (bool: source=="override"), rawText, polishedText (None), error,
  createdAt, updatedAt`. Firestore timestamps via `datetime` objects.
- Never write partials; never write audio. Failures → raise `FirestoreSyncError`; the worker
  marks `firestore_sync='failed'` + safe error code and retries every
  `firestore_sync_retry_s`. Transcription/finalization never fails because Firestore failed.

### `workers/transcription_worker.py`
- `TranscriptionWorker(settings, store, engine, model_manager, broadcaster, firestore_sync,
  state)`; `start()` creates the asyncio task + a `ThreadPoolExecutor(max_workers=1,
  thread_name_prefix="whisper")`; `notify()` wakes it (asyncio.Event); idle wait ≤ 1 s.
- Startup: `store.recover_on_startup()`, re-check `finalizing` sessions, then loop.
- Picks the next `queued` chunk whose `next_attempt_at <= now`, ordered by `created_at,
  sequence`. While `model_status != "ready"`, do not take chunks (they stay queued; attempts
  unchanged).
- Per chunk (bind `session_id`/`chunk_id` log contextvars): mark `processing`, emit persisted
  `chunk_processing`; on executor: load audio → speech seconds → if < 0.2 s: no_speech result
  (empty text, `no_speech=True`, language from tracker unchanged, no detection); else tracker
  decision (run `engine.detect` only when `decision.detect`) → language → transcribe with
  vocabulary hotwords (event's terms) → overlap trim. Partial segments → ephemeral
  `transcript_partial` via `publish_threadsafe` (not persisted, not in Firestore).
- Success: store raw result, `done`, persist tracker state, emit `transcript_final` (+ any
  tracker events), audit `chunk_transcribed` with model, duration, real-time factor.
- Failure: attempts += 1; if < `chunk_max_attempts` → `queued` with
  `next_attempt_at = now + base * 2**(attempts-1) * uniform(0.8, 1.2)`; else `failed` + emit
  `chunk_failed {error_code}`. Audio is kept. Never overwrite an existing raw_text with empty
  on failure.
- After each chunk/upload/finalize request: `maybe_finalize(session_id)`.
- `maybe_finalize`: session `finalizing` and no queued/processing chunks and (no
  `expected_chunk_count` or all sequences `0..N-1` present, or force flag recorded) →
  `finalized`; `transcript_status` = `complete` if every expected chunk is `done`, else
  `partial`; emit `session_finalized {transcript_status, missing_sequences, failed_sequences}`;
  Firestore sync; if `server_audio_retention == "delete_on_finalize"`, delete that session's
  audio files (DB rows stay).
- Firestore retry sweep every `firestore_sync_retry_s` for `pending`/`failed` sessions.
- `queue_depth` (queued + processing) kept in `server_state`; `queue_status`
  `not_started|running|stopping`.
- `async stop()`: status `stopping`; stop taking new chunks; wait for the in-flight job up to
  `shutdown_drain_timeout_s`; if it doesn't finish, leave it `processing` (recovered as
  `queued` on next start). Shutdown executor without waiting after the timeout.

### Routes (all protected by `authenticated_user`; session ownership via `require_owner`
against `sessions.owner_uid` — local, no Firestore; 404 for not-owned)
- `POST /api/v1/sessions` body `{session_id: DocId (client-generated, idempotent), event_id:
  DocId, language_mode: "auto"|code = "auto", expected_languages: [code] = [], model_profile:
  "turbo"|"accurate" = "turbo", overlap_ms: 0..max_overlap_ms = 0}`. Verify
  `require_event_owner(event_id)` via `app.state.event_repository` (Firestore). Existing id with
  same owner+event → 200 + existing; otherwise 404. New → 201. Then best-effort
  `firestore_sync.session_started` (failure → `firestore_sync='pending'`, request still 201).
  Emits persisted `session_created`.
- `POST /api/v1/sessions/{session_id}/chunks` multipart: `chunk_id` (DocId), `sequence`
  (0..100000), `start_ms`, `end_ms` (end > start; end-start ≤ max_chunk_duration_s*1000 +
  overlap), `overlap_ms` (0..max), `continues` (bool, default true), `language` (optional
  per-chunk forced code), `sha256` (optional 64-hex), `file` (UploadFile; extension from
  filename in `allowed_audio_extensions`, else 415 `unsupported_media_type`).
  Stream to `audio/{session_id}/{sequence:06d}_{chunk_id}.{ext}.part`, compute sha256, then
  `os.replace` to final name (in a thread). Checks in order: ownership (404), session status
  `finalized` → 409 `session_finalized`; dedupe: same chunk_id + same sha → **200**
  `{duplicate: true, status, chunk}` (no re-queue, delete the temp file); same chunk_id
  different sha, or same sequence different chunk_id → 409 `chunk_conflict`; client sha given
  and ≠ computed → 422 `checksum_mismatch`; queue depth ≥ `queue_max_depth` → 503 `queue_full`
  with `Retry-After: 10`. Success → **202** `{chunk_id, sequence, status: "queued",
  duplicate: false, queue_depth}`; emit `chunk_queued`; audit; `worker.notify()`.
  Uploads to a `finalizing` session are accepted (late backlog from the phone's offline queue).
- `GET /api/v1/sessions/{session_id}?after_sequence=-1&limit=500` (limit ≤ 1000) →
  `SessionOut`: ids, status, transcript_status, model_profile/name, `language {mode, locked,
  segments: [{language, from_sequence, to_sequence}]}` (computed from done chunks),
  `counts {queued, processing, done, failed, total}`, `missing_sequences`, `chunks:
  [ChunkOut]` ordered by sequence (raw_text, segments, detected_language,
  language_confidence, language_source, language_uncertain, no_speech, status, error_code),
  `transcript_text` (done chunks' raw_text joined by sequence — only when no pagination
  cursor is used), `last_event_seq`, `firestore_sync`.
- `POST /api/v1/sessions/{session_id}/finalize` `{expected_chunk_count: int|None, force:
  bool=False}` → sets `finalizing`; runs `maybe_finalize`; **200** with SessionOut if finalized
  now, **202** `{status: "finalizing", missing_sequences, pending: n}` otherwise. Idempotent.
- `POST /api/v1/sessions/{session_id}/language` `{language: "auto"|code}` → tracker
  `set_mode`, persist, emit `language_override {language, by: uid-less "user"}`, audit; 200
  current language state. Rejected (409 `session_finalized`) after finalization.
- `DELETE /api/v1/sessions/{session_id}` → close WS subscribers, delete audio dir, delete DB
  rows (cascade), best-effort `firestore_sync.delete_session` (`firestore_deleted: bool` in
  the 200 response), audit `session_deleted`. Refuse while a chunk is `processing` (409
  `session_busy`, client retries).
- `POST /api/v1/vocabulary` `{event_id, terms: [str ≤ 64 chars] ≤ vocabulary_max_terms,
  replacements: [{from, to}] ≤ 200}` (owner check via `require_event_owner`); `GET
  /api/v1/vocabulary?event_id=` → stored lists. Terms (deduped, trimmed) feed `hotwords`
  (joined ", ", ≤ 400 chars). Replacements are stored only (docs: applied in the polished
  layer in Phase 8, never to raw text).

### WebSocket `GET /api/v1/sessions/{session_id}/stream?after_seq=0`
- Auth uses the same headers as HTTP (`X-WhisprPersonal-Server-Key`, `Authorization: Bearer`)
  — React Native's `WebSocket(url, protocols, {headers})` supports this. Never accept tokens
  in the query string.
- Flow: `accept()`; run server-key check, token verification, per-user rate limit, ownership.
  On failure send `{"type":"error","code":...,"message":...}` then close with 4401 (auth
  codes), 4403 (`account_not_allowed`), 4404 (not found), 4429 (rate limited), 4503
  (auth unavailable / not configured).
- Then: subscribe to broadcaster **first** (buffer), send `{"type":"hello","session_id",
  "status","last_event_seq","server_time"}`, replay persisted events with `seq > after_seq`
  in order, then drain live messages skipping persisted ones with `seq <= last replayed`.
- Persisted event envelope: `{"type","seq","session_id","ts","data":{...}}`. Ephemeral:
  `{"type":"transcript_partial","session_id","chunk_id","sequence","data":{segment}}` (no
  seq). Types: `session_created, chunk_queued, chunk_processing, transcript_partial,
  transcript_final, chunk_failed, language_locked, language_changed, language_override,
  session_finalizing, session_finalized, session_deleted, ping, error`.
  `transcript_final.data`: `chunk_id, sequence, start_ms, end_ms, raw_text, segments,
  detected_language, language_confidence, language_source, language_uncertain, no_speech`.
- Server sends `ping` every 20 s. Client messages: `{"type":"pong"}`,
  `{"type":"set_language","language":"kn"|"auto"}` (same effect as the HTTP route). Unknown →
  `error` message, keep the connection. Invalid JSON → `error`. Max inbound message 4 KiB.
- Overflowed subscriber → close 4008. Session deleted → send `session_deleted`, close 1000.

### Health / diagnostics
`ModelInfo`: add `loaded: list[str]`, `device_resolved: "cuda"|"cpu"|None`,
`compute_type`, `load_s`, `error: safe code|None`. `QueueInfo` status now real.
`HealthResponse` adds `languages: {supported: [...], default_mode: "auto"}`. Overall `status
== "ok"` when model ready and queue running. Diagnostics adds chunk counts by status, average
real-time factor of the last 50 chunks, `cuda_dll_dirs_added: int`. No paths, no transcript
text.

### CLI + launchers
- `python -m app.cli download-models [--fallback]` → `download_model(name,
  cache_dir=models_dir)` for turbo (and large-v3 with `--fallback`); prints sizes; requires
  internet; message tells the operator to then set `WHISPER_LOCAL_FILES_ONLY=true` for offline
  events.
- `start.ps1`/`start.sh`: after the health endpoint responds, poll until `model.status` is
  `ready` (print `loading…` every 10 s, up to 20 min for first download) or `error` (print the
  safe code + `docker compose logs --tail 50`, exit 1); then self-test, LAN URL, QR, docs.

### Errors (add to taxonomy)
`chunk_conflict` 409, `session_finalized` 409, `session_busy` 409,
`unsupported_media_type` 415, `checksum_mismatch` 422. Chunk-level codes (stored, not HTTP):
`audio_decode_failed`, `chunk_too_long`, `transcription_failed`, `no_speech` is a flag not an
error.

## Tests (offline; `FakeEngine` in `tests/fakes.py` scripts speech seconds, detection probs,
segments/words, failures, and records calls; never load the real model except the gpu test)
- `test_language_tracker.py`: forced mode skips detection; lock after window+streak; no lock
  before window even with high confidence; expected-language restriction (raw top `te` 0.55,
  `kn` 0.35 with expected `[kn, en]` → kn, uncertain=True); low confidence → uncertain;
  switch requires `switch_consecutive` chunks; single-chunk spike transcribed in detected
  language without switching lock; `set_mode("auto")` resets; state round-trip.
- `test_overlap.py`: cases listed above.
- `test_store.py`: migrations idempotent; recover processing→queued; unique sequence;
  cascade delete; events seq monotonic.
- `test_model_manager.py`: fake factory; cpu → int8; status transitions; `model_files_missing`
  when local_files_only and factory raises; LRU unload when max_loaded=1; preload errors don't
  raise.
- `test_sessions_api.py` (FakeEngine + FakeEventRepo + FakeFirestoreSync, real SQLite in
  tmp_path): create 201 / idempotent 200 / other user's event 404 / other user's session id
  404; upload 202 then duplicate 200 (no requeue) / conflict 409 (both kinds) / 415 / checksum
  422 / finalized 409 / queue full 503 + Retry-After / other user's session 404; file landed
  under data_dir with correct name and sha; GET returns chunks ordered with transcript_text;
  language override endpoint; delete removes files + rows + calls Firestore delete; busy 409.
- `test_worker.py`: queued→done with `transcript_final` persisted and partials published;
  silence → no_speech and engine.detect NOT called; forced language → detect NOT called;
  retry with backoff then `failed` after max attempts with raw audio kept; model not ready →
  chunk stays queued with attempts 0; restart recovery; finalize waits for missing sequences
  (202) then completes when they arrive; force finalize → `partial`; failed chunk → partial;
  Firestore sync field names exactly as specified; Firestore failure → `failed` then retried
  successfully; `delete_on_finalize` removes audio only; graceful stop leaves no job lost.
- `test_stream.py`: auth failure close codes (missing key 4401, bad token 4401, other user
  4404); hello + replay from `after_seq`; live `transcript_final` and `transcript_partial`
  delivered; no duplicate between replay and live; `set_language` message works; invalid JSON
  → error, connection stays open; overflow → 4008.
- `test_vocabulary.py`, `test_firestore_sync.py` (fake Firestore client records batch ops;
  ≤450 per batch), `test_languages.py`.
- `test_whisper_gpu.py`: `@pytest.mark.gpu`, skipped unless env `WHISPR_RUN_GPU_TESTS=1` AND
  the turbo model exists under `server/models` (use `local_files_only=True`; the `no_network`
  fixture must stay active). Real `FasterWhisperEngine` on the fixture: speech seconds > 10,
  detection top = `en`, transcript contains "technology summit" (case-insensitive) and
  "Bengaluru"; segments have int ms; silence clip → speech seconds 0.
- All Phase 1–2 tests keep passing.

## Done when (architect will verify)
1. `./.venv/Scripts/python -m pytest -q -p no:cacheprovider` → all pass offline (gpu test
   skipped). Architect will run `WHISPR_RUN_GPU_TESTS=1` separately on the real GPU.
2. `ruff check .` + `ruff format --check .` clean.
3. Server starts with no `.env`, no Firebase, `WHISPER_PRELOAD=false` → `/health` 200; with
   preload on this machine the model reaches `ready` (architect verifies).
4. No LLM/HTTP provider calls anywhere in this phase. No secrets/paths/transcript text in logs
   (only ids, codes, durations).
5. Protected files untouched (`secrets/`, `android/app/`, root `.env`, `.gitignore`,
   `.gitattributes`, `AGENTS.md`); `server/models/` untouched (do not delete or move the
   downloaded model).

## Owner decision to record in docs
On 2026-11-15 the owner accepted that **events require internet access for sign-in**
(Firebase ID tokens expire after 1 h; Admin SDK caches signing certs in memory only). Replace
the "Known constraint / decision pending" wording in `docs/security.md` and `docs/setup.md`
with "Accepted limitation (2026-11-15)", and add a pre-event check to `docs/event-runbook.md`:
confirm the hotspot/Wi-Fi has internet and sign in on the phone within the hour before
recording. Transcription itself (model loaded, `WHISPER_LOCAL_FILES_ONLY=true`) needs no
internet.

## Report back
Files, test/ruff summaries, deviations with reasons, anything you could not verify.
