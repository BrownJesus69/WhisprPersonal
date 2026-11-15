# WhisprPersonal Android · Phase 5

Android-only Expo SDK 58 development-build app. Strict TypeScript, Expo Router in
`src/app`, light/dark themes, email/password Firebase Auth, owner-filtered Firestore
events, laptop health/sign-in checks, SecureStore offline passes, QR scanning and
local preferences, continuous recording, overlapping WAV chunks, a durable SQLite upload
queue and crash recovery are implemented. Live transcripts are Phase 6; expanded library
tools are Phase 9.

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

### Local native builds on this laptop (measured 2026-11-15)

The C: drive is nearly full and Windows keeps its auto-managed page file there. A full
native build compiles C++ (Reanimated, Worklets, Screens) for four CPU architectures in
parallel; `clang` ran out of memory (`LLVM ERROR: out of memory`) and the page file grew to
23.8 GB, leaving C: with ~0.2 GB. Until C: has ~15 GB free (restart first: Windows only
shrinks the page file on reboot), either use an **EAS cloud build** (below) or build only
your phone's architecture with fewer workers, keeping every cache on E::

```powershell
$env:ANDROID_HOME = 'E:\whispr-build-cache\android-sdk'   # copy of the SDK pieces needed
$env:GRADLE_USER_HOME = 'E:\whispr-build-cache\gradle'
$env:TEMP = 'E:\whispr-build-cache\tmp'; $env:TMP = $env:TEMP
npx expo prebuild --platform android
cd android
.\gradlew.bat assembleDebug --max-workers=2 -PreactNativeArchitectures=arm64-v8a
```

Verified so far by a native build: prebuild succeeds, and every Java/Kotlin module compiles
once Kotlin is set to 2.3.21 (`app.config.js` explains why). The C++ link step has not
completed on this machine because of the memory limit above.

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

Settings → Connect: enter or scan the plain server URL, test public `/health`,
enter the server key, then Verify sign-in. For `account_not_allowed`, long-press
the displayed UID to copy it and add it to `AUTH_ALLOWED_UIDS` on the laptop.
Save after verification. A successful connection obtains a 12 h offline pass
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
