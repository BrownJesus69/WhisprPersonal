# Initial security model

Phase 1 protects a laptop process on a trusted LAN or Tailscale. Assets include future
event audio and transcripts, provider keys, Firebase credentials, and access to laptop
compute. Threats include unauthorized LAN requests, accidental Internet exposure, large
or high-rate uploads, spoofed proxy headers, and credential leakage through logs or QR codes.

The socket peer must be in the configured allowlist. Defaults include loopback, RFC1918
IPv4, Tailscale CGNAT `100.64.0.0/10`, IPv6 loopback, unique-local and link-local ranges.
Unparsable peers fail closed. Public peers receive 403, WebSocket peers close with 1008.
This is a network boundary, not user identity: anyone sharing an allowed LAN can reach
health. The default bind is all interfaces for phone access; use a loopback bind for
local development and firewall controls for LAN operation.

**Docker Desktop caveat (Windows/macOS).** Docker Desktop's port-forwarding proxy rewrites
the source address, so the container sees every client as a Docker-internal gateway IP
(for example `192.168.65.1` or `172.17.0.1`), which is inside the private allowlist. Under
Docker Desktop the network allowlist therefore does **not** distinguish LAN clients from
anything else that can reach the published port, and the per-IP rate limit becomes one
shared bucket. The effective network boundary is the host firewall: allow inbound TCP 8000
only on the **Private** network profile (and the Tailscale interface), never Public. The
shared secret and Firebase token remain the real access control. Native Linux Docker and
non-Docker runs see true client IPs.

Forwarded headers are ignored by the application unless `TRUST_PROXY_HEADERS=true`.
Keep this false for direct access. The Docker command disables Uvicorn proxy rewriting;
non-Docker commands must do the same. Opt-in uses the first X-Forwarded-For address and
requires a controlled proxy that overwrites that header and is the only reachable peer.
No trusted-proxy IP allowlist or TLS termination is implemented in Phase 1. Rate limits
use the socket peer, so proxied traffic shares its proxy's per-IP bucket.

Protected routes require a minimum 32-character shared secret, compared in constant time
as UTF-8 bytes, before token verification. An unset secret returns 503 rather than allowing
access. An unset verifier also returns 503; no token is accepted by default. After the shared
key check, Firebase Admin verifies ID tokens and the local grant verifier handles `wpg1.`
tokens. App Check is a documented
no-op until Phase 10, even with its feature flag enabled.

Secrets use `SecretStr`. Keep credentials in git-ignored `secrets/`, mounted read-only
in Docker, and server settings in an untracked `server/.env`. Never copy credentials into
the app, image, Firestore, QR, logs or reports. The existing root `.env` belongs to the user;
launchers only create a missing server `.env` and never modify an existing one. Launchers
inspect credential filenames without reading their contents. Exactly one safely named
JSON file permits automatic path configuration. New server keys print once for private
entry into app Settings; URL QR codes contain no key, credentials, query or fragment.

Health and diagnostics expose configuration booleans instead of credentials and paths.
Logs use one structured line per event and redact active secret values, Bearer tokens,
server-key headers, known key prefixes, and private-key PEM blocks, including extras and
tracebacks. Exception tracebacks remain server-side; restrict access to logs because they
can contain operational details. Redaction is defense in depth, not permission to log
arbitrary application payloads. Access lines omit query strings, headers and bodies.

Body limits cover declared and streamed bytes. In-memory token buckets bound request rates
and memory; they are per-process, reset on restart, and are not distributed abuse prevention.
CORS is off unless explicit origins are configured, with no credentials and no wildcard.
Baseline headers discourage MIME sniffing, referrer disclosure, and caching API/health data.
The non-root container drops capabilities and uses no-new-privileges. Host bind mounts
still require appropriate permissions and private backups.

HTTP provides no transport confidentiality. Avoid port forwarding or public exposure.
Use a trusted Private network or Tailscale and a scoped host firewall. TLS, App Check, backup encryption,
provider request security, and transcription isolation remain later-phase work. Raw
transcripts must never be modified by an LLM unless cleanup is explicitly enabled.


## Firebase verification and authorization

Lifespan initializes the named `whisprpersonal` Admin app locally. Missing configuration
or initialization failure selects a disabled verifier: protected requests fail closed
with `auth_not_configured`. Health publishes only status, a safe error code and project-id
presence. Certificate and initialization exception text, paths and credentials are never logged.

Firebase token verification runs via `asyncio.to_thread` on each Firebase-authenticated request. Signing
certificates come from Google over HTTPS and are cached by the SDK in memory. Expired,
revoked, disabled-user, malformed-token and certificate-fetch failures have distinct safe
error mappings. Unexpected SDK errors log the exception type only. Token contents and SDK
messages never appear in responses or logs. Only a small allowlist of claims is retained.
App Check remains unenforced until Phase 10.

Optional account allowlists admit a matching uid OR a matching verified email. Email
matching is case-insensitive and requires `email_verified == True`. Empty lists admit any
verified user of this Firebase project with the server key and produce a startup warning.
Allowlist values never appear in configuration summaries; only counts do. Denial logs uid only.
Revocation checking defaults off; enabling it adds a network call per protected request.

The Admin SDK bypasses Firestore rules, so `security/ownership.py` enforces parent-event
ownership itself. Missing events and events owned by another user both return the same
404 `not_found`, preventing existence leaks. Identifier validation runs before database
access. Firestore failures map to 503 without document data in logs. Sessions enforce ownership against local SQLite owner_uid; creating a session and
reading/writing vocabulary also verify the parent event through Firestore.

Client rules restrict users to their own profile and events to the owner. Event ownerId
is immutable; event writes validate title and status/privacy enums. Sessions, notes, briefs
and chunks require ownership of the parent event; ownerId on nested records is immutable.
Chunk text is limited to 20,000 characters per raw/polished field. Writes reject secret-named
fields (`apiKey`, `serverKey`, `privateKey`, `secret`, `token`). Unmatched paths are denied.
Event list queries must constrain `ownerId` to the authenticated uid; rules are not filters.

## Offline session grants (owner requirement, 2026-11-15)

Recording must continue for 10-12 hours without internet. Firebase ID tokens expire after
one hour; refreshing them needs internet. Custom tokens also cannot extend this lifetime.
Firebase session cookies require Google for creation and Google's public keys for verification,
with an in-memory cache that does not survive an offline restart. They are not used here.

While online, present the server key and a Firebase ID token to issue a laptop-signed
grant. A grant can never issue another grant. The default TTL is 12 hours; configuration
allows 1-24 hours. The format is
`wpg1.<base64url(payload_json)>.<base64url(HMAC-SHA256(key, "wpg1." + payload_b64))>`.
JSON uses compact separators and sorted keys. Claims are uid, email, email_verified,
sign_in_provider, iat, exp, a UUID4 hex jti, and kid (first eight SHA-256 hex characters
of the key). Payloads are signed, not encrypted; treat the entire grant as a credential.

Verification checks structure/types, constant-time HMAC comparison, kid, future issuance
and expiry using `FIREBASE_CLOCK_SKEW_S`, SQLite revocations and the current allowlist.
It makes no network calls and returns the same verified identity for HTTP and WebSocket
authentication. Account allowlist changes apply immediately to new authentication attempts.
An already-open stream authenticates at connection time; reconnect to apply auth changes.

An optional `AUTH_GRANT_SIGNING_KEY` is a SecretStr of at least 32 characters. Otherwise
the server generates 32 random bytes once in `DATA_DIR/grant_signing.key`, requests mode
0600 where supported, and reuses it across restarts. Protect DATA_DIR and its backups;
on Windows restrict directory access with NTFS ACLs. Keep the key file with the SQLite
database. An unreadable or invalid key disables grants safely while Firebase remains
available. If the file is lost, a new key is generated and old grants become invalid.
The key is never returned or logged. Environment-managed keys take precedence;
rotate them externally and restart. The rotation API rejects that configuration rather
than replacing an unused file or changing private environment files.

Callers can revoke their own jti or an owned grant_id; ownership is checked against local
issuance audit records. Explicit allowlist owners can rotate the file key atomically,
invalidating every outstanding grant, including the caller's. Empty account allowlists
never authorize global rotation. Audit actions `grant_issued`, `grant_revoked` and
`grant_key_rotated` contain IDs/expiry only, never tokens or keys. Expired revocations
are pruned at startup after the maximum 60-second verification skew window.

Grant theft permits up to TTL hours of access, still gated by the server key and LAN/firewall.
Grants belong only in the client's secure store, never Firestore, logs or QR codes. Logs
redact bare `wpg1.` tokens in addition to Bearer values. Firebase account disable/revocation
is not observed until the grant expires: this is the accepted tradeoff for offline access.
Use local revocation or rotation for immediate rejection on subsequent authentication.

Get a grant online and check `grant_expires_at` covers the event. Local transcription needs
cached models with `WHISPER_LOCAL_FILES_ONLY=true`. Create the session while online:
parent-event ownership and vocabulary still use Firestore; grants remove the authentication
network dependency, not those cloud operations. Existing local session uploads, transcripts
and streams continue offline; cloud finalization sync can retry later.


## Phase 3 local storage and streams

SQLite stores raw transcript text and vocabulary locally under DATA_DIR; protect the disk
and backups. The audit log records IDs, safe codes, model, duration and real-time factor,
never audio or transcript text. Audio defaults to keep; delete_on_finalize removes audio
only after the session has finalized. Failed chunks keep audio for investigation/retry.
Explicit session deletion cascades local rows/audio, rejects processing sessions, closes
subscribers and attempts deletion of cloud chunks and metadata. Cloud deletion failures
are reported separately and need operator follow-up.

Uploads validate DocIds before building paths, cap streamed bytes, hash content and use
atomic renames. Duplicate uploads never requeue completed work. Decode is isolated from the
event loop in the single inference executor; extension allowlisting does not claim the
content is decodable. Midpoint overlap trimming operates only on raw word timestamps.
No LLM calls or vocabulary replacements modify raw text. Partial text travels only over
authenticated WebSockets and is not stored in replay events or Firestore. Final chunk text
is synchronized to Firestore only on session finalization. SQLite remains authoritative
when the cloud is unavailable. WebSockets accept credentials only in headers, enforce
local ownership and bounded subscriber queues, and close overflowed clients for replay.

## Offline event ownership (added with Phase 3b)

The laptop verifies event ownership against Firestore with the Admin SDK. To keep recording
when the venue has no internet:

- Every successful online check is cached in the local `event_owners` table. A cached event
  works offline; a cached event owned by someone else is still rejected with 404.
- A session for an event never verified on this laptop can still start offline. It is created
  under the caller's verified uid with `ownership_pending=1` and is **never written to
  Firestore** until ownership is verified online:
  - verified owner -> pending cleared, cached, normal sync;
  - event not in Firestore yet (the phone has not uploaded it) -> retried later;
  - event owned by another user -> `firestore_sync=disabled`, `firestore_error=ownership_mismatch`,
    audited, never retried. Its transcript stays local to the laptop.
- Vocabulary is local-only data and may be saved offline for unverified events.
- Firestore ownership lookups are bounded by `FIRESTORE_TIMEOUT_S` (10 s) and fail fast for 30 s
  after a failure. Measured offline: first session start 10.0 s, subsequent 0.0 s.

## Phone note protection (Phase 7)

Only the authenticated event owner can access `events/{eventId}/notes/{noteId}`. Note writes
must match the exact 14-field contract in `docs/api.md`; extra fields, including secret-like
keys, are rejected. Text is at most 5000 characters and is empty exactly for tombstones;
tombstones also clear the speaker. Revision/baseRevision, recording offset and sequence are
integers. `createdAt`, owner and source cannot change; `updatedAt` must equal request time.

Updates use compare-and-set against the server revision. The same installation may advance
its own queued writes; same-version retries may only change `updatedAt` and `baseRevision`.
A stale write from a different device is denied and surfaced as a conflict, preserving the
local copy. The app never hard-deletes note documents. Existing event/session/chunk/brief/user
rules retain their previous behavior. Deploy the reviewed rules with the app release.

`deviceId` is a random UUID stored in the phone's ordinary SQLite key/value store. It is not
a secret or authentication credential; event ownership is always enforced separately by
Firebase Auth and rules. SQLite reads/search/pushes are scoped to the signed-in uid, and
asynchronous sync results stop applying when the account changes. No note or credential
contents are included in invalid-document logs. The rules tests use a demo project and the
local emulator only; Android tests mock every external service.
