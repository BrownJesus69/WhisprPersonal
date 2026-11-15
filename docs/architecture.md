# Architecture

WhisprPersonal keeps planned transcription on a laptop, with an Android client connecting
over LAN or Tailscale. Optional cloud providers enhance derived text in later phases.

```text
Planned:
 Android recorder --> FastAPI --> bounded queue --> Whisper / VAD
       |                 |                              |
 Firebase ID token ------+--> Firebase verification     +--> raw transcript
                         |                              |
                         `--> optional LLMs <------------+--> derived output

Phase 2 request path (outermost first):
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
subprocess fallback has a three-second timeout. No inference models are loaded.

`ServerState` starts with a UTC timestamp, GPU summary, `model_status=not_loaded`,
`queue_status=not_started`, and zero queue depth. Phase 3 will own model and queue
transitions, and shutdown will gain queue draining. A single process holds the future
Whisper model and in-memory buckets. Multiple workers would split limits and duplicate
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
Shutdown deletes the initialized Admin app. No session/chunk APIs, audio ingestion, VAD,
inference or LLM HTTP calls are implemented. Signing certificates are memory-only and token
refresh requires internet; see [security.md](security.md#known-constraint).

Errors have one envelope and correlate to `X-Request-ID`. Pure ASGI middleware preserves
streaming and WebSocket scopes without buffering request bodies. Bodies are bounded
both by declared Content-Length and bytes actually received. Access logs include path
without query strings, method, status, latency, and peer IP; they omit headers and bodies.

Docker persists future models and event data in separate mounts. Credentials use a
read-only mount outside the build context. The container runs as uid/gid 10001 with no
capabilities and no privilege escalation. CUDA libraries in the base image do not require
a GPU reservation; the optional Compose override requests one NVIDIA device.
