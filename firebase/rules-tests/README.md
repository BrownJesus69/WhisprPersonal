# Firestore rules tests

These tests use only the local Firestore emulator and the demo project. They do not contact
production Firebase. Use the already-installed packages in this directory (Node 24 and Java).

From PowerShell:

```powershell
cd E:\Whispr\firebase\rules-tests
$env:FIREBASE_EMULATORS_PATH = 'E:/whispr-build-cache/firebase-emulators'
$env:XDG_CONFIG_HOME = 'E:/whispr-build-cache/firebase-config'
npm test
```

The command starts the cached emulator on localhost:8080, runs Node's TypeScript tests,
and shuts the emulator down. Leave port 8080 free. If a sandbox prevents binding the port,
run the same command outside that sandbox. No Android or server dependency install is needed.

`notes.test.ts` covers the complete note schema, ownership, compare-and-set, queued writes,
idempotent retries, immutable fields, and tombstones. `existing.test.ts` protects event and
chunk rules from regression.

In a workspace-only sandbox the shared config directory may be read-only. Use
`$env:XDG_CONFIG_HOME = 'E:/Whispr/output/phase7-firebase-config'` instead, and set
`$env:NO_UPDATE_NOTIFIER = '1'` and `$env:CI = 'true'` to disable CLI update checks.
PowerShell installations with script execution disabled can run `npm.cmd test`.
