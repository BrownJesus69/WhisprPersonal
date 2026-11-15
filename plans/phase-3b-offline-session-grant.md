# Phase 3b — Offline session grant (12 h laptop-signed pass)

**Working directory:** `E:\Whispr`. Server: `E:\Whispr\server`. Obey `AGENTS.md`.
Starts only after Phase 3 is reviewed and committed (it edits the same auth/config files).

## Why
Owner requirement (2026-11-15): recording must keep working for 10–12 h without internet.
Verified constraints (firebase-admin 7.8.0 on this machine):
- Firebase ID tokens: fixed 1 h lifetime, not configurable; refresh needs internet.
- Custom tokens: max 3600 s (`MAX_TOKEN_LIFETIME_SECONDS`).
- Session cookies: 300 s–14 days (`create_session_cookie(id_token, expires_in)`), but creation
  calls Google and verification fetches public keys from
  `identitytoolkit/v3/relyingparty/publicKeys` (in-memory cache only) → fails after an offline
  server restart. Rejected for this reason.
Decision: a server-minted, HMAC-signed grant verified purely locally.

## Integration points in the current code (Phase 3 committed as 9ae15fb)
- `app/security/auth.py`: `get_current_user(request)` parses the Bearer token and calls
  `request.app.state.token_verifier.verify(token)`; `require_auth` = server key then
  `get_current_user`. Route grants here: tokens starting with `wpg1.` go to
  `app.state.grant_verifier` (when `auth_grant_enabled`), everything else to `token_verifier`.
  Keep the server-key-first order. `/api/v1/auth/grant` must use a dependency that forces the
  Firebase path (reject a `wpg1.` Bearer with 401 `invalid_auth_token`, message "A Firebase
  sign-in is required to issue a grant.").
- `authenticated_user` (`security/rate_limit.py`) wraps `require_auth` + per-user limit; reuse it.
- WebSocket `routers/stream.py` calls `require_auth(websocket)` then `enforce_allowlist` →
  grants work automatically once `get_current_user` routes them; add a stream test.
- `main.py` lifespan builds `token_verifier`; build `GrantService` there (needs `store` for
  revocations and `settings.data_dir` for the key file). `create_app(...)` test overrides must
  keep working.
- `services/store.py`: append migration 3 `CREATE TABLE revoked_grants (jti TEXT PRIMARY KEY,
  uid TEXT, exp INTEGER, revoked_at TEXT)`; prune rows with `exp < now` at startup. Use
  `audit_in`/`audit` for `grant_issued`, `grant_revoked`, `grant_key_rotated` (never the grant).
- Logging redaction (`core/logging.py` `RedactingFilter`): add a pattern for `wpg1\.[A-Za-z0-9_.-]+`.
- Health schema `AuthInfo` and `/api/v1/auth/check` response (`routers/auth.py`) get the new
  fields; update `.env.example` (the config guard test requires every Settings field there),
  `docs/api.md`, `docs/security.md`, `docs/setup.md`, `docs/event-runbook.md` (pre-event:
  "get a grant while online; check `grant_expires_at` covers the event").
- Python 3.12, `hmac`, `hashlib`, `secrets`, `base64` stdlib only — no new dependencies.
- Run tests with `./.venv/Scripts/python -m pytest -q -p no:cacheprovider`; ruff check +
  format clean. All 156 existing tests must keep passing.

## Design
- **Issue:** `POST /api/v1/auth/grant` — requires the server key AND a **Firebase ID token**
  (a grant can never mint another grant; otherwise offline access would be unbounded).
  Re-checks the allowlist. Returns `{grant, expires_at, ttl_s, grant_id}`. Audit
  `grant_issued` (uid, grant_id, exp — never the grant string).
- **Format:** `wpg1.<b64url(payload_json)>.<b64url(HMAC-SHA256(key, "wpg1." + payload_b64))>`.
  Payload: `uid, email, email_verified, sign_in_provider, iat, exp, jti (uuid4 hex), kid`.
  Compact JSON, sorted keys.
- **Key:** `AUTH_GRANT_SIGNING_KEY` (SecretStr, ≥ 32 chars) if set; else 32 random bytes
  generated on first start at `data_dir/grant_signing.key` (file mode 0600 where supported),
  `kid` = first 8 hex of SHA-256(key). Never logged, never returned.
- **Verify (local only, no network):** in the auth path, a Bearer token starting with `wpg1.`
  is routed to `GrantVerifier`; anything else to `FirebaseTokenVerifier`. Checks: structure;
  constant-time HMAC compare; `kid` matches; `iat <= now + skew`; `exp > now - skew`
  (expired → `auth_token_expired`); `jti` not in `revoked_grants` (SQLite); allowlist
  re-check; else `invalid_auth_token`. Returns the same `VerifiedUser` (claims include
  `auth_method: "grant"`).
- **Config:** `auth_grant_enabled: bool = True`, `auth_grant_ttl_hours: float = 12`
  (1–24), `auth_grant_signing_key: SecretStr | None = None`.
- **Revoke:** `POST /api/v1/auth/grant/revoke` (revokes the calling grant's jti, or a
  `grant_id` owned by the caller); `POST /api/v1/auth/grants/rotate-key` (owner-only via
  allowlist; regenerates the key file → every grant invalid). Revoked jtis pruned after exp.
- **Health:** `auth.grants: {enabled, ttl_hours}` (no key material). `/auth/check` reports
  `auth_method: "firebase"|"grant"` and `grant_expires_at`.
- **WebSocket:** grants accepted exactly like Firebase tokens.
- **Client contract (Phase 4–6):** after sign-in and whenever online with a fresh ID token,
  call `/auth/grant`; store the grant in `expo-secure-store`; send it as the Bearer token while
  valid; refresh proactively when < 2 h remain and the network is up; on
  `auth_token_expired` with no internet, show "Reconnect to the internet to renew sign-in".

## Security notes (docs/security.md)
Grant theft = up to TTL hours of access, still gated by the server key and LAN/firewall;
revocable per grant or globally by key rotation; grants never stored in Firestore, logs, or QR.
Firebase account disable/revocation is not observed until the grant expires — documented
tradeoff of the owner's offline requirement.

## Tests
Issue requires a Firebase token (grant → 401); round-trip verify offline with `no_network`;
tampered payload/signature; wrong kid after key rotation; expired → `auth_token_expired`;
future iat; revoked jti; allowlist change takes effect on verify; TTL bounds; key file created
once and reused; grant and key never appear in logs/responses other than the issue response;
WebSocket accepts a grant.
