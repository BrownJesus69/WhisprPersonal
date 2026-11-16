# UX-3: Android voice keyboard (real IME) plus a dictation endpoint

Working directory: `E:\Whispr`. Two parts:
- **Server:** `server/` (Python 3.12 FastAPI). Run commands from `server/`:
  - `./.venv/Scripts/python -m pytest -q -p no:cacheprovider --basetemp=E:/whispr-build-cache/pytest-ux3`
  - `./.venv/Scripts/python -m ruff check .`
  - `./.venv/Scripts/python -m ruff format --check .`
- **App:** `android/` (Expo SDK 58, React Native, TypeScript). Run from `android/`:
  - `npx tsc --noEmit -p .`
  - `npx eslint src`
  - `npx jest`

Read `E:\Whispr\AGENTS.md` first and follow it exactly (secrets, fail closed, no network in tests,
error shape, structured logs, no git commits).

Phases UX-1 and UX-2 are done (see `plans/ux-1-speak.md` and `plans/ux-2-setup-settings-history.md`).
Reuse their components, strings (`src/i18n`) and settings patterns.

## Goal

The owner taps the microphone in the WhisprPersonal keyboard inside any app (WhatsApp, Gmail, a
browser), speaks, and taps Stop. The text is transcribed on their own computer and inserted into
the field they were typing in. Insertion is safe: never into the wrong field, never twice, never
into a password field, and no auto-send.

## Architecture (decided; do not change)

- **A real Android `InputMethodService` written in Kotlin**, with a plain Android Views UI (no
  Compose, no React Native inside the IME). No accessibility-service tricks, and no
  "draw over other apps" permission.
- It is packaged as a **local Expo module** at `android/modules/whispr-keyboard/`, so that
  `expo prebuild` autolinks it and the module's `AndroidManifest.xml` merges the service in.
  `android/android/` is generated and deleted after every build, so **never** put sources
  there. Use the `expo-module.config.json` and `android/build.gradle` layout that
  expo-modules-autolinking expects for local modules. Check how
  `node_modules/expo-modules-autolinking` discovers `modules/` in SDK 58, and follow it.
- **Audio goes only to the owner's computer**, through a new synchronous endpoint (see Server).
  The keyboard keeps no history.
- **Authentication** is the same as the app's:
  - the `X-WhisprPersonal-Server-Key` header (the shared server key);
  - `Authorization: Bearer <Firebase ID token>`. In Kotlin, get it from the native Firebase SDK
    that the app already links (`com.google.firebase.auth.FirebaseAuth.getInstance().currentUser
    ?.getIdToken(false)`), because the IME runs in the same app process.

  If no user is signed in, show "Open WhisprPersonal and sign in" with a button that launches
  the app.
- **The server URL, server key and preferences** reach the IME through the module's JS API.
  `setConfig({ serverUrl, serverKey, languageMode, reviewBeforeInsert, haptics, speakEventId })`
  stores them in app-private `SharedPreferences`. Encrypt the server key with an AES-GCM key
  held in the Android Keystore (alias `whispr_keyboard`); write that small helper yourself and
  add no new Gradle dependencies. `clearConfig()` wipes them. Never log the key or the token.
  Mark the preferences file as excluded from backup: add a `data_extraction_rules` and
  `full_backup_content` exclusion via the module manifest, if possible without conflicting
  with the app's. Otherwise document it as a limitation.

## Server: `POST /api/v1/dictation` (new router `server/app/routers/dictation.py`)

- **Auth and limits:** the same as the session endpoints (`authenticated_user`, server key, rate
  limiting). Fail closed exactly like the existing routes.
- **Request:** multipart.
  - `file` is a 16 kHz mono 16-bit PCM WAV, at most 120 s (reject longer with a clear
    `validation_error`).
  - `language` is optional: `auto` or a supported code, validated with the existing
    `validate_language`.
  - `event_id` is optional. When present and owned by the user (reuse the ownership check),
    that event's vocabulary is applied as hotwords, the way `workers/transcription_worker.py`
    does.
- **Processing:** run the existing transcription service off the event loop (the same engine
  and model profile as live sessions). Respect the existing GPU concurrency limits and queue.
  When the model is not ready, return 503 `model_not_ready`.
- **Response:** `{ "text": str, "language": str | null, "duration_ms": int }`.
- **Privacy:**
  - No audio and no text is stored. Delete temporary files in `finally`.
  - Logs carry `request_id` and the duration only, never the transcript text.
  - The body limit must allow about 4 MB (120 s × 32 kB/s plus the header); adjust the
    body-limit middleware for this route only.
- **Tests** (pytest, everything mocked):
  - auth required (missing key returns 401/503 per the existing pattern);
  - rejects non-WAV, wrong sample rate and over-length input;
  - language validation;
  - vocabulary applied only for an owned event;
  - model not ready returns 503;
  - text is not logged (caplog);
  - temp files are removed.
- Add the endpoint to `docs/api.md`.

## Keyboard (Kotlin), in `android/modules/whispr-keyboard/android/src/main/java/.../`

- `WhisprKeyboardService : InputMethodService`. A compact layout (about 220 dp tall), with
  colours matching the app tokens (light and dark follow the system):
  - **Top row:** a language button that cycles Auto-detect, Kannada, Tamil, Hindi and English and
    shows the current choice, then a status text ("Ready", "Listening… 0:12", "Turning speech
    into text…", or a problem).
  - **Centre:** a large round Start/Stop button (64 dp, at least a 48 dp hit area). It is red
    while listening and stays in the same place in every state.
  - A one-line preview of the result when "Review before inserting" is on, or when a result
    could not be inserted.
  - **Bottom row:** a "switch keyboard" button (`switchToNextInputMethod(false)`, falling back
    to `InputMethodManager.showInputMethodPicker()`), Backspace (`deleteSurroundingText(1, 0)`,
    repeating on long-press, with tap still working), and an Enter/action key whose label comes
    from `EditorInfo.imeOptions` (Go/Search/Send/Next/Done/Enter). The action key performs the
    editor action only when the **user taps it**, never automatically.
  - Every control has a `contentDescription`, and every target is at least 48 dp.
- **Recording:** use `AudioRecord` at 16 kHz mono PCM16.
  - Stop at 120 s automatically, with the status "Maximum length reached".
  - Keep audio in memory and write a WAV to the cache directory only for the upload, deleting it
    afterwards.
  - Show a small real level indicator from the RMS.
  - Request audio focus. If another app holds the microphone, show "Microphone is busy".
- **Microphone permission:** the IME cannot request it. If `RECORD_AUDIO` is not granted, show
  "Allow microphone in WhisprPersonal" with a button that launches the app's main activity.
- **Upload:** use `HttpURLConnection` (no new dependencies), multipart, on a background thread
  or executor, with a 60 s timeout.
  - Errors map to plain words: computer not reachable, sign-in expired, server key wrong,
    speech recognition still loading, recording too long.
  - Keep the recorded audio in memory until success, so "Try again" re-sends the same audio.
  - Discard it after success, or when the user taps Discard.
- **Safe insertion** (critical):
  - When recording starts, capture the target editor identity: `EditorInfo.packageName`,
    `fieldId`, `inputType`, plus a monotonically increasing `inputSessionId` that you bump in
    `onStartInput` / `onFinishInput`.
  - When the result arrives, insert with `currentInputConnection.commitText(text, 1)` **only
    if** the current editor identity matches, the input connection is not null, and the result
    has not already been inserted (a per-request id, inserted once).
  - Otherwise keep the result in the keyboard with "Insert here" (inserts into the current
    field, on tap only) and "Copy" (ClipboardManager), and say why: "The text box changed while
    your words were processed."
  - Add a single leading space when the character before the cursor
    (`getTextBeforeCursor(1, 0)`) is a letter or digit. Read only that one character, and
    nothing else from the field.
  - With "Review before inserting" on, always show the preview with Insert and Discard.
  - **Undo:** after an insertion, show "Undo" for 5 s. It deletes exactly the inserted text, and
    only if `getTextBeforeCursor(len, 0)` still ends with exactly that text. Otherwise hide Undo.
- **Sensitive fields:** if `inputType` is any password variation (text, web or number password)
  or `TYPE_TEXT_FLAG_NO_SUGGESTIONS` combined with a visible-password type, disable the microphone
  and show "Voice input is off for password fields".
- **Lifecycle:** `onFinishInputView` while listening keeps recording, but the result is held, not
  inserted, unless the same editor returns. `onDestroy` stops recording and releases
  `AudioRecord`.
- **Haptics:** a short tick on Start/Stop when enabled (`View.performHapticFeedback`).
- **Manifest** (module): `<service android:name=... android:permission=
  "android.permission.BIND_INPUT_METHOD" android:exported="true">`, with the intent-filter
  `android.view.InputMethod` and the meta-data `android.view.im` pointing at `@xml/method`.
  `res/xml/method.xml` sets a settings activity pointing at the app's main activity, plus one
  subtype for voice.

## JS bridge and app UI

- `android/modules/whispr-keyboard/index.ts` is a typed module API:
  - `setConfig(...)` and `clearConfig()`;
  - `isEnabled(): Promise<boolean>` (`Settings.Secure.ENABLED_INPUT_METHODS` contains the
    service);
  - `isSelected(): Promise<boolean>` (`DEFAULT_INPUT_METHOD`);
  - `openInputMethodSettings()` (`Settings.ACTION_INPUT_METHOD_SETTINGS`);
  - `showPicker()`.

  Provide a Jest mock in `jest.setup.ts`.
- **Keep the config in sync** in `src/features/keyboard/syncKeyboard.ts`. On app start, when the
  connection is saved (`useConnectComputer` success), and when the related settings change,
  call `setConfig` with:
  - the server URL, server key (from `credentials.getServerKey()`) and default language;
  - `reviewBeforeInsert`, `haptics`, and the Speak event id (so personal words apply).

  On sign-out, call `clearConfig()`.
- **Settings** gets a **Keyboard** group (between Speech and Privacy):
  - "Use WhisprPersonal in other apps", which opens `/keyboard-setup`;
  - "Review before inserting" (switch, default off), and "Haptics" (switch, default on). Add both
    to the settings store with normalization and tests.
- **`/keyboard-setup`**, a guided screen:
  - Step 1, "Turn on the WhisprPersonal keyboard", with "Open keyboard settings". Explain
    calmly: Android shows a standard warning that a keyboard can see what you type.
    WhisprPersonal's keyboard sends audio only to your computer, and reads only the one
    character before the cursor to add a space.
  - Step 2, "Switch to it", with "Choose keyboard" (the picker).
  - Step 3, "Try it", with a text field to test in.
  - Each step shows ✓ from the **actual** system state, re-checked on `AppState` "active".
    Never ask the user to confirm it themselves.
  - Always offer "Not now".
- After the first successful Speak result, Speak shows a one-time, dismissible line, "Use
  WhisprPersonal in other apps", linking to `/keyboard-setup`. Remember the dismissal in
  settings.

## Tests

- **Server:** as listed above.
- **JS** (Jest; mock the native module):
  - `syncKeyboard` calls `setConfig` with the right fields, never logs the key, and clears on
    sign-out;
  - `/keyboard-setup` reflects the mocked `isEnabled` / `isSelected` and re-checks when the app
    becomes active;
  - the new settings normalize;
  - the Speak one-time prompt appears once and stays dismissed.
- **Kotlin:** keep the insertion-safety decisions in a pure Kotlin class (`InsertionGuard`) with
  no Android imports, so it is unit-testable. If the module's Gradle setup supports JVM unit
  tests without new dependencies (JUnit is usually available), add tests for:
  - same editor inserts once;
  - a changed editor holds the result;
  - a duplicate request id is ignored;
  - Undo only when the text matches;
  - password input types block recording.

  If JVM tests cannot run here, still write the class and the tests, and say so.

## Constraints

- Follow `AGENTS.md`. Never open, print, copy or modify `secrets/`,
  `android/app/google-services.json`, or any `.env`. Do not modify `.gitignore` or `AGENTS.md`.
  Do not run `git commit` or `git push`, and do not change git config.
- No new npm or Gradle dependencies. No network calls in tests.
- Do not touch `android/android/` (generated). Do not run a Gradle build; the architect builds
  the APK afterwards. Write Kotlin that compiles against the compile SDK in
  `android/app.config.js` (`expo-build-properties`) and Kotlin 2.3.21.
- Do not change the existing session, chunk or stream APIs, or the Firestore rules.

## Done when

- The server checks (pytest, ruff check, ruff format --check) pass.
- The app checks (tsc, eslint, jest) pass.
- The final message lists:
  - each changed or added file with a one-line reason;
  - exactly which Kotlin tests ran, or why they could not;
  - the known limitations (for example, backup exclusion, and devices where `fieldId` is 0).
