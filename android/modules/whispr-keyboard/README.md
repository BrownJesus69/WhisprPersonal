# WhisprPersonal voice keyboard

SDK 58 autolinking defaults `nativeModulesDir` to `./modules`. This package's
`package.json`, `expo-module.config.json`, and `android/build.gradle` are discovered
there; `resolve --platform android` lists `WhisprKeyboardModule`. All native sources
live here, outside the generated `android/android` project.

The module reuses the installed RNFirebase auth project's SDK/BOM configuration for
its compile classpath. It introduces no npm packages or external Gradle coordinates.
The key is AES-GCM encrypted using the non-exportable Android Keystore alias
`whispr_keyboard`. No key, token, audio or transcript is logged. Dictation audio stays
in memory until success or Discard; the upload WAV uses app cache and is deleted in
`finally`. Results and audio disappear when the service is destroyed; no history is kept.

`InsertionGuardTest.kt` contains six dependency-free JVM tests callable through its
`main` method: same editor inserts once, changed editor holds the result, duplicate
request ignored, Undo requires exact suffix, password types block recording, and
hidden/missing editor holds the result. These can be compiled directly with Kotlin
2.3.21 and run with Java, without invoking Gradle or adding JUnit. The service must
still be tested on a device after the architect's APK build.

## Limitations and device verification

- Backup exclusion is not declared by the library manifest: the app's existing
  `expo-secure-store` plugin already owns both `fullBackupContent` and
  `dataExtractionRules`. Overriding either would conflict or remove SecureStore's
  exclusion. Consequently the **encrypted keyboard preferences may be backed up**;
  their Keystore key is not backed up. Restored ciphertext fails closed and requires
  opening the app to sync the configuration again. A future app-level combined rules
  plugin can exclude `sharedpref/whispr_keyboard.xml` along with SecureStore.
- Some editors use `fieldId = 0`. Package, input type and input-session generation are
  also checked, but an app that reuses all these and fails to notify Android of field
  changes cannot be distinguished. Enable Review before inserting for such apps.
- Restarting input increments the generation even if the host appears unchanged.
  A result then needs an explicit Insert here tap. Hiding the keyboard holds a result;
  it is not inserted in the background or automatically when the keyboard reopens.
- Android can silence a recorder when another app owns the microphone. The service
  checks `isClientSilenced` where supported and treats read/start failures as busy.
  A background/screen-lock transition may also stop capture under Android's mic rules.
  No foreground recording service is added by the keyboard.
- On-device checks remain: keyboard enable/select flow, native Firebase token refresh,
  microphone contention, 120-second stop, retry and Discard, review, clipboard,
  password fields, editor switches during upload, Undo, Backspace repeat and action keys.
- The setup text explains the one-character spacing read and the additional suffix
  check when Undo is available. Undo never reads elsewhere in the field.
