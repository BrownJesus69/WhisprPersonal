# UX-4: Failure and recovery states, accessibility, Indian-language rendering, live captions

Working directory: `E:\Whispr`. The app is in `android/` (Expo SDK 58, React Native, TypeScript).
Run from `android/`:
- `npx tsc --noEmit -p .`
- `npx eslint src`
- `npx jest`

If you touch `server/`, also run its checks per `AGENTS.md`. Read `E:\Whispr\AGENTS.md` first and
follow it.

UX-1, UX-2 and UX-3 are done (see the `plans/ux-*.md` files): Speak, History, Settings, setup,
Personal words, and the voice keyboard. This phase makes the whole app dependable and accessible.
It adds no new primary features except live captions.

`expo-keep-awake` has been added as a direct dependency by the architect. If it is missing from
`package.json`, STOP and report it.

## 1. State and recovery coverage

Make sure each state below is handled on Speak (and in History detail where relevant), using
`InlineNotice`. Each notice gives three things, in `t()` strings:
1. what happened;
2. whether the user's work is safe, and only claim it is safe when it is;
3. one action.

Add any missing state and a test for each.

| State | Detection | Copy (title / safety / action) |
| --- | --- | --- |
| Microphone permission denied | recordingStore message / permission result | "Microphone access is off." / "Nothing was recorded." / "Open settings" |
| Microphone busy or unavailable | recorder start throws | "The microphone is being used by another app." / "Nothing was recorded." / "Try again" |
| No speech detected | finalized session where every transcript row has `no_speech` or empty text | "We didn't hear any speech." / "The recording is kept in History." / "Try again" |
| Recognition failed | session `status === 'failed'` or rows with `failed_code` | "Some of your speech couldn't be turned into text." / "The audio is safe on this phone." / "Try again" (re-queue via the existing upload retry, `uploadService.retryFailed`) |
| Computer disconnected | connection or live status | existing |
| Computer sign-in failed | connection status `renew_required` or an `account_not_allowed` error | "Your computer needs you to sign in again." / "Your recording is safe on this phone." / "Connect computer" |
| Model not ready | health `model.status !== 'ready'` | "Speech recognition is still starting on your computer." / "Your recording is safe on this phone." / "Check again" |
| Slow processing | existing | existing |
| Cleanup failed | AI cleanup error for the session | "Cleanup didn't work this time." / "Your original text is unchanged." / "Try again" |
| Export or share failed | `Share.share` or export rejects | "Couldn't share." / "Your text is unchanged." / "Try again" |
| Draft save failed | existing | existing |
| Interrupted session, restored draft | existing | existing |

A timeout must never look like an endless spinner. Anything over 60 s shows the slow state (this
exists). Any network action without a result after 30 s shows its failure notice.

## 2. Accessibility

- **Announcements:** use `AccessibilityInfo.announceForAccessibility` for:
  - recording started ("Recording");
  - stopped ("Turning speech into text");
  - the text being ready ("Your text is ready");
  - "Copied";
  - errors (their title).

  **Do not** announce the timer every second. The timer `Text` must not be a live region: set
  `accessibilityLiveRegion="none"` and `importantForAccessibility="no"`, and keep the elapsed
  time in the Stop button's `accessibilityHint` instead. Do not announce provisional
  transcription updates.
- **Labels:** every `Pressable` or button has an `accessibilityLabel`, plus `accessibilityState`
  (disabled, selected, expanded, busy) where relevant. Check the History rows, LanguageChip,
  sheet items, Settings rows, setup steps and keyboard setup. Add a test that renders Speak,
  History, Settings, setup and keyboard setup and asserts every element with
  `accessibilityRole="button"` has a non-empty label.
- **Reading and focus order:** on Speak, the header and status come first, then the language,
  transcript, Start/Stop and the result actions. The BottomSheet traps focus while open
  (`accessibilityViewIsModal`) and its title is a header.
- **Large text (200%):**
  - No `numberOfLines` on actions or labels (previews are fine).
  - No fixed heights on text containers.
  - Button rows use `flexWrap: 'wrap'`.
  - The Speak dock must keep Start/Stop visible: the transcript area shrinks and scrolls, and the
    dock never scrolls away.
  - Audit with a test that sets `PixelRatio.getFontScale` to 2 (mock it). It asserts no
    `allowFontScaling={false}` anywhere in `src` (grep test), and that the Speak dock is outside
    the ScrollView.
- **Reduced motion:** every `Animated` use checks `isReduceMotionEnabled` (MicButton and
  LevelBars already do; check BottomSheet).
- **Contrast:** extend `contrast.test.ts` to the `record`/`onRecord` pair in the dock and
  `muted` on `surface` in both themes. Adjust tokens minimally if needed, and say so.

## 3. Indian scripts and mixed text

- Apply `fontFor(text)` to **every** place that renders transcript, note or brief text:
  - `TranscriptRow`, `TranscriptList`, `TranslationList`;
  - `NoteRow`, `BriefEditor`;
  - History rows and the History detail (check), and search results;
  - the language sheet's native names.
- For mixed-script lines, fall back gracefully: pick the font by the **first** Indic script
  found, since Android falls back for the other glyphs. Document this in `fonts.ts`.
- Use the script-appropriate line height (×1.5 of the font size) for Indic text everywhere
  `fontFor` picks a Noto family. Expose `lineHeightFor(text, size)` from `fonts.ts`.
- **Never** set `letterSpacing` on Indic text. Add a grep test that fails if `letterSpacing`
  appears in a style that is spread into transcript/note text components.
- Tests: render realistic long strings, not lorem ipsum, in each script and mixed, and assert the
  chosen font family and line height. For example:
  - Kannada: ನಾಳೆ ಬೆಳಗ್ಗೆ ಹತ್ತು ಗಂಟೆಗೆ ಸಭೆ ಇದೆ, ದಯವಿಟ್ಟು ಎಲ್ಲರೂ ಸಮಯಕ್ಕೆ ಬನ್ನಿ;
  - Tamil: நாளை காலை பத்து மணிக்கு கூட்டம் இருக்கிறது;
  - Hindi: कल सुबह दस बजे बैठक है, कृपया सभी समय पर आएं;
  - mixed: "Meeting at 10 ನಾಳೆ, please confirm".
- The UI language stays English (no machine-translated UI). Make sure every user-facing string
  on Speak, History, the History detail, Settings, setup, Personal words, keyboard setup and
  Connect goes through `t()`. Add a grep-style test that fails on JSX text literals in those
  files (allow numbers and punctuation).

## 4. Live captions (secondary; built on the existing live stream)

- Entry: the Speak "⋯ More" sheet shows "Live captions" only when the computer is connected and
  the health response shows streaming available (use the existing live/stream status; do not
  invent a capability flag).
- Route `src/app/captions.tsx`:
  - Large, high-contrast text: 28 sp, adjustable with "A−" and "A+" buttons, 20–40 sp,
    persisted.
  - Finalized text appears in `text` colour and provisional text in `muted` italics.
  - Start/Stop uses the same `MicButton`, and a language chip.
  - It creates a session in the Speak event the same way Speak does: refactor and reuse
    `useSpeak` internals; do not copy them.
  - It follows the latest captions. When the user scrolls up, following pauses and a
    "Jump to latest" button appears.
  - A clear "Reconnecting…" status. Finalized segments are kept across reconnects without
    duplicates (the live model is already keyed by sequence; verify this with a test).
  - `useKeepAwake` is active only while recording on this screen.
  - No history list is visible on this screen. No speaker labels and no translation claims.
- Tests:
  - the entry is hidden when not connected;
  - following and "Jump to latest" logic, kept in a pure helper;
  - no duplicate rows after a simulated reconnect replay;
  - keep-awake is active only while listening (mock it).

## 5. Final sweep

- Android Back: the BottomSheet closes first (verify), and Back on the setup steps goes to the
  previous step. Leaving Speak or Captions while recording does not stop the recording.
- Remove dead code left by the redesign:
  - unused components (for example `Collapsible` if it is no longer used, or old `EventList`
    props);
  - unused strings.

  Do not remove anything still used by event screens.
- Update `docs/` where behaviour changed:
  - `docs/event-runbook.md` (Speak, History, captions, keyboard);
  - `android/README.md` (screens, keyboard setup);
  - `docs/test-plan.md` (add manual device tests for the keyboard, permissions, lifecycle
    interruption, large text, TalkBack, both themes, and each Indian script).

## Constraints

- Follow `AGENTS.md`. Never open, print, copy or modify `secrets/`,
  `android/app/google-services.json`, or any `.env`. Do not modify `.gitignore` or `AGENTS.md`.
  Do not run `git commit` or `git push`, and do not change git config.
- No new dependencies beyond `expo-keep-awake`. No network calls in tests.
- Do not change the recording, upload or live pipeline internals beyond what a listed state
  requires. If one needs a pipeline change, make it minimal and test it.
- Do not touch `android/android/` (generated), and do not run Gradle.

## Done when

- `tsc`, `eslint` and `jest` pass (plus the server checks, if the server was touched).
- The final message lists:
  - the files changed with reasons;
  - any token adjusted;
  - an honest list of what could only be verified on a physical device (TalkBack, real font
    rendering, 200% text, microphone contention, keyboard behaviour).
