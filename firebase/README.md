# Firestore deployment and testing

No credentials or project configuration need to be stored in this repository. Authenticate
with the Firebase CLI locally and select your own project explicitly:

```sh
firebase deploy --only firestore:rules,firestore:indexes --project <your-project-id>
```

For local rules testing, run `firebase emulators:start --only firestore --project <your-demo-project-id>`.
Use the Firebase rules unit testing SDK against the emulator with authenticated and unauthenticated
contexts. Test owner and other-user reads, owner-constrained event queries, owner changes,
invalid enums, secret fields, oversized chunk text, and all nested collections. Choose an
emulator-only project identifier with the `demo-` prefix. To run a local rules suite:

```sh
firebase emulators:exec --only firestore --project <your-demo-project-id> "<your-rules-test-command>"
```

Java and the Firebase CLI are required.
No emulator or live deployment is run by the server test suite.

The Admin SDK bypasses these rules. The server must check ownership independently.
The collection indexes support owner-filtered home/status queries, notes by timestamp,
and briefs by creation time. Deploy indexes before depending on those queries.
