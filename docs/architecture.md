# Architecture

WhisprPersonal keeps transcription on a laptop, with an Android client connecting
over LAN or Tailscale. Optional cloud providers enhance derived text in later phases.

```text
Phase 3:
 Android recorder --> FastAPI --> bounded queue --> Whisper / VAD
       |                 |                              |
 Firebase ID token ------+--> Firebase verification     +--> raw transcript
                         |                              |
                         `--> optional LLMs <------------+--> derived output

Request path (outermost first):
 Request context -> network filter -> security headers -> body limit
                 -> global/IP token buckets -> optional CORS -> FastAPI routes
 /health: status only
 /api/v1/auth/check, /api/v1/diagnostics:
   shared server key -> Firebase ID token -> account allowlist -> per-user bucket
```

`create_app(Settings(...))` is the injection seam for tests and deployments. Creating an
app does not probe GPUs or contact providers. Lifespan configures redacting stdout logs,
detects local GPU availability once, and places settings, server state, a Firebase service, event ownership repository, token verifier,
and three limiters on `app.state`. The GPU import/probe runs off the event loop; the
subprocess fallback has a three-second timeout. Whisper preloads asynchronously on the single inference executor when enabled.

`ServerState` starts with a UTC timestamp, GPU summary, `model_status=not_loaded`,
`queue_status=not_started`, and zero queue depth. The queue moves to running at startup and stopping on shutdown; model loading progresses
to ready or a safe error. Shutdown drains in-flight work within a bounded timeout. A single process holds the Whisper model and in-memory buckets. Multiple workers would split limits and duplicate
model memory.

Health builds a typed status snapshot without any remote calls. Provider configuration
requires both a key and a chosen model (local LLM: URL and model); this reports
`configured_unchecked`, never inferred provider readiness. Firebase initializes a local Certificate and named Admin app via a worker thread.
Its health status is `not_configured`, `ready`, or `error`; ready means local initialization,
not remote reachability. Firebase status does not change model/queue readiness.

`FirebaseTokenVerifier` implements `TokenVerifier` when Firebase is ready; otherwise the
server retains `DisabledTokenVerifier`. `require_auth` checks the shared key before calling
it. `authenticated_user` composes authentication and per-user rate limiting, sharing one
verified identity per request. Tokens are verified off the event loop and allowed accounts
are filtered by uid or verified email. Tests inject a fake service and verifier using
`create_app(settings, firebase_service=..., token_verifier=...)`; all external calls stay mocked.

The Firestore client is lazy and cached. `FirestoreEventRepository` reads only `ownerId`
off the event loop, and ownership helpers hide missing/foreign events behind identical 404s.
Admin SDK access bypasses rules; both server authorization and client rules are required.
Shutdown deletes the initialized Admin app. Session/chunk APIs implement audio ingestion, VAD, language tracking and inference.
No LLM HTTP calls are made. Signing certificates are memory-only and token
refresh requires internet; see [security.md](security.md#accepted-limitation-2026-11-15).

Errors have one envelope and correlate to `X-Request-ID`. Pure ASGI middleware preserves
streaming and WebSocket scopes without buffering request bodies. Bodies are bounded
both by declared Content-Length and bytes actually received. Access logs include path
without query strings, method, status, latency, and peer IP; they omit headers and bodies.

Docker persists models and event data in separate mounts. Credentials use a
read-only mount outside the build context. The container runs as uid/gid 10001 with no
capabilities and no privilege escalation. CUDA libraries in the base image do not require
a GPU reservation; the optional Compose override requests one NVIDIA device.


## Durable transcription pipeline

Multipart upload streams into a per-session .part file while SHA-256 is calculated, fsyncs,
and atomically replaces the final audio file before queue admission. Chunk ID/hash deduplication
and unique session/sequence constraints make mobile retries idempotent. A process mutation lock
serializes admission against queue capacity, finalization and deletion. A crash between file
rename and DB commit may leave an unreferenced audio file; retrying the upload safely replaces it.

SQLite lives under DATA_DIR as whisprpersonal.sqlite3, with audio in audio/{session_id}/.
WAL, foreign keys, NORMAL synchronization, a busy timeout, ordered transactional migrations
and a locked connection support durability. Every DB operation runs off the event loop.
On restart, processing rows return to queued with attempts preserved. Sessions, chunks,
tracker state, vocabulary, durable stream events and text-free audit records live locally.

One asyncio consumer claims queued work by creation time/sequence. A single-thread executor
is the GPU serialization boundary. Model access additionally holds the manager lock through
lazy generator iteration. Decode -> Silero VAD -> language detection/decision -> Whisper ->
word midpoint trimming -> atomic result/tracker/final-event persistence. Under 0.2 seconds
of speech skips detection and inference. Raw full text is retained alongside trimmed text;
no cleanup or vocabulary replacements are applied. Per-session locks serialize language
changes against inference. A per-chunk override does not change the session language mode.

Auto language tracking renormalizes configured expected languages, flags a strong global
outside-set detection as uncertain, locks only after consecutive confidence and accumulated
speech-window requirements, and continues detection after locking. A high confidence switch
candidate is used for that chunk immediately; the lock changes only after the configured
consecutive streak. State survives restarts. Forced modes skip language detection entirely.

Partial segments are ephemeral bounded-queue broadcasts. Final results and lifecycle/language
events are committed to session_events with monotonically increasing per-session sequence
numbers. WebSocket subscribes before replay and skips duplicate sequence numbers when
switching to live delivery. Slow subscribers close 4008 and reconnect using after_seq.

Finalization waits for pending chunks and missing expected sequences unless forced; missing
or failed chunks produce a partial transcript. Late uploads are accepted while finalizing.
Firestore receives session metadata and finalized chunk text only, in batches of at most 450.
Cloud errors mark sync failed and retry independently without invalidating transcription.
Audio retention is keep by default; delete_on_finalize removes audio while retaining results.

Deleting a non-busy session removes local rows/audio and attempts deletion of nested cloud
chunks and the session doc. A cloud deletion failure is reported for operator follow-up.
A shutdown timeout cancels coroutine bookkeeping and leaves an in-flight processing row for
startup recovery; the executor is shut down without waiting for native inference to return.

## Phone notes and search (Phase 7)

The phone's SQLite database is the source of truth for notes. Migration 3 adds `notes`, with
an outbox embedded in each row: intended `revision`, latest acknowledged `synced_revision`,
`remote_device`, retry metadata and optional conflict `remote_json`. Every user mutation
uses an exclusive transaction and increments `max(revision, synced_revision) + 1`. Creating a
note starts at 1/0. Deleting retains a tombstone with empty text and a null speaker.

`NoteSyncEngine` has injected repositories, Firestore adapter, device id and clock. Its
serialized drain launches at most 50 due writes, oldest edit first, without awaiting server
acknowledgements. A promise that stays pending offline cannot block another note. In-flight
keys include revision, so another edit can queue while an earlier revision is unacknowledged.
Startup, local actions, network recovery, foregrounding and a 30-second pending timer trigger
the drain. Restart reconstructs work entirely from SQLite. Notes sync needs Firebase, not
the laptop URL. Account changes stop subscriptions and guard asynchronous callbacks by uid.

The state transitions are:

- Local action: synced/failed → pending; a conflict edit stays conflict and keeps both copies.
- Server acknowledgement: advance synced revision; mark synced only if no newer local edit
  or conflict exists. Late results never copy text back into the note.
- Transient rejection/fetch failure: pending with persisted exponential jitter backoff.
- Invalid argument/precondition or rejected absent document: failed, retaining local text.
- A newer other-device document while pending: conflict, retaining local text and remote JSON.
- Keep mine: advance beyond both revisions, base the write on the cloud revision, then pending.
- Use cloud: explicitly copy cloud fields and version, then synced (including deletions).

Reference-counted event subscriptions run while notes, session or search screens are open.
The Firestore query orders by `createdAt`, limits to 500 and includes metadata changes.
Pending local echoes are ignored by the engine. Older server versions cannot resurrect
tombstones. New tombstones are imported even when there is no visible local note.
The adapter rejects malformed documents and logs only `invalid_remote_note`.

Notes store NFC/lowercase `search_text` in JS, retaining Indic combining marks. Queries use
bound LIKE patterns with literal percent, underscore and backslash escaping; no FTS5 is used.
Transcript search joins sessions for owner isolation, then normalizes text in JS because
existing transcript rows have no normalized search column. Both result sets are newest first,
limited to 50 each, after a 250ms debounce and a minimum two-character query. This scans the
owner's local transcript rows; it does not perform cloud transcript search. Search watches
events from local sessions/notes and the existing event subscription (50 recent events).

Quick notes stamp current elapsed recording milliseconds only while recording or paused.
Final transcript rows can be copied into notes by long press or an accessibility action;
partial and failed rows never expose that action. Raw transcript storage is unchanged.
AI-assisted notes remain disabled with a not-configured label.

## Optional server intelligence (Phase 8a)

Explicit cleanup and brief requests use `services/llm`: Groq → SambaNova → configured local
LLM → unavailable. The transcription worker has no dependency on this chain and never
invokes it during recording or per audio chunk. Key plus model enables a cloud provider;
URL plus model enables local inference. No model id or provider quota is assumed.

A shared asynchronous HTTP client sends a minimal non-streaming chat payload with a bounded
provider timeout. Groq uses `max_completion_tokens`; SambaNova/local use `max_tokens`.
Each provider has its own semaphore and optional laptop RPM bucket. Transient errors retry
with full jitter; 429 honours seconds or HTTP-date `Retry-After`. An excessive wait triggers
fallback immediately. Auth failures open the circuit immediately; consecutive transient or
invalid-response failures open it at the configured threshold. After cooldown only one
half-open request probes the circuit. Bad requests fall back without incrementing failures.

`AIJobService` owns a bounded queue and one asyncio worker, separate from the serialized
Whisper executor. Migration 5 persists jobs, attempt usage and separate polished columns.
All SQLite operations remain serialized in worker threads. Per-window cleanup validates
markers, similarity, length and Unicode script before a transactional polish write. Briefs
use timestamped stitched chunks, optionally preferring existing polish. Long inputs split
on chunk boundaries, map to notes and reduce within the same character budget, with at most
one extra reduction level. Oversized chunks/notes fail instead of silently truncating speech.

Fresh Firestore event access is required at admission and execution. `cloud_ai` allows the
full chain; `local_only` skips both cloud providers. Unknown mode or unavailable Firestore
fails closed. Job ownership remains local and independent of provider availability.
Cancellation/timeout records a terminal state; startup interrupts unfinished jobs without
automatic replay. AI attempt audits contain metadata only. Polished Firestore projections
use merges of at most 450 chunks and a 10-second bound; projection failures do not fail jobs.
Briefs are never written to Firestore by the server.

## Phone AI review flow (Phase 8b)

The app uses `authedClient(owner)` for uploads and AI requests. It constructs the existing
token manager and server-key headers and checks the signed-in account before and after
obtaining a bearer token. Provider keys and provider model configuration remain on the
laptop. AI response validation rejects malformed data with `bad_response`; safe user text
is centralized in `lib/ai/messages.ts`.

SQLite migration 4 adds separate polished columns, durable `ai_jobs`, and `brief_drafts`.
Transcript upserts preserve polish when raw text is unchanged, and clear all three polished
columns when stitching revises raw text. Polished writes update only polished columns and
check the raw text/revision observed before fetching, so a response cannot overwrite a
concurrent raw revision. The Polished tab is explicitly labelled and falls back to raw rows
with a Not cleaned label. Transcript-to-note actions remain on the Raw tab.

`AIJobRunner` is independent of React Native and receives the API, repositories, clock and
device id generator. The signed-in runtime polls jobs at 2 seconds with backoff capped at
10 seconds; network/5xx failures retain pending work. A 404 becomes failed/not_found;
server interruption is terminal and requires an explicit new request. Cleanup completion
fetches each session's polished projection. Brief completion commits the initial draft and
terminal job status in one transaction, preventing a crash between those writes from losing
the draft. Draft editing serializes local writes before Save or Discard.

Finalization stores the server's transcript completeness in the existing `finalize_status`
field from the HTTP result or persisted `session_finalized` event. Older unknown values
are treated as incomplete for brief consent. Only finalized local sessions can be selected.
Notes are explicitly included by default, limited to the newest 200 non-deleted event notes.

Saving uses the draft's device-generated id at `events/{eventId}/briefs/{briefId}` and queues
`setDoc` without awaiting server acknowledgement. The phone marks its draft saved and keeps
that local copy; Firestore subscriptions order by client creation time and cap at 50.
Rules enforce event ownership, exact brief keys, types/limits, fixed owner/creation time and
server update time. Generated text, reviewed text, provider/model, structured output and
incomplete provenance stay separate from transcripts and notes.


## Export, read-only review and event operations

`POST /api/v1/export` authenticates and verifies every local session owner/event before
reading stitched chunks. It emits md/txt with gaps, language changes and raw/polished
fallback labels, then records `transcript_exported`. Export never starts AI work.

The phone composes exports from local SQLite transcript rows and cached event metadata,
non-deleted notes and an optional explicitly selected saved brief's finalText. Cache files
live under `Paths.cache/exports`; each export removes files older than 24 hours before
handing the new file to the native share sheet. PDF remains disabled. The Library/event
screen links to saved briefs, export and a read-only transcript viewer; transcript search
links include the matching sequence. Viewer filtering uses existing NFC-aware search and
never follows live updates automatically. Vocabulary remains on the laptop and applies to
future chunk transcription only.

Phone session deletion stops/drains upload/AI work, refuses active capture, and calls the
existing laptop DELETE endpoint. File deletion precedes one SQLite transaction removing
chunks, transcripts, stream/language events, referencing ai_jobs and recording_sessions.
Event-level notes and saved briefs remain. Offline phone-only deletion adds a
pending_server_deletes row (session_id, event_id, owner_uid) in the same transaction.
The next upload-service passes retry owner-scoped deletes, treating 404 as success and
retaining other failures. Settings diagnostics show the remaining count.

Diagnostics render/share only explicitly listed laptop fields and phone status/counts.
Unknown nested fields, full URLs, participant text, credentials and device identifiers
never enter the diagnostics document. Phone disk/version/network counts work without a
laptop; laptop status is independently unavailable when disconnected.

## Phase 10a: independent local translation

Explicit owner request → separate durable translation queue → IndicTrans2 process on
`127.0.0.1:8100` → translation rows in SQLite. IndicTrans2 uses pinned offline HF snapshots
and the attributed pure Python IndicProcessor, one direction in memory at a time. Generation
runs on a worker thread; idle models unload after five minutes. Optional fallback is the
loopback LibreTranslate/Argos process on port 5000, gated by both benchmark eligibility and
explicit pair configuration. No Google translation service is involved.

Migration 6 separates translations and jobs from immutable speech. Per-chunk results carry
engine/model/language/time labels. Optional LLM fluency edits follow dedicated translation
and live in separate AI-polished columns. No live translation starts by default. Jobs operate
only on finalized sessions; deleting a session cascades translations and linked jobs. Restart
interrupts queued/running translation jobs instead of rerunning them.

A second independent bounded queue, concurrency one, handles emergency Groq audio→English
only after terminal local-ASR-unavailable errors. Admission and each upload verify current
owner/privacy consent; its Groq limiter, capacity and breaker are shared with Phase 8a.
It snapshots bounded WAV bytes before retention cleanup, stores a translation, and publishes
a persisted text-free `chunk_audio_translated` event. The chunk remains failed. Core ASR and
raw text never depend on either dedicated engine or a translation result.

Public health uses cached translation status only. Separate two-second loopback probes refresh
every 30 seconds. See [translation.md](translation.md) for revisions, benchmarks and operations.

## Phase 10b: phone translation and disabled integrations

Phone SQLite migration 6 adds `translations` keyed by `(session_id, sequence, target_lang)` and
a separate `translation_jobs` table with local kind `translate` and target language. Neither
writes translation output into `transcript_chunks`. Session deletion removes translations and
all jobs referencing the session. Late poll/fetch responses cannot resurrect a deleted session.
The durable poller resumes queued/running jobs on restart, retries reads with bounded backoff,
and never automatically resubmits work. Terminal interrupted jobs require an owner request.

Finalized session and transcript views share target selection, optional privacy-gated AI-polish,
and a Translation tab. Missing/failed rows fall back to raw text. Dedicated translation and
AI-polished blocks have distinct provenance. Audio events are validated and trigger an English
translation fetch before persisting the stream cursor; unknown event types are ignored.
Exports append an optional labelled translation section; raw speech remains separately stored.

`app/integrations/` defines one protocol and disabled implementation per future service.
Static health/diagnostic inventory does no I/O. Flags default false; empty placeholders never
initialize clients. App Check enforcement is gated by both its flag and a configured injected
verifier. See [integration contracts](integrations.md).
