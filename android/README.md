# WhisprPersonal Android · Phase 4

Android-only Expo SDK 58 development-build app. Strict TypeScript, Expo Router in
`src/app`, light/dark themes, email/password Firebase Auth, owner-filtered Firestore
events, laptop health/sign-in checks, SecureStore offline passes, QR scanning and
local preferences are implemented. Recording/upload is Phase 5; live transcripts
are Phase 6; expanded library tools are Phase 9. Start session is disabled.

Audio is intended to go only to your laptop. Transcripts and notes sync to your
Firebase. Cloud AI is optional, with local-only privacy and no cleanup as defaults.
Phase 4 sends no audio. Future integrations show Not configured.

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
microphone permission is blocked until Phase 5.

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

## Offline verification

```powershell
$env:EXPO_NO_DOTENV = '1'
$env:EXPO_OFFLINE = '1'
npx --no-install tsc --noEmit
npx --no-install eslint .
npx --no-install jest --runInBand
npx --no-install expo export --platform android
npx --no-install expo-doctor
```

Tests deny real fetch calls and mock Firebase and all relevant native modules.
Package APIs were checked in installed `.d.ts`/source without fetching docs.
Expo Doctor requires its CLI to already be installed or cached. Offline runs
cannot complete Doctor's remote service checks. Device QA remains necessary for
native Firebase configuration, USB installation, real QR permission/scanning,
Wi-Fi/Tailscale reachability, accessibility/font scaling, and offline renewal.
