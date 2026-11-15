# WhisprPersonal setup

Use Python 3.11+ (the development environment uses 3.12). Docker users need Docker Engine
or Docker Desktop with Compose v2. Windows launchers support Windows PowerShell 5.1;
Linux/macOS launchers need Bash and curl, plus Python 3 or OpenSSL for secret generation.
Windows Docker Desktop must use Linux containers. NVIDIA GPU use additionally requires
a compatible driver and NVIDIA container support; the base Compose file needs no GPU.
Firebase Admin is included in the server dependencies. With `WHISPER_PRELOAD=false`, startup needs no model or network connection.
With preload enabled (the default), startup downloads a missing model unless local-only mode is set. Firebase credentials are optional.

## Docker quick start

From `E:\Whispr\server`, double-click `start.bat` or run it from a terminal. On Linux/macOS,
run `bash server/start.sh` from the repository root, or `chmod +x server/start.sh` once and
then `./server/start.sh`. Both launchers change into the server directory.

On first launch only, the script copies `.env.example` to `server/.env`, generates a shared
secret, and prints it once with a private-entry reminder. Keep that value privately; it
is not in the QR code. Existing server `.env` files are never rewritten. If one JSON file
with a safe filename exists in `../secrets/`, the launcher records its container path but
does not open it. The server reads that service account locally during Firebase initialization.
The root `.env` is never used by the launchers.

The script creates models/data directories, selects the NVIDIA override when supported,
builds and starts the service, polls health for up to 180 seconds, waits up to 20 minutes for model readiness, runs selftest, prints LAN
and Tailscale URLs, prints a LAN QR, and opens docs. Windows prefers a DHCP LAN address and
excludes virtual/Tailscale adapters; Linux uses `hostname -I` and macOS uses `en0`. On Linux,
check the printed address if multiple physical/virtual interfaces exist. The QR contains
only a connection URL. The Android app scans the URL and records locally; enter the key separately.

Manual equivalents, after privately creating `server/.env` from the example:

```text
cd server
docker compose -f docker-compose.yml up -d --build
docker compose exec -T server python -m app.cli selftest
docker compose logs --tail 50 server
docker compose down
```

For a GPU add `-f docker-compose.gpu.yml` to every Compose invocation. Validate with
`docker compose -f docker-compose.yml -f docker-compose.gpu.yml config --quiet`.
To validate before a server `.env` exists, add `--no-env-resolution --env-file .env.example`
(the global `--env-file` option belongs before `config`). Avoid printing resolved Compose
configuration in shared logs because it can expose secrets.

The container runs as uid/gid 10001. On Linux, ensure host `models/` and `data/` bind mounts
are writable by that uid. The read-only secret mount must be readable by
the container user when Firebase integration arrives. The Docker image's directory
ownership does not override permissions on host bind mounts.

## Non-Docker development

An existing `server/.venv` is provided on the development machine. For a fresh checkout:

```powershell
cd E:\Whispr\server
py -3.12 -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements-dev.txt
.\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-proxy-headers
```

On Linux/macOS use `python3 -m venv .venv` and `.venv/bin/python` instead. A `.env` is
optional; running from `server/` with no file uses safe defaults. For private LAN access,
bind `--host 0.0.0.0` and configure the firewall. Always use `--no-proxy-headers` for direct
access so the application sees the real socket peer. Set a shared secret yourself via
your environment or a private server `.env` if you need to test auth responses. You can
generate one with `python -m app.cli gen-secret`. Never put credentials into commands or
URLs you share. Diagnostics require a configured Firebase service and a valid ID token.

Visit `/health` and `/docs`, then run `python -m app.cli selftest` from the same environment.
With `WHISPER_PRELOAD=false`, expect HTTP 200, `degraded`, `not_loaded`, `running`.
With the default preload, model status progresses through `loading` to `ready` or a safe
`error` code; overall health becomes `ok` when the model is ready and the queue is running. GPU probing
is best effort and never blocks core startup on a missing driver/tool. Use
`GPU_DETECTION=off` to disable it. Selftest reports validity and reachability, not model
readiness. API docs can be disabled without affecting health.

## Environment reference

Environment names are case insensitive. `.env` is relative to the current working
directory. Extra names are ignored. Comma lists accept whitespace around entries;
empty lists are written as an empty value. Optional empty values mean unconfigured.
Empty Whisper model values use the Settings defaults. Provider keys without a model
remain `not_configured`; configured providers report `configured_unchecked` without calls.

| Variable | Default | Purpose |
| --- | --- | --- |
| APP_ENV | development | development or production |
| LOG_LEVEL | INFO | Python logging level |
| LOG_FORMAT | json | json or console, both redacted |
| PORT | 8000 | Application configuration; pass Uvicorn `--port` separately for non-Docker |
| ENABLE_API_DOCS | true | Enables /docs, /redoc, /openapi.json |
| SERVER_SHARED_SECRET | empty | SecretStr, at least 32 characters when set |
| FIREBASE_CREDENTIALS_PATH | empty | Local file or `/run/secrets/whisprpersonal/<file>.json`; initialized locally at startup |
| FIREBASE_PROJECT_ID | empty | Optional Firebase app project override |
| FIREBASE_CHECK_REVOKED | false | True adds a network call per protected request |
| FIREBASE_CLOCK_SKEW_S | 5 | Token clock tolerance, integer 0-60 seconds |
| FIREBASE_DATABASE_ID | empty | Empty selects `(default)` |
| AUTH_ALLOWED_UIDS | empty | Comma-separated alphanumeric uids, each 1-128 characters |
| AUTH_ALLOWED_EMAILS | empty | Comma-separated emails; case-insensitive, verified claims only |
| GROQ_API_KEY | empty | Optional SecretStr |
| GROQ_BASE_URL | https://api.groq.com/openai/v1 | Reserved provider endpoint |
| GROQ_MODEL | empty | Choose a model your account can access; [provider docs](https://console.groq.com/docs) |
| GROQ_TIMEOUT_S | 30 | Provider timeout in seconds |
| GROQ_MAX_CONCURRENCY | 2 | Provider concurrency bound |
| GROQ_MAX_RPM | empty | Optional positive account-specific limit; no quota assumed |
| SAMBANOVA_API_KEY | empty | Optional SecretStr |
| SAMBANOVA_BASE_URL | https://api.sambanova.ai/v1 | Reserved provider endpoint |
| SAMBANOVA_MODEL | empty | Choose a model your account can access; [provider docs](https://docs.sambanova.ai/) |
| SAMBANOVA_TIMEOUT_S | 30 | Provider timeout in seconds |
| SAMBANOVA_MAX_CONCURRENCY | 2 | Provider concurrency bound |
| SAMBANOVA_MAX_RPM | empty | Optional positive account-specific limit; no quota assumed |
| LOCAL_LLM_BASE_URL | empty | Optional local endpoint |
| LOCAL_LLM_MODEL | empty | Both local URL and model required for configured=true |
| WHISPER_MODEL | large-v3-turbo | Primary transcription model; empty example uses default |
| WHISPER_FALLBACK_MODEL | large-v3 | Accurate profile; empty example uses default |
| WHISPER_DEVICE | auto | auto, cuda or cpu; preference, not detected device |
| WHISPER_COMPUTE_TYPE | float16 | Inference compute type; CPU float16/bfloat16 resolves to int8 |
| MODELS_DIR | ./models | Docker overrides to /models |
| DATA_DIR | ./data | Docker overrides to /data |
| QUEUE_MAX_DEPTH | 500 | Durable queue capacity |
| WORKER_COUNT | 1 | Exactly one queue worker; Uvicorn stays single process |
| MAX_CHUNK_UPLOAD_BYTES | 8388608 | Exact session/chunks path ceiling including multipart overhead |
| MAX_JSON_BODY_BYTES | 1048576 | All other HTTP body ceiling |
| RATE_LIMIT_GLOBAL_PER_MINUTE | 1200 | Global token bucket rate and burst |
| RATE_LIMIT_PER_IP_PER_MINUTE | 300 | Per socket peer IP rate and burst |
| RATE_LIMIT_PER_USER_PER_MINUTE | 240 | Verified uid limit for protected routes |
| ALLOWED_CLIENT_NETWORKS | See below | Comma-separated CIDRs; invalid CIDRs reject startup |
| TRUST_PROXY_HEADERS | false | Explicit X-Forwarded-For trust; requires controlled proxy |
| CORS_ALLOWED_ORIGINS | empty | Comma-separated explicit origins; wildcard rejected |
| GPU_DETECTION | auto | auto or off |
| FEATURE_TRANSLATION | false | Future translation flag |
| FEATURE_CALENDAR | false | Future calendar flag |
| FEATURE_DRIVE | false | Future Drive flag |
| FEATURE_GMAIL | false | Future Gmail flag |
| FEATURE_APP_CHECK | false | No-op until Phase 10 |
| FEATURE_FCM | false | Future notification flag |
| FEATURE_WEB_SEARCH | false | Future web search flag |
| FEATURE_CLOUD_WHISPER | false | Future cloud transcription flag |

Default CIDRs: `127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,::1/128,fc00::/7,fe80::/10`.
An empty network list denies every peer, including Docker health checks.

`WHISPRPERSONAL_BIND` (default `0.0.0.0`) and `WHISPRPERSONAL_PORT` (default `8000`) are Compose
host settings, not Settings fields. Shell environment values override Compose `.env` values.
Launchers also read a numeric `WHISPRPERSONAL_PORT` from server `.env` if it is absent from the
shell, keeping the polling URL consistent. Docker always listens on container port 8000.
`HF_HOME=/models/hf` is set by the image for later model caching.

## Windows firewall — Private profile only

Confirm that your trusted event LAN uses the Private Windows network profile. From an
Administrator PowerShell, create a narrowly scoped rule (change the port if needed):

```powershell
New-NetFirewallRule -DisplayName 'WhisprPersonal LAN' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8000 -Profile Private -RemoteAddress LocalSubnet
```

Do not enable it for Public or Domain profiles. Tailscale may need a separately scoped
Private-profile rule for the intended Tailscale peer addresses. Never open a router port
or expose this HTTP endpoint publicly. To remove the rule after use:

```powershell
Remove-NetFirewallRule -DisplayName 'WhisprPersonal LAN'
```

## Verification and troubleshooting

Run the three checks in [server/README.md](../server/README.md) before handoff. Tests use
in-process TestClient with loopback peer addresses and MockTransport, never live external
services. Starlette in the pinned stack emits an httpx deprecation warning; retain the
requested pins instead of installing an additional transport dependency.

If Docker health times out, inspect `docker compose logs --tail 50 server` privately.
Check the server `.env` values without sharing them, bind/port, network allowlist, mount
permissions and Docker status. An invalid secret/CIDR/origin causes configuration failure;
an unset secret permits health but protected routes fail closed. `not_configured` Firebase and
disabled token verification are expected without credentials;
an unloaded model is expected only when preload is disabled.


## Firebase identity and Firestore

Enable **Email/Password** under Firebase console > Authentication > Sign-in method.
Google Sign-In remains disabled until its feature flag and native configuration are enabled. Store the service account locally under git-ignored
`secrets/`. Never include it in an app bundle or commit it. For non-Docker use, set
`FIREBASE_CREDENTIALS_PATH` to its absolute local path in your private environment or server
configuration. Docker uses the existing read-only secret mount. Startup parses the local
service account and initializes a named Admin app without contacting Firebase.

With no path, health reports `not_configured`. A missing or invalid file reports `error`
with a safe reason; token verification remains disabled and protected requests fail closed.
`ready` indicates local initialization, not verified connectivity to Auth or Firestore.

Deploy rules and indexes using the instructions in [firebase/README.md](../firebase/README.md):

```sh
npx firebase-tools deploy --only firestore:rules,firestore:indexes --project <id>
```

Initially empty allowlists allow any verified user of this Firebase project who has the
server key; startup warns about this. After your first sign-in, call `/api/v1/auth/check`,
then set `AUTH_ALLOWED_UIDS` to your own uid and restart. Uids must be alphanumeric, 1-128
characters. Alternatively, `AUTH_ALLOWED_EMAILS` matches only verified email claims. When
either list is set, a match in either list grants access. Diagnostics show counts only.
`FIREBASE_CHECK_REVOKED=true` checks revoked/disabled accounts with an extra network call
on every Firebase-authenticated request; the default is false. See the offline grant tradeoffs in
[security.md](security.md) before planning events without internet.


## Offline sign-in preparation (Phase 3b)

While online, sign in with Firebase and POST `/api/v1/auth/grant` using the server key and
fresh Firebase ID token. Keep the returned grant in `expo-secure-store` on the client;
send it as Bearer for HTTP and WebSocket requests. GET `/api/v1/auth/check` then reports
`auth_method=grant` and `grant_expires_at` (Unix seconds). Ensure expiry covers the event.
Create/open the event and load vocabulary before disconnecting. Ownership checks tolerate
Firestore outages for local transcription; unknown ownership defers cloud writes.

`AUTH_GRANT_ENABLED=true` and `AUTH_GRANT_TTL_HOURS=12` are defaults (TTL bounds 1-24).
Leave `AUTH_GRANT_SIGNING_KEY` empty to generate/reuse `DATA_DIR/grant_signing.key`.
Preserve DATA_DIR across restarts and container recreation, protect directory permissions
and backups, and never distribute the key. An externally supplied signing key must have
at least 32 characters and stays in private configuration. No Firebase certificate cache
or internet is needed to verify an existing grant after laptop restart.

Set your own uid/verified email allowlist before using key rotation. Revoke a grant with
POST `/api/v1/auth/grant/revoke` and JSON `{grant_id}` (omit the body to revoke the calling
grant). POST `/api/v1/auth/grants/rotate-key` invalidates all grants backed by the file key.
For an environment-managed key the API returns `feature_disabled`; change the private
configuration externally and restart. Firebase sign-in is needed to issue replacement grants.

Renew online with a fresh Firebase ID token when less than two hours remain. If a grant
expires offline, show "Reconnect to the internet to renew sign-in". Disabling grants or
changing the key invalidates grant access; Firebase account revocation alone is not seen
until expiry. Loaded local transcription with `WHISPER_LOCAL_FILES_ONLY=true` needs no internet.

## Whisper models and offline preparation

Run `python -m app.cli download-models` from `server/` while internet is available.
Add `--fallback` to also cache the accurate `large-v3` model. The command prints downloaded
sizes and uses the same `MODELS_DIR` cache as inference. Then set
`WHISPER_LOCAL_FILES_ONLY=true` in your private configuration. Restart and wait for
`/health` model.status=`ready` before going to an event. Launchers wait for readiness,
print loading progress every 10 seconds, and stop on model error or a 20-minute timeout.
`WHISPER_PRELOAD=false` provides liveness-only development without downloading models;
chunks remain queued until a model is ready.

The default turbo alias resolves to `mobiuslabsgmbh/faster-whisper-large-v3-turbo`;
accurate resolves to `Systran/faster-whisper-large-v3`. One executor serializes inference.
Auto device selects CUDA when available, otherwise CPU. CPU changes float16/bfloat16 to
int8 and logs that decision. `WHISPER_MAX_LOADED_MODELS=1` evicts the least recently used
model before loading the other profile; set 2 only with sufficient memory.

On Windows, optional runtime wheels are pinned in `requirements-windows-gpu.txt`.
The server adds NVIDIA wheel bin directories to both the DLL loader and PATH before
native imports. Docker uses system CUDA libraries. Keep `av==17.0.0`: av 19 removed the
metadata_errors argument used by the pinned faster-whisper decoder.

All Phase 3 configuration and comments are in [the public environment example](../server/.env.example).
Supported languages default to `kn,ta,hi,en`; extend `SUPPORTED_LANGUAGES` with valid
Whisper codes (for example te,ml,mr,bn,gu,pa). Sessions can restrict expected languages or
force a code; low confidence and out-of-set detections are flagged as uncertain.
Language window, lock and switch settings control hysteresis, not an accuracy guarantee.
Chunk duration defaults to 30 seconds plus declared overlap (maximum 3000 ms), with three
attempts and exponential jittered backoff. Shutdown drains for 20 seconds, below Compose's
30-second grace period. Queue limits, upload limits and retention apply independently.

Run offline tests with `.venv/Scripts/python -m pytest -q -p no:cacheprovider`.
The real GPU smoke test remains skipped unless `WHISPR_RUN_GPU_TESTS=1` and turbo files
already exist in server/models. It retains the no_network fixture and never downloads.

## Optional AI providers (Phase 8a)

Leave provider keys/models empty to disable intelligence; transcription works independently.
In your private configuration, enable Groq with both `GROQ_API_KEY` and `GROQ_MODEL`, selecting
a model your account can access. SambaNova similarly requires `SAMBANOVA_API_KEY` and
`SAMBANOVA_MODEL`. Nothing is assumed about accessible models or quotas. Default API bases
are `https://api.groq.com/openai/v1` and `https://api.sambanova.ai/v1`. Local inference requires
`LOCAL_LLM_BASE_URL` and `LOCAL_LLM_MODEL`; `LOCAL_LLM_API_KEY` is optional. Point this URL
at a trusted OpenAI-compatible service on the laptop. The URL must use a loopback address
(`localhost`, `127.0.0.1` or `::1`), HTTP(S), and no embedded credentials or query/fragment.
Restart after configuring providers.

Use authenticated `GET /api/v1/ai/status` to inspect local eligibility, or explicitly request
`POST /api/v1/ai/providers/check` to probe `/models`. Health and startup never contact an LLM.
The phone must set the owner's event `privacyMode` to `cloud_ai` to allow cloud calls;
`local_only` permits only local inference. Firestore must be reachable to verify privacy.
Requests still require finalized sessions (briefs may explicitly allow incomplete input).

`AI_*` defaults in `.env.example` are this laptop's safety limits, **not provider quotas**:
12,000 input characters per prompt's content window, 2048 output tokens, temperature 0.2,
three attempts, single waits capped at 20 seconds, circuit threshold three/cooldown 60 seconds,
six submissions/user/minute, 20 globally/minute, eight waiting jobs, 600 seconds/job and 200
owner notes. `*_TIMEOUT_S` and `*_MAX_CONCURRENCY` bound provider operations;
`*_MAX_RPM` is an optional local cap and remains unset by default. No additional dependency
or model download is needed for the AI layer. With no provider configured, submissions for
verified cloud-enabled events return `provider_unavailable` while raw transcripts stay intact.


## Android APK build and installation

Prerequisites: installed project dependencies, Node compatible with this Expo SDK, the
owner's Firebase Android client configuration, and a phone with microphone permission.
The client package is fixed to `com.aditya.whisprpersonal`. Never publish the service
account or provider keys with the APK. A native rebuild is required for expo-sharing;
do not add its config plugin, which would register an incoming share target.

### Local Windows build on E:

Use `android/scripts/windows-build/build-apk.ps1` and the cache/bootstrap instructions in
[android/README.md](../android/README.md#local-native-builds-on-this-laptop-verified-2026-11-15).
This keeps SDK, Gradle, npm and temporary build paths on E:. Review that guide's memory,
CMake path and pagefile notes first. Do not hand-edit generated native projects.

### EAS preview APK

Run these owner actions from `android/` while online (they were not executed as part of
Phase 9). EAS uploads build input to Expo; review what is being uploaded privately.

```powershell
npx eas-cli@latest login
npx eas-cli@latest init
```

`app.config.js` is dynamic. Add the printed `extra.eas.projectId` to its returned config
manually, preserving the existing `extra` values. Upload the Firebase client config as a
secret file variable and build the preview profile:

```powershell
npx eas-cli@latest env:set --name GOOGLE_SERVICES_JSON --type file --value ./app/google-services.json --visibility secret --environment preview
npx eas-cli@latest build -p android --profile preview
```

The preview profile produces an APK. Ensure the dynamic config uses
`process.env.GOOGLE_SERVICES_JSON` when provided by EAS, with the existing local client
configuration path as the local-build fallback. Never paste client configuration into a
command or commit a secret file. Check [eas.json](../android/eas.json) before building.

### Sideload

Install the downloaded APK over USB with `adb install -r <apk>`, or open the EAS build URL
on the phone and download/install it. For the browser or file manager doing installation,
enable Android Settings > Install unknown apps. Play Protect may warn about debug-signed
builds; verify the APK source before accepting any warning. Local builds currently use a
debug signature. An update must use the same signing identity; increase `android.versionCode`
for each newer install over an older release. Different signing identities require an
explicit uninstall (which removes phone data) or rebuilding with the correct identity.

## Phone connection and first recording

Start the laptop and wait for model readiness. Keep both devices on the same trusted
Wi-Fi/hotspot without client isolation. Scan QR from Connect laptop, or enter its LAN host
and port; enter the shared key privately. Test connection and sign-in and inspect pass
expiry in Settings. On a physical phone localhost points to the phone; the Android emulator
can reach its host at `10.0.2.2`. For Tailscale, sign both devices into the intended tailnet,
allow the peer/port, and use the laptop's Tailscale address. Public router port forwarding
is unnecessary and unsafe. Test after laptop restart with internet disabled.

| Problem | Action |
| --- | --- |
| Laptop unavailable | Check power, server process, Wi-Fi/client isolation, host/port and Private firewall rule; test Tailscale peer access |
| Sign-in disabled | Owner enables Email/Password in Firebase console and checks the project's client configuration |
| Protected endpoints return 503 | Configure shared secret and Firebase service locally; inspect safe diagnostics, never share credentials |
| Pass expired offline | Reconnect internet and renew sign-in; phone audio stays queued |
| Model not ready / CUDA error | Pre-download model, verify NVIDIA driver/CUDA runtime and DLL setup; CPU is slower; preserve `av==17.0.0` |
| Firestore permission/index error | Owner deploys rules and indexes to the correct project; verify event ownership |
| AI not configured | Configure provider key AND an accessible model, or local endpoint/model; raw transcription still works |
| APK will not update | Check signing identity and increase versionCode; preserve recordings before any uninstall |
| Share unavailable | Install/enable a receiving app and rebuild the native APK with expo-sharing |
| Recording stops when locked | Check microphone/notification permission, battery optimization and OEM restrictions; rehearse on the actual phone |
| Laptop copy pending deletion | Reconnect with the same account and laptop, reopen app, check diagnostics pending server deletes reaches zero |

## Optional Phase 10a local translation

Translation setup is independent of Whisper. Keep the existing venvs; no additional dependency
installation is needed for this phase. Follow [translation.md](translation.md) for gated HF
terms/login, pinned model downloads, shared-secret configuration and offline verification.

From the repository root, run `translator/run_translator.ps1` (loopback 8100) and, if desired,
`translator/run_libretranslate.ps1` (loopback 5000, installed Hindi/English packs only).
Model data stays in `E:/whispr-models/hf-cache` and `E:/whispr-models/argos`, outside git.
Provide the same `TRANSLATOR_SHARED_SECRET` privately to both processes. The public example
lists server settings; no actual environment or credential files are modified by this phase.

Run `.venv/Scripts/python -m scripts.benchmark` from `translator/`.
Review `benchmarks/latest.json` before explicitly
enabling any `LIBRETRANSLATE_ENABLED_PAIRS`. No pair is enabled by default. Emergency Groq
audio→English is also disabled unless explicitly enabled with key/model and `cloud_ai` consent.
With no models/services available, health reports unavailable translation while core transcription
continues. The phone translation UI is Phase 10b and is not changed here.
