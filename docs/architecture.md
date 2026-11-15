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
