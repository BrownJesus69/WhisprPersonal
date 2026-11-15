# API reference - Phase 3b

Default base URL: `http://127.0.0.1:8000`. Interactive docs are at `/docs`, alternative docs
at `/redoc`, and the schema at `/openapi.json` when `ENABLE_API_DOCS=true`. These surfaces
are behind network/body/rate middleware. Turn them off for a deployment that does not need
them. Responses use UTC timestamps and JSON.

Protected requests require `X-WhisprPersonal-Server-Key` and `Authorization: Bearer <ID token or grant>`.
The Bearer scheme is case insensitive; empty or malformed tokens count as missing.
The shared key is always checked first. Tokens beginning `wpg1.` are verified locally;
other tokens use Firebase Admin. Both paths enforce the optional account allowlist.
Each protected request verifies its token exactly once, followed by its per-user rate limit.
Use an optional `X-Request-ID` matching `[A-Za-z0-9-]{8,64}`; otherwise a UUID hex ID is
generated. HTTP responses echo the effective ID, including middleware errors.

## GET /health

Public within the network allowlist; no authentication headers required. HTTP 200 means
the process can serve requests. Read `status` to assess readiness. It is `degraded` until
both model status is `ready` and queue status is `running`.

| Field | Shape and meaning |
| --- | --- |
| status | `ok` or `degraded` |
| version | `0.1.0` |
| server_time, uptime_s | UTC ISO-8601 timestamp and nonnegative elapsed seconds |
| model | `name`, `fallback_name`, `status` (`not_loaded/loading/ready/error`), `device` (`auto/cuda/cpu`, configured preference) |
| gpu | `available` (boolean/null), `name` (string/null), `vram_total_mb` (integer/null), `detection` (`ctranslate2/nvidia-smi/disabled/unavailable`) |
| queue | `status` (`not_started/running/stopping`), `depth`, `max_depth`, `workers` |
| providers | `groq`, `sambanova`, `local_llm`, each `{configured: boolean, status: not_configured/configured_unchecked}` |
| firebase | `{credentials_present: boolean, status: not_configured/ready/error, error_reason: null/credentials_missing/credentials_invalid/init_failed, project_id_set: boolean}` |
| auth | `{shared_secret_configured: boolean, token_verification: disabled/firebase, allowlist_enabled: boolean, check_revoked: boolean, grants: {enabled: boolean, ttl_hours: number}}`; token_verification describes the Firebase path |
| features | boolean `translation`, `calendar`, `drive`, `gmail`, `app_check`, `fcm`, `web_search`, `cloud_whisper` |

With preload disabled, startup values are `degraded`, `not_loaded`, `running`, and
unconfigured providers. Default preload loads turbo asynchronously. Configured providers are never contacted here. Names in the model object are
the configured Whisper names, not a claim that model files exist. No secret or filesystem
path is returned. Security headers include `nosniff`, `no-referrer`, and `no-store`.

## GET /api/v1/diagnostics

Requires both authentication headers. Returns all health fields plus `python_version`,
`platform` (OS family only), `config` from `Settings.safe_summary()`, and `limits` containing
the two body byte limits and three rate limits. Secrets, paths and base URLs in `config`
are replaced by booleans with `_set` names. Returns 503 `server_not_configured` when no
server key is configured, 401 `missing_server_key`/`invalid_server_key` otherwise as
appropriate, 401 `missing_auth_token` for absent/malformed Bearer, and finally 503
`auth_not_configured` if Firebase initialization is unavailable. A verified, allowed identity
receives 200. Allowlists in `config` appear only as counts, never uid/email values.

## GET /api/v1/auth/check

Requires the shared server key, then a Firebase ID token or a laptop-signed grant.
Returns `uid` (string), `email` (string or null), `email_verified` (boolean),
`sign_in_provider` (string or null), `server_version` (string), `auth_method` (`firebase` or
`grant`), and `grant_expires_at` (Unix seconds for grants, otherwise null). This probe supports the
Connect-laptop screen; after first sign-in use its uid to configure `AUTH_ALLOWED_UIDS`.
Both this route and diagnostics apply the same per-user limit after verification.

## Offline grants

All three POST routes require the server key, enforce the account allowlist and consume
the per-user rate limit. Responses have `Cache-Control: no-store`. Times below are Unix seconds.

| Route | Request and response |
| --- | --- |
| POST /api/v1/auth/grant | No body. Requires a Firebase ID token; a `wpg1.` Bearer returns 401 `invalid_auth_token`, "A Firebase sign-in is required to issue a grant." Returns 200 `{grant, expires_at, ttl_s, grant_id}`. Default TTL is 43200 seconds. |
| POST /api/v1/auth/grant/revoke | Optional JSON `{grant_id}`; omission revokes the calling grant. Firebase callers must supply an ID. Returns 200 `{grant_id, revoked: true}`. Only grants issued to the caller can be revoked; unknown/other-owner IDs return 404. Invalid/missing IDs return 422. |
| POST /api/v1/auth/grants/rotate-key | No body. Requires an explicit matching owner uid or verified email allowlist (empty lists return 403). Atomically replaces the local key file, invalidating all old grants. Returns 200 `{rotated: true}`. With an environment-managed signing key, returns 503 `feature_disabled`; rotate that key externally and restart. |

Grants are enabled by default; `AUTH_GRANT_ENABLED=false` disables issuance and grant
verification with 503 `auth_not_configured`, leaving Firebase authentication available.
Key loading failures also fail closed for grants. Verification and revocation use local
SQLite and need no network, including after server restart. Existing session ownership
and all other authorization checks still apply; creating sessions and accessing vocabulary
still need Firestore, so create the session before going offline.

Client contract (Phases 4-6): after Firebase sign-in and whenever online with a fresh ID
token, call `/auth/grant` (under `/api/v1`), store only in `expo-secure-store`, and use the
grant as Bearer while valid. Renew proactively with a fresh Firebase ID token when less
than two hours remain and the network is up. A grant cannot mint another grant. On
`auth_token_expired` without internet, show "Reconnect to the internet to renew sign-in".
Never store grants in Firestore, logs or QR codes.

## Errors and limits

```json
{"error":{"code":"not_found","message":"Not found.","request_id":"example-id-123"}}
```

Optional `details` contains safe structured information; validation details are a list of
`{loc, msg, type}` entries with input values excluded. Responses never contain tracebacks.
Unhandled exceptions use `internal_error` and `An unexpected error occurred.`.

| Code | HTTP status |
| --- | --- |
| bad_request | 400 |
| validation_error | 422 |
| not_found | 404 |
| method_not_allowed | 405 |
| missing_server_key, invalid_server_key | 401 |
| server_not_configured | 503 |
| missing_auth_token, invalid_auth_token | 401 |
| auth_not_configured | 503 |
| auth_token_expired | 401 |
| auth_unavailable, firestore_unavailable | 503 |
| account_not_allowed | 403 |
| forbidden, network_not_allowed | 403 |
| payload_too_large | 413 |
| rate_limited | 429 |
| feature_disabled, provider_unavailable, queue_full, model_not_ready | 503 |
| internal_error | 500 |

Client actions: with Firebase authentication, `auth_token_expired` means call
`getIdToken(true)` and retry once. For an expired grant, obtain a fresh ID token online
and issue a new grant; offline, show the reconnect message above.
`auth_unavailable` can mean the laptop has no internet to fetch Google's signing certificates;
restore connectivity and retry. `account_not_allowed` means check the account status and add
the intended uid to the allowlist. Revoked tokens use `invalid_auth_token`: sign in again.
`auth_not_configured` requires fixing local Firebase configuration and restarting the server.
`firestore_unavailable` means storage is temporarily unavailable; retry later.
Ownership helpers return `not_found` for both missing resources and resources owned by others.
Firebase errors are visible in health but do not change its model/queue readiness calculation.

All HTTP routes, including health, consume global and per-peer-IP token buckets. Defaults
are 1200/minute globally and 300/minute per IP with an initial burst equal to that rate.
The protected-route verified-user dependency allows 240/minute per uid. 429 responses include integer
`Retry-After` seconds, rounded up with a minimum of 1. Buckets refill continuously and
hold at most 10,000 keys per limiter, evicting least recently seen keys. They reset on restart.

The JSON/default body ceiling is 1,048,576 bytes. Exact chunk paths matching
`/api/v1/sessions/{session_id}/chunks` have an 8,388,608-byte ceiling, including multipart
overhead. Content-Length and streamed bytes are both enforced; if a response has already
started when a streaming overrun occurs, the connection terminates instead of sending a
second response. CORS is absent by default; explicit origins are required when enabled.

## Sessions and chunk upload

All following HTTP routes require both auth headers and the per-user limit. Local session
ownership returns 404 for both missing and other-owner resources. DocIds contain 1-128
ASCII letters, digits, underscores or hyphens, excluding reserved __...__ IDs.

| Route | Request and response |
| --- | --- |
| POST /api/v1/sessions | JSON session_id, event_id, language_mode=auto, expected_languages=[], model_profile=turbo, overlap_ms=0. Verifies parent event ownership in Firestore. New 201; same owner/event ID 200, otherwise 404. Returns SessionOut. |
| POST /api/v1/sessions/{session_id}/chunks | Multipart fields below. New 202; exact duplicate 200; queue_full 503 with Retry-After: 10. |
| GET /api/v1/sessions/{session_id} | after_sequence=-1, limit=500 (1-1000). Chunks ordered by sequence, selected after cursor. |
| POST /api/v1/sessions/{session_id}/finalize | JSON expected_chunk_count (optional/null, 0-100001), force=false. 200 SessionOut when finalized, otherwise 202 {status: finalizing, missing_sequences, pending}. Idempotent. |
| POST /api/v1/sessions/{session_id}/language | JSON {language: auto or configured code}; 200 current language state. Changes apply to future processing; already stored raw text stays unchanged. |
| DELETE /api/v1/sessions/{session_id} | 200 {deleted: true, firestore_deleted: boolean}; 409 session_busy while processing. Closes subscribers and removes local audio/results; cloud deletion is best effort. |

Create example (identifiers are client generated):

```json
{"session_id":"session-1","event_id":"event-1","language_mode":"auto","expected_languages":["kn","en"],"model_profile":"turbo","overlap_ms":2000}
```

Chunk multipart fields: chunk_id (DocId), sequence (0-100000), start_ms (>=0), end_ms
(>start_ms), overlap_ms (0-configured max), continues (boolean, default true), optional
language (per-chunk forced configured code), optional sha256 (64 hex digits), and file.
Declared duration may not exceed MAX_CHUNK_DURATION_S plus overlap. Extensions are checked
against ALLOWED_AUDIO_EXTENSIONS (m4a,mp4,aac,3gp,wav,ogg,webm,flac,mp3 by default);
actual decoding happens in the worker. All multipart overhead counts toward the upload limit.
First/last chunks should accurately declare head overlap and continues=false on the last chunk.

New response: {chunk_id, sequence, status: queued, duplicate: false, queue_depth}.
Duplicate ID plus identical computed content hash returns {duplicate: true, status, chunk}
without another queue entry. A different hash for that ID or another ID for the same sequence
returns chunk_conflict. Client checksum mismatch returns checksum_mismatch. Finalized sessions
reject uploads/overrides with session_finalized; finalizing sessions accept late backlog.

SessionOut includes session_id, event_id, status (active/finalizing/finalized),
transcript_status (pending/complete/partial), model_profile/name, language {mode, locked,
segments: [{language, from_sequence, to_sequence}]}, counts {queued, processing, done, failed,
total}, missing_sequences, chunks, transcript_text, last_event_seq and firestore_sync
(pending/synced/failed/disabled). transcript_text joins all done chunk text in sequence order
when after_sequence=-1; with a pagination cursor it is null. ChunkOut contains chunk_id,
sequence, start_ms/end_ms, status, raw_text, segments [{start_ms,end_ms,text}],
detected_language, language_confidence, language_source (override/auto/locked),
language_uncertain, no_speech, and error_code. Segment times in final output are absolute ms.

No-speech results contain empty text and a no_speech flag, without language detection.
Confidence is nullable for forced language, otherwise reports the restricted renormalized
probability. Uncertain is a warning for review, not an accuracy guarantee. Failed chunks retain
audio and safe error codes: audio_decode_failed, chunk_too_long, transcription_failed.
HTTP additions: chunk_conflict/session_finalized/session_busy 409, unsupported_media_type 415,
checksum_mismatch 422. Finalizing emits session_finalizing, waits for all expected sequences
and queued/processing work, then emits session_finalized. Force permits missing sequences;
missing or failed sequences make transcript_status partial.

## Event vocabulary

POST /api/v1/vocabulary accepts {event_id, terms: [string <=64 chars],
replacements: [{from, to}]}; GET /api/v1/vocabulary?event_id=... returns the same lists.
Both verify event ownership. Terms are trimmed, empty values removed, and deduplicated;
at most VOCABULARY_MAX_TERMS (default 200), joined as model hotwords capped at 400 characters.
At most 200 replacements are stored. Replacements are applied only in the polished layer in
Phase 8, never to raw text in this phase.

## Resumable WebSocket

Connect to /api/v1/sessions/{session_id}/stream?after_seq=0 with the same two HTTP auth
headers. React Native supports new WebSocket(url, protocols, {headers}). Never put tokens
in query parameters; query tokens are not authentication. The server accepts first, then
checks key, token, allowlist, per-user rate and local ownership. On failure it sends
{type: error, code, message} then closes: 4401 auth failure, 4403 account_not_allowed,
4404 not found, 4429 rate limited, 4503 auth unavailable/not configured.

Successful connections receive {type: hello, session_id, status, last_event_seq, server_time},
then ordered persisted events with seq > after_seq, then live events. Save the last received
persisted seq and reconnect with it. Subscription starts before replay; duplicates at the
replay/live boundary are skipped. A subscriber queue overflow closes 4008: reconnect/resume.
Deletion sends session_deleted then closes 1000. The network filter still rejects disallowed
peers with 1008 before this protocol begins.

Persisted envelope: {type, seq, session_id, ts, data}. Event types: session_created,
chunk_queued, chunk_processing, transcript_final, transcript_revised, chunk_failed,
language_locked, language_changed, language_override, session_finalizing, session_finalized,
session_deleted.
transcript_final.data includes chunk_id, sequence, start_ms, end_ms, raw_text, segments,
detected_language, language_confidence, language_source, language_uncertain, no_speech.
transcript_revised.data has the same shape and **replaces** that chunk's text. It is sent when a
neighbouring chunk finishes and the overlap seam between them is re-stitched (e.g. a word that
was cut by the chunk boundary is replaced by the neighbour's complete copy, or a word repeated in
the overlap is removed). Clients render chunks keyed by `sequence` and apply the latest
final/revised payload. Stitching never deletes a word unless the neighbour demonstrably has it.
Overlap guidance: send 1000–1500 ms overlap (`overlap_ms` on every chunk after the first).
The `continues` upload field is accepted for compatibility but no longer affects trimming.
session_finalized.data includes transcript_status, missing_sequences, failed_sequences.

Ephemeral envelope: {type: transcript_partial, session_id, chunk_id, sequence,
data: {start_ms,end_ms,text}}. These segment times are relative to the chunk. Partials have
no seq, are never persisted or written to Firestore, and may disappear on reconnect.
Server ping every 20 seconds; client responds {type: pong}. Send {type: set_language,
language: kn} or language: auto to use the same override as HTTP. Maximum inbound command
is 4096 UTF-8 bytes. Invalid JSON/unknown commands yield an error and keep the socket open.

## Model/queue diagnostics

Health model adds loaded (model names), device_resolved (cuda/cpu/null), compute_type,
load_s, and safe error (model_files_missing/cuda_unavailable/load_failed/null).
languages is {supported: configured codes, default_mode: auto}. Overall status is ok only
when model ready and queue running. Diagnostics adds chunk_counts by status,
average_real_time_factor over the latest 50 done chunks (null when absent), and
cuda_dll_dirs_added (count only). No audio paths, transcripts, credentials or DLL paths appear.
