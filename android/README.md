# WhisprPersonal Android

Android-only Expo SDK 58 development-build app. Strict TypeScript, Expo Router in
`src/app`, light/dark themes, email/password Firebase Auth, owner-filtered Firestore
events, laptop health/sign-in checks, SecureStore offline passes, QR scanning and
local preferences, continuous recording, overlapping WAV chunks, a durable SQLite upload
queue and crash recovery are implemented. Live transcripts, notes, briefs, read-only review, Markdown/TXT export, vocabulary,
session deletion and diagnostics are implemented. Phase 9 hardware verification is pending.

Audio is intended to go only to your laptop. Transcripts and notes sync to your
Firebase. Cloud AI is optional, with local-only privacy and no cleanup as defaults.
Recording works without a configured laptop; audio waits locally until connection is available.
Future integrations show Not configured.

## Run on a USB Android device

Use the installed dependencies; do not use Expo Go (RNFirebase needs native code).
Enable Android developer options and USB debugging, connect and authorize the
device, and install the Android SDK/JDK required by Expo on the build machine.
From `E:\Whispr\android`:

```powershell
$env:EXPO_NO_DOTENV = '1' # do not load the repository owner's .env
npx expo run:android --device
npx expo start --dev-client
```

Do not hand-edit the generated `android/android` native project. Rebuild the native
app after changing config plugins. On a physical device localhost refers to the
phone; use your laptop's LAN/Tailscale address. The Android emulator can use
`10.0.2.2`. Public HTTP is rejected; HTTPS is accepted. No URL may contain a key,
credentials, query, fragment or path. Camera permission is only for QR scanning;
microphone permission is requested only when Start is pressed after session consent.

### Local native builds on this laptop (verified 2026-11-15)

A release APK builds locally with **every cache and temp file on E:**
(`scripts/windows-build/build-apk.ps1`): Android SDK copy, Gradle home, npm cache, TEMP
and `ANDROID_USER_HOME` all live in `E:\whispr-build-cache`. Verified result: `BUILD
SUCCESSFUL in 7m 46s` (2026-11-16), `app-release.apk` (47.9 MB, `arm64-v8a` only, debug-signed,
`com.aditya.whisprpersonal` 1.0.4, versionCode 14). Latest APK: the repository's GitHub Releases page. Google Sign-In is enabled by setting
`EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` in the shell for that build only (no `.env` file); the APK
contained the button and a `default_web_client_id` matching it. The shared React Native debug
key (SHA-1 `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`) is registered in
Firebase for this personal build; register your own release key before distributing.

Three Windows problems had to be fixed:

1. **Memory.** This laptop has 32 logical CPUs, and ninja runs about 34 `clang` jobs per C++
   task by default, which ran out of RAM plus pagefile. `NinjaCap.cs` is a tiny wrapper
   installed as the E: SDK copy's `cmake\3.22.1\bin\ninja.exe` (the real one is renamed
   `ninja-real.exe`). It caps parallelism at `WHISPR_NINJA_JOBS` (default 6).
   `gradle-user-home.properties` (copy it to `E:\whispr-build-cache\gradle\gradle.properties`)
   limits Gradle to 2 workers, a 4 GB heap and `arm64-v8a` only.
2. **Paths over 260 characters.** ninja 1.10 cannot stat long codegen object paths
   (react-native-gesture-handler). The `plugins/withWindowsCmakePaths.js` config plugin passes
   `-DCMAKE_OBJECT_PATH_MAX=250` on Windows only, so CMake hashes the long paths.
3. **The C: pagefile.** Windows still grows its auto-managed pagefile on C: during the build
   (20.1 GB to 23.9 GB, about 3.8 GB of C: space) even though the build writes no files to
   C:. A reboot shrinks it back. To stop this for good, move the pagefile to E: yourself:
   System Properties → Advanced → Performance → Settings → Advanced → Virtual memory.

```powershell
# One-time: compile the ninja cap into the E: SDK copy
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /out:E:\whispr-build-cache\ninja-cap.exe scripts\windows-build\NinjaCap.cs
Rename-Item E:\whispr-build-cache\android-sdk\cmake\3.22.1\bin\ninja.exe ninja-real.exe
Copy-Item E:\whispr-build-cache\ninja-cap.exe E:\whispr-build-cache\android-sdk\cmake\3.22.1\bin\ninja.exe
# Each build (prebuild + assembleRelease):
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows-build\build-apk.ps1
# Output: android\app\build\outputs\apk\release\app-release.apk
```

An **EAS cloud build** (below) avoids all of this.

## Firebase setup (owner, online)

1. In Firebase Authentication → Sign-in method, enable **Email/Password**.
2. Keep the existing local `app/google-services.json` private and unchanged. The
   package is `com.aditya.whisprpersonal`; no Firebase config belongs in source.
3. Deploy the existing rules and index from the monorepo root using your Firebase
   CLI/account: `firebase deploy --only firestore:rules,firestore:indexes`.
   Review `firebase/firestore.rules` and the configured Firebase project first.
4. Sign in, create an event, and confirm that a second account cannot read it.
   Native Firestore offline persistence is left enabled. A cache banner marks
   locally cached event lists. The first sign-in requires internet.

User documents contain displayName, createdAt and empty preferences on first
sign-in. The laptop URL stays in SQLite KV settings; keys and passes stay in
SecureStore. Nothing secret is written to Firestore or a QR code.

## EAS builds and the Firebase file

`GOOGLE_SERVICES_JSON` must be an EAS **file** environment variable, not pasted JSON
or a plain-text environment variable. Create it for each environment used below:

```text
eas env:create --environment development --name GOOGLE_SERVICES_JSON --type file --visibility secret --value <private-local-file>
eas env:create --environment preview --name GOOGLE_SERVICES_JSON --type file --visibility secret --value <private-local-file>
eas env:create --environment production --name GOOGLE_SERVICES_JSON --type file --visibility secret --value <private-local-file>
```

| Profile | Artifact | Required EAS file variable |
| --- | --- | --- |
| development | Internal APK with development client | GOOGLE_SERVICES_JSON (development) |
| preview | Internal APK | GOOGLE_SERVICES_JSON (preview) |
| production | Android App Bundle | GOOGLE_SERVICES_JSON (production) |

Use an available EAS CLI (16 or newer): `eas build --platform android --profile
development`, install its APK on the device, then `npx expo start --dev-client`.
Cloud builds require network and owner credentials. App versions come from local
config. The config selects the EAS file path, or `./app/google-services.json` for
local builds. Never check either file into git.

## Connect your laptop

Settings → Laptop: enter or scan the plain server URL, enter the server key, and tap
**Connect**. One tap checks public `/health`, verifies sign-in, and saves. For
`account_not_allowed`, long-press the displayed user ID to copy it and add it to
`AUTH_ALLOWED_UIDS` on the laptop. A successful connection obtains a 12 h offline pass
when the laptop enables grants (the server controls the actual TTL). Passes are
bound to both the account and laptop URL. Within two hours of expiry they renew
using a fresh Firebase token when online. Sign-out clears the local pass and
best-effort revokes it, keeping the URL and server key. If internet is unavailable
after expiry, reconnect to renew sign-in. A laptop connection is still needed
while using an offline pass; the pass replaces internet-backed sign-in only.

## Enable Google Sign-In later (owner, online)

Google is off until `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` is set. It is a public OAuth
client ID, never a secret. No Google module is loaded by a screen until its enabled
button is pressed.

1. Add SHA-1 fingerprints for the Android debug keystore and **each EAS signing
   keystore** to the Firebase Android app. Add the Play App Signing fingerprint
   when using a Play-distributed build.
2. Enable the Google provider in Firebase Authentication and configure its support
   email. Confirm the Android package matches `com.aditya.whisprpersonal`.
3. Re-download `google-services.json` from Firebase after OAuth clients exist and
   replace it yourself in the private local location and the EAS file variables.
   Agents must never read, copy or edit this file.
4. Set `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` to the **Web** OAuth client ID (not the
   Android client ID) in the build environment. Rebuild the native development app
   and JS bundle, then test on a device. Clearing the variable disables the button.

## Recording and phone storage

From an event, choose **Start session**, then **Start recording**. Confirm the per-session
checkbox that everyone has been told and agrees. Only then does Android ask for microphone
permission, followed by notification permission on Android 13+. Denying notifications shows
a warning; microphone permission is required. At least 500 MiB free is required to start or
resume; below 2 GiB the app warns. Audio quality is fixed to 16 kHz, mono, signed 16-bit PCM;
the existing quality preference is reserved for later use. Language, chunk length (5–15 s)
and head overlap (1–1.5 s) are snapshotted when the local session is created.

`@siteed/audio-studio` runs a microphone foreground service with a partial wake lock and a
recording notification. Screen lock should continue capture without keeping the display on.
Pause/Resume/Stop controls stay in the app: the library's notification pause/resume actions
bypass the durable JS boundary, so they are disabled. Phone calls/audio-focus loss pause
recording and require explicit Resume. No phone-state or Bluetooth permissions are requested.
A native development-build rebuild is required after the plugin change; Expo Go cannot run it.
The final config plugin removes a stale Phase 4 microphone-removal manifest marker and skips
iOS-only mods for this Android-only app, so permission introspection needs no iOS credentials.
OEM battery savers, force stop, revoked microphone access, storage exhaustion or process death
can still interrupt capture. Test long screen-locked recordings on the actual event phone;
use Android's unrestricted battery setting for the app if the device requires it.

Every WAV chunk is closed as `.wav.part`, renamed in the same directory, hashed with SHA-256
and inserted into `whispr.db` before upload. The native stream is never restarted to cut a
chunk. The adapter fills any un-emitted Pause/Stop bytes from the master WAV and suppresses
delayed duplicate stream bytes. Pauses collapse in the audio timeline; the first chunk after
Resume has no overlap. A final fragment of **less than 200 ms of new audio is omitted** from
the upload chunks (it remains in the master). Its recorded time still counts.

Files live in the app's private documents directory under `whispr/sessions/<id>/`, with
`master.wav` and `chunks/`. PCM alone is about 115 MB/hour (decimal) for the master;
**master plus chunks is about 244 MB/hour at 10 s / 1.2 s**, because the chunks contain
another copy plus overlap. Shorter chunks increase overlap storage. This corrects the
115 MB/hour combined estimate in the Phase 5 brief. No audio goes to Firestore.

The queue uploads one chunk at a time, oldest session then ascending due sequence, using
the existing server key and token/offline pass. It works without internet when the laptop
is reachable and the pass remains valid. Network errors/timeouts/429/queue-full retry forever
with full jitter (exponential envelope capped at five minutes); explicit `Retry-After` takes
precedence, including a longer server-requested delay. Auth/configuration failures pause
attempts until connection/sign-in is renewed. Permanent failures keep their files and display
the code with a retry action. Laptop queued/processing/done/failed status is polled at most
every ten seconds. Stop uploads remaining audio and requests server finalization only after
all chunks are accepted. Firestore event statuses sync offline through the existing cache.

**Delete phone audio after the laptop transcribes it** defaults off. Enabling it deletes only
chunks confirmed `done`, marking them locally deleted; the manual deletion action has the
same restriction and asks for confirmation. Master WAVs are never automatically deleted.
The storage total includes retained masters and chunks for the signed-in account. Android
app-data removal/uninstall removes these local files; queued audio needs its phone storage.

After sign-in, recovery removes incomplete `.part` files, resets interrupted uploads, and
re-inserts complete orphan chunks using metadata in their filenames. It reads uncommitted
master audio in bounded reads, recovers overlapping chunks and marks capture stopped. The
session offers **Resume recording** or **Finish session**; finalization waits for that choice
so the server cannot close a session you intend to resume. A recovered run uses a new
`master_<session-time>_<random>.wav`, retaining the old master; the filename records its
timeline origin for subsequent recovery. An unstarted local session is stored as `paused`
with no consent timestamp (the schema has no `ready` status), and displayed as Ready.

### Test WAVs for laptop seam verification

Node 24 runs the production pure TypeScript chunker directly; no twin implementation or
React Native imports are involved. Supply a canonical 44-byte-header 16 kHz mono 16-bit WAV:

```powershell
node --experimental-strip-types scripts/make-test-chunks.mjs input.wav 10000 1200 output-chunks
```

Files are `{sequence}_{startMs}_{endMs}_{headOverlapMs}_{c|e}.wav`. `c` means a full chunk
that continues a run; `e` means the final partial chunk. Upload their metadata and file to the
laptop contract to verify stitching. Existing output files are never overwritten.

## Live transcript (0.6.0)

The session screen displays **Raw** partial text while the laptop decodes a chunk, then
replaces it with finalized text. Seam revisions replace the same row; an updated indicator
lasts 550 ms and is suppressed with Reduce Motion. Timestamps use the session timeline;
partial times are translated from the chunk's local start. Silent chunks are hidden with a
count, and failed parts keep an explicit error code. Scroll upward to read earlier text;
**Jump to live** resumes following new text. Android's system font scaling applies to the
existing typography. The language badge shows detection confidence, an uncertainty marker,
or the forced language. A language timeline groups consecutive non-silent detections.

**Auto / Kannada / Tamil / Hindi / English applies from the next chunk; works offline.**
The picker saves the mode and the recorder's next sequence before contacting the laptop.
Uploads at or beyond that boundary include the selected language, even if the laptop was
unreachable when it was selected. Auto omits that upload field. The app also sends the mode
over the open stream, falls back to HTTP, and retries the durable intention on reconnect.
Existing transcript text is retained; overrides do not rewrite earlier chunks. Stopped and
finalized sessions show saved transcripts read-only.

The **Polished** tab is disabled until Phase 8. Cleanup arrives with Cloud AI later; raw
transcripts are always kept unchanged. This release makes no cleanup or other LLM calls.

The header-authenticated WebSocket resumes from the last durably saved event sequence.
Migration 2 adds transcript rows, language events and session cursors/override metadata.
A small additional `stream_events` journal retains validated lifecycle and failure events
for faithful offline hydration. Each event, its transcript/language changes and cursor are
committed in one exclusive SQLite transaction. Duplicate replay is ignored. A lower server
cursor resets the local cursor/journal and requests replay; saved transcript rows remain
available during recovery. HTTP upload-status polling also saves completed transcripts
without advancing the stream cursor, and ignores snapshots overtaken by stream events.

The stream stays active while this session screen is open or recording is active, including
navigation away from the screen. It disconnects once finalization and replay are synced.
Foreground/network recovery triggers an immediate reconnect. A 50-second inbound watchdog
detects a stalled connection. Network errors retry with full jitter in a 1–30-second
exponential envelope, subscriber overflow retries immediately, a missing laptop session
retries every 30 seconds, and rate limiting waits at least 10 seconds. The attempt count
resets after 30 healthy seconds. Authentication refresh is attempted once; a second rejection
shows **Sign-in renewal needed** until credentials change. Access denial shows **Not allowed**.
Server keys and bearer tokens appear only in request headers; code-only diagnostics contain
no transcript text or credentials. Saved finals remain readable after restarting offline.

### Architect stream check (requires a running laptop)

Node 24 imports the production stream client, validator and reducer directly, using a
header-capable socket factory. Generate chunks with the command above, then supply your
own existing values through shell variables:

```powershell
node --experimental-strip-types scripts/live-stream-check.ts --server http://127.0.0.1:8770 --key $serverKey --token $bearer --session $sessionId --event $eventId --chunks output-chunks --overlap 1200 --language ta
```

`--language` is optional. The driver creates the session idempotently, uploads filename
metadata plus SHA-256 and WAV files, forces one overflow-style reconnect, waits for finals,
finalizes, and prints applied event sequences, reduced raw text and language state. It
fails if an applied sequence is duplicated, missing or unordered. It does not load app
credentials or native modules. The laptop integration run is intentionally separate from
offline Jest checks and needs valid credentials supplied by the architect.

Device QA still covers real WS headers over Wi-Fi/Tailscale, navigating away while
recording, background/foreground suspension, laptop restart/cursor reset, offline override
and reconnection, selectable Kannada/Tamil/Hindi text, system large fonts, TalkBack,
Reduce Motion, transcript scrolling and visible revision updates.

## Offline verification commands

```powershell
$env:EXPO_NO_DOTENV = '1'
$env:EXPO_OFFLINE = '1'
npx --no-install tsc --noEmit
npx --no-install eslint .
npx --no-install jest --runInBand
npx --no-install expo export --platform android
npx --no-install expo config --type introspect
npx --no-install expo-doctor
```

Tests deny real fetch calls and mock Firebase and all relevant native modules.
Package APIs were checked in installed `.d.ts`/source without fetching docs.
Expo Doctor requires its CLI to already be installed or cached. Offline runs
cannot complete Doctor's remote service checks. Device QA remains necessary for
native Firebase configuration, USB installation, real QR permission/scanning,
Wi-Fi/Tailscale reachability, accessibility/font scaling, and offline renewal.
## Phase 7: offline notes and search

Event details now link to Notes with a count. Notes support local creation, speaker labels,
editing, confirmed deletion and explicit Keep mine / Use cloud conflict resolution. A SQLite
v3 outbox survives restarts; Firestore acknowledgements never block the UI. Sync starts with
the signed-in uid independently of the laptop URL. Session quick notes stamp recording time,
and finalized transcript rows offer long-press/accessibility **Add to notes** actions.
AI-assisted notes show **not configured**.

Search (History > Events, notes and briefs > **Search notes**) covers owner-scoped local notes and transcripts (two characters minimum,
250ms debounce, 50 results per section). Notes normalize Unicode in JS and use escaped LIKE;
existing transcripts normalize in JS after an owner-filtered join. No FTS5 or new dependencies.

Run `npx tsc --noEmit`, `npx eslint .`, and `npx jest --runInBand` here. The five Phase 7 suites
cover pure decisions, real SQLite/memory semantics, fake offline sync, Firestore serialization
and accessible note controls. Run emulator rule tests using [the rules test instructions](../firebase/rules-tests/README.md).
Deploy the reviewed Firestore rules with the release. Native-device airplane-mode, restart,
font-scaling and screen-reader checks still belong in device QA.

## Phase 8b: cleanup and reviewed briefs

Finalized sessions offer **Clean up**, using the cleanup level selected in Settings. Switch
between Raw and the labelled Polished tab; rejected or absent cleanup falls back to raw
with **Not cleaned**. Event **Briefs** lets you select finalized sessions, choose a brief
type, optionally include owner notes or cleaned text, and explicitly accept incomplete
transcripts. Review/edit the generated draft before saving. Drafts and pending AI jobs
survive app restart. Saved briefs have an offline Firestore viewer and a retained phone copy.

Providers are disabled until configured **on the laptop**: configure an enabled provider's
key and model, or the local LLM URL and model, using the existing server setup instructions.
See [server setup](../docs/setup.md) and [the event runbook](../docs/event-runbook.md).
The app holds no provider keys and assumes no provider model ids or quotas. Refresh
provider status in Briefs after changing laptop configuration. A local-only event requires
an eligible local model. With no eligible provider the calm unavailable message is expected;
raw transcription and notes continue to work.

SQLite v4 keeps polish separate and clears it on raw revisions. AI calls use the same
owner-guarded authentication as uploads. Brief saves queue Firestore writes without waiting
for internet and retain original generated text alongside the owner's reviewed version.
Deploy the updated brief rules with this release. Offline tests cover response validation,
job backoff/restart, SQLite/memory parity, Firestore serialization and UI consent/editing.
Run the existing typecheck, lint and Jest commands plus the local rules emulator tests.
Native-device layout, large-font, screen-reader and airplane-mode/restart QA remain part
of release verification.


Phase 9 workflows, EAS preview builds and sideloading are documented in
[setup](../docs/setup.md); run [the test plan](../docs/test-plan.md) and
[event rehearsal](../docs/event-runbook.md) before event use. expo-sharing is used only
for outbound shares; no share-target config plugin is registered.
