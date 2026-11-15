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
access. An unset verifier also returns 503; no token is accepted by default. Firebase Admin
initialization and real identity verification arrive in Phase 2. App Check is a documented
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
Use a trusted Private network or Tailscale and a scoped host firewall. TLS, Firebase token
verification, storage authorization, App Check, retention/deletion, backup encryption,
provider request security, and transcription isolation remain later-phase work. Raw
transcripts must never be modified by an LLM unless cleanup is explicitly enabled.
