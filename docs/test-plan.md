# Test plan

Automated checks validate deterministic behavior with mocked external services. A real
phone rehearsal is required before an event. Do not use `E:\Whispr\output` for test output.
Use an external temporary directory and never load credential files into tests.

## Server (from server/)

```powershell
.\.venv\Scripts\python -m pytest -q -p no:cacheprovider --basetemp="$env:TEMP/whispr-tests"
.\.venv\Scripts\python -m ruff check .
.\.venv\Scripts\python -m ruff format --check .
```

These tests mock Firebase, HTTP providers, GPU probes and inference. Export tests cover
Markdown/TXT, owner/event/auth boundaries, filename safety, polished fallback, gaps,
silence and audit. Deletion, auth grants, upload retry, privacy gating, queue recovery and
stream replay are covered by the existing suites. Tests refuse external network access.

For an opt-in GPU check, first download the model as a separate owner setup action, then
run the following offline with a working CUDA runtime. It never downloads a model:

```powershell
$env:WHISPR_RUN_GPU_TESTS = '1'
.\.venv\Scripts\python -m pytest -q -p no:cacheprovider --basetemp="$env:TEMP/whispr-gpu-tests" app/tests/test_whisper_gpu.py
Remove-Item Env:WHISPR_RUN_GPU_TESTS
```

## Android (from android/)

Use installed dependencies; the commands below do not require installing anything.

```powershell
npx tsc --noEmit
npx eslint .
npx jest --runInBand
```

Coverage includes pure export composition (ordered sections, Unicode, saved final brief,
raw/cleaned, omissions and ASCII filenames), native share mocks and 24-hour cache cleanup,
viewer search/sequence navigation, vocabulary validation and unavailable states, authenticated
DELETE/retry, pending deletion persistence, transaction rollback, retained notes, safe
diagnostics whitelist and sentinel exclusions, and route registration. SQLite semantics
run against Node SQLite as well as the memory twin.

## Firestore rules emulator (loopback only)

Use installed dependencies in `firebase/rules-tests/`, Java 21+, and the cached Firestore
emulator. No live Firebase project or credentials are needed. The normal script is:

```powershell
npm test
```

That script uses Firebase CLI `emulators:exec` and can download its emulator if absent; do
not run it during a no-network session unless the cache is already prepared. To guarantee
no CLI downloads/update checks, start the cached JAR directly from an external temp directory:

```powershell
java -jar "$env:USERPROFILE/.cache/firebase/emulators/cloud-firestore-emulator-v1.19.8.jar" --host 127.0.0.1 --port 8080 --project_id demo-whisprpersonal
```

In another terminal, from `firebase/rules-tests/`:

```powershell
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
$env:GCLOUD_PROJECT = 'demo-whisprpersonal'
$env:GOOGLE_CLOUD_PROJECT = 'demo-whisprpersonal'
node --test --experimental-strip-types test/*.test.ts
```

The tests load only repository rules and connect only to that emulator. Stop it afterwards.
Expected denials are deliberate test cases, not suite failures. Never substitute a live
project for the `demo-` project. Rules deployment is a separate owner action in setup.

## Live stream driver (manual integration)

This intentionally contacts the chosen laptop; run it only during an authorized rehearsal,
not as part of the offline mocked suites. It uses Node 24 type stripping and production
stream code, exercises a forced reconnect and checks ordered finalization. From android/:

```powershell
node --experimental-strip-types scripts/live-stream-check.ts --server <trusted-laptop-origin> --key <private-server-key> --token <private-valid-bearer> --session <new-session-id> --event <owned-event-id> --chunks <test-wav-directory> --overlap 1200 --language kn
```

Replace private arguments locally; never paste the populated command into reports/history
shared with others. WAV names must be contiguous from zero with the form
`sequence_startMs_endMs_overlapMs_c.wav` (or `_e.wav` for an ending chunk). Provide bounded
16 kHz mono WAV audio matching the configured server limits. Success means transcript,
reconnect and finalization checks pass; assess language accuracy by listening separately.

## Manual Android matrix

Record APK version/versionCode, phone/OEM/Android version, laptop model/runtime, network,
date, result and affected session privately. Run on light/dark themes with larger text and
screen-reader actions. Use disposable consented test data for deletion/failure drills.

| Spec test | Steps | Expected result |
| --- | --- | --- |
| Sign-in | Enable Email/Password; sign in online, renew pass, remove internet | Correct owner; offline pass expiry shown; expiry asks to reconnect without losing audio |
| Event creation | Create event with location, speakers, languages/privacy offline, reconnect | Event opens locally; owner-only cloud sync; no credential fields |
| Server connection | Scan QR, enter key separately, test LAN then Tailscale | QR contains origin only; auth fails closed for wrong/unset key; configured model/queue visible |
| Mic permission | Deny then allow permission at Start after consent | Clear denial; no capture before consent/permission; retry succeeds |
| Screen locked | Record for several chunks with screen locked | Recording notification remains; elapsed time/audio continues; no missing interval on unlock |
| Chunk creation | Speak across boundaries, pause/resume then stop | Sequential durable WAV chunks, correct overlap, no unreviewed seams; master retained |
| Offline queue | Disconnect laptop while recording | Chunks save on phone; UI shows queue; no speech lost because upload is unavailable |
| Upload retry | Restore Wi-Fi, simulate queue-full and 404 session reset | Idempotent retry/backoff; retained files replay when needed; failures remain visible |
| WebSocket reconnect | Drop socket during speech and reconnect | Persisted cursor resumes; HTTP catch-up reconciles; no duplicate final rows |
| Live transcript | Speak Kannada/Tamil/Hindi/English and mixed segments | Raw rows/language timeline update; uncertainty visible; manual override affects next chunk |
| Notes | Quick note paused/recording; copy raw row; offline edit/conflict | Correct timestamp/source; local save first; conflicts retain both versions for explicit choice |
| Finalization | Stop with pending chunks, reconnect and wait | Finalized when accounted for; missing/failed parts remain explicit; session readable in Library |
| Brief | Generate eligible AI brief; review/edit/save; reopen from Library | Provider/model/warnings labelled; saved final edit used; unavailable providers preserve raw |
| App restart recovery | Kill app during recording and during upload | Saved master/chunks recovered, interrupted state explained; no claim capture continued after kill |
| Low connectivity | Drop internet while LAN works, throttle/drop LAN, expire pass | Local recording/notes safe; unexpired pass permits laptop; cloud sync waits; retry recovers |
| Export | Library > event > Export; select sessions/raw/cleaned/notes/saved brief; share md/txt offline | Unicode intact; ordered sections, timestamps/gaps/fallback labels; PDF disabled; open received file and verify |
| Transcript viewer | Open session/search match with sequence; search combining Unicode; switch tabs | Read-only local rows, correct target/match count, polished fallback labels; no auto-follow; raw long-press adds note |
| Vocabulary | Load, add event speakers, invalid >64-char term/>200 terms, save offline | Loaded list preserved; validation inline; no replacements UI; clear laptop requirement; new chunks use saved terms |
| Diagnostics | Settings > Diagnostics with/without laptop; share TXT | Whitelisted status/counts only, host without credentials, no transcript/note/device ids/tokens/keys |
| Delete session | Try active capture, laptop busy, success, 404, offline phone-only then reconnect | Active/busy refused; irreversible confirm; audio/rows removed, notes kept; offline retry row persists then clears |

Use the [final rehearsal checklist](event-runbook.md#final-rehearsal-checklist-print-this-page)
as the go/no-go record. Automated results and hardware verification must be reported separately.

## Phase 10b acceptance coverage

| Area | Automated checks | Device rehearsal |
| --- | --- | --- |
| Translation API/poller | Runtime validation, nullable failure rows, durable submission, restart resume, retry without resubmit, terminal errors and late response cancellation | Reopen app during a queued translation |
| SQLite migration 6 | Exact separate translation/job columns, uniqueness, language isolation, owner-scoped deletion and linked job removal; raw stays unchanged | Open an existing install after upgrade |
| Translation views | Labels for all three engines, `und` emergency audio note, separate AI-polished block, original fallback, non-blocking unavailable banner, Raw access, control hidden until finalized, privacy-gated polish | Check scrolling, accessibility and large fonts on both session and saved transcript screens |
| Export/stream | Optional labelled translation section after transcript, each physical line labelled; audio event validation and unknown type tolerance | Share Markdown/TXT with translation selected |
| Diagnostics/settings | Whitelisted direction/state words and pairs, separate translation section, server-backed disabled integration list with offline fallback | Disconnect laptop and inspect fallback |
| Future integrations | No HTTP use by every stub (failing MockTransport), flags off, placeholders empty, health/diagnostic inventory, App Check both-gate enforcement and unconfigured non-blocking behavior | Confirm core recording works with all integrations unconfigured |

Phase 10a translator model verification remains unchanged. Phase 10b automated UI tests do not
replace a physical Android rehearsal or claim new real-model translation accuracy results.
