# API reference — Phase 1

Default base URL: `http://127.0.0.1:8000`. Interactive docs are at `/docs`, alternative docs
at `/redoc`, and the schema at `/openapi.json` when `ENABLE_API_DOCS=true`. These surfaces
are behind network/body/rate middleware. Turn them off for a deployment that does not need
them. Responses use UTC timestamps and JSON.

Protected requests require `X-WhisprPersonal-Server-Key` and `Authorization: Bearer <ID token>`.
The Bearer scheme is case insensitive; empty or malformed tokens count as missing.
The shared key is always checked first. No real tokens can pass Phase 1's disabled verifier.
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
| firebase | `{credentials_present: boolean, status: not_initialized}`; existence check only |
| auth | `{shared_secret_configured: boolean, token_verification: disabled}` |
| features | boolean `translation`, `calendar`, `drive`, `gmail`, `app_check`, `fcm`, `web_search`, `cloud_whisper` |

Typical Phase 1 values are `degraded`, `not_loaded`, `not_started`, and unconfigured
providers. Configured providers are never contacted here. Names in the model object are
the configured Whisper names, not a claim that model files exist. No secret or filesystem
path is returned. Security headers include `nosniff`, `no-referrer`, and `no-store`.

## GET /api/v1/diagnostics

Requires both authentication headers. Returns all health fields plus `python_version`,
`platform` (OS family only), `config` from `Settings.safe_summary()`, and `limits` containing
the two body byte limits and three rate limits. Secrets, paths and base URLs in `config`
are replaced by booleans with `_set` names. Returns 503 `server_not_configured` when no
server key is configured, 401 `missing_server_key`/`invalid_server_key` otherwise as
appropriate, 401 `missing_auth_token` for absent/malformed Bearer, and finally 503
`auth_not_configured` for any supplied token. A future verified identity will permit 200.

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
| forbidden, network_not_allowed | 403 |
| payload_too_large | 413 |
| rate_limited | 429 |
| feature_disabled, provider_unavailable, queue_full, model_not_ready | 503 |
| internal_error | 500 |

All HTTP routes, including health, consume global and per-peer-IP token buckets. Defaults
are 1200/minute globally and 300/minute per IP with an initial burst equal to that rate.
A later verified-user dependency allows 240/minute per uid. 429 responses include integer
`Retry-After` seconds, rounded up with a minimum of 1. Buckets refill continuously and
hold at most 10,000 keys per limiter, evicting least recently seen keys. They reset on restart.

The JSON/default body ceiling is 1,048,576 bytes. Exact chunk paths matching
`/api/v1/sessions/{session_id}/chunks` have an 8,388,608-byte ceiling, including multipart
overhead. Content-Length and streamed bytes are both enforced; if a response has already
started when a streaming overrun occurs, the connection terminates instead of sending a
second response. CORS is absent by default; explicit origins are required when enabled.

## Planned endpoints (not registered in Phase 1)

Route names below are provisional; later phases define their full contracts.

| Endpoint / family | Status |
| --- | --- |
| Identity / session domain APIs | planned (Phase 2) |
| POST /api/v1/sessions/{session_id}/chunks | planned (Phase 3) |
| Transcription queue/status and transcript delivery | planned (Phase 3) |
| Android event/session workflows | planned (Phase 4+) |
| Derived text / provider APIs | planned (Phase 8) |
| App Check verification | planned (Phase 10) |

WebSocket identity and application protocols are planned. The network filter already
rejects disallowed WebSocket peers with close code 1008 and sets a correlation context.
