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
access. An unset verifier also returns 503; no token is accepted by default. Firebase Admin verifies every protected request after the shared key check. App Check is a documented
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
Use a trusted Private network or Tailscale and a scoped host firewall. TLS, App Check, retention/deletion, backup encryption,
provider request security, and transcription isolation remain later-phase work. Raw
transcripts must never be modified by an LLM unless cleanup is explicitly enabled.


## Firebase verification and authorization

Lifespan initializes the named `whisprpersonal` Admin app locally. Missing configuration
or initialization failure selects a disabled verifier: protected requests fail closed
with `auth_not_configured`. Health publishes only status, a safe error code and project-id
presence. Certificate and initialization exception text, paths and credentials are never logged.

Token verification runs via `asyncio.to_thread` on every protected request. Signing
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
access. Firestore failures map to 503 without document data in logs. These helpers are
provided for Phase 3; no session or transcription endpoints are introduced here.

Client rules restrict users to their own profile and events to the owner. Event ownerId
is immutable; event writes validate title and status/privacy enums. Sessions, notes, briefs
and chunks require ownership of the parent event; ownerId on nested records is immutable.
Chunk text is limited to 20,000 characters per raw/polished field. Writes reject secret-named
fields (`apiKey`, `serverKey`, `privateKey`, `secret`, `token`). Unmatched paths are denied.
Event list queries must constrain `ownerId` to the authenticated uid; rules are not filters.

## Known constraint

Firebase ID tokens expire after 1 hour and can only be refreshed with internet access; the
Admin SDK caches Google's signing certificates in memory only. Without internet, the laptop
can verify tokens only while the phone's current token is valid AND the server has fetched
certs since its last restart. Fully offline events need a separate design decision.
