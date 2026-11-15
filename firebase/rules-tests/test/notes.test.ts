import { test, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, deleteDoc, Timestamp, serverTimestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({ projectId: 'demo-whisprpersonal', firestore: { rules: readFileSync('../firestore.rules','utf8') } });
after(() => env.cleanup());
await env.withSecurityRulesDisabled(async context => {
  await setDoc(doc(context.firestore(),'events/notes-event'),{ ownerId: 'alice' });
});
const db = env.authenticatedContext('alice').firestore();
let sequence = 0;
const ref = () => doc(db,`events/notes-event/notes/n${++sequence}`);
const note = (patch: Record<string, unknown> = {}) => ({ ownerId: 'alice', source: 'manual', text: 'Note',
  timestampMs: null, speaker: null, sessionId: null, sequence: null, language: null, deleted: false,
  revision: 1, baseRevision: 0, deviceId: 'device-alice', createdAt: Timestamp.fromMillis(1000), updatedAt: serverTimestamp(), ...patch });

test('owner creates/reads/deletes a valid note; others and anonymous are denied', async () => {
  const target = ref(); await assertSucceeds(setDoc(target,note())); await assertSucceeds(getDoc(target));
  for (const context of [env.authenticatedContext('bob'),env.unauthenticatedContext()]) {
    const other = doc(context.firestore(),target.path);
    await assertFails(getDoc(other)); await assertFails(setDoc(other,note({ revision: 2 }))); await assertFails(deleteDoc(other));
  }
  await assertSucceeds(deleteDoc(target));
});
test('note requires owned parent event', async () => {
  await assertFails(setDoc(doc(db,'events/missing/notes/n'),note()));
});
test('all nullable fields and integer boundaries are accepted', async () => {
  await assertSucceeds(setDoc(ref(),note({ text: 'x'.repeat(5000), timestampMs: 0, sequence: 0,
    speaker: 'x'.repeat(100), sessionId: 'x'.repeat(128), language: 'x'.repeat(8), deviceId: 'x'.repeat(64) })));
});
for (const source of ['manual','transcript','ai']) test(`source ${source} allowed`, async () => {
  await assertSucceeds(setDoc(ref(),note({ source })));
});
for (const key of Object.keys(note())) test(`required field ${key}`, async () => {
  const value: Record<string, unknown> = note(); delete value[key]; await assertFails(setDoc(ref(),value));
});
const invalid: Record<string, unknown>[] = [
  { ownerId: 'bob' },{ ownerId: 1 },{ source: 'unknown' },{ source: 1 },{ text: 1 },{ text: '' },{ text: 'x'.repeat(5001) },
  { timestampMs: -1 },{ timestampMs: 1.5 },{ timestampMs: '0' },{ speaker: 1 },{ speaker: 'x'.repeat(101) },
  { sessionId: 1 },{ sessionId: 'x'.repeat(129) },{ sequence: -1 },{ sequence: 1.5 },{ sequence: '0' },
  { language: 1 },{ language: 'x'.repeat(9) },{ deleted: 1 },{ deleted: true },{ deleted: true, text: '', speaker: 'not cleared' },
  { revision: 0 },{ revision: 1.5 },{ revision: '1' },{ baseRevision: -1 },{ baseRevision: 1 },{ baseRevision: 0.5 },
  { deviceId: 'short' },{ deviceId: 'x'.repeat(65) },{ deviceId: 1 },{ createdAt: 'date' },{ updatedAt: Timestamp.fromMillis(1) },
  { extra: true },{ apiKey: 'not-a-key' },{ secret: 'not-a-secret' }
];
for (const [index,patch] of invalid.entries()) test(`invalid field case ${index}: ${Object.keys(patch).join(',')}`, async () => {
  await assertFails(setDoc(ref(),note(patch)));
});
test('clause 1: other device edits latest server version with CAS', async () => {
  const target = ref(); await setDoc(target,note());
  await assertSucceeds(setDoc(target,note({ text: 'New device', revision: 2, baseRevision: 1, deviceId: 'device-other' })));
});
test('clause 2: same device advances queued writes even with an old base', async () => {
  const target = ref(); await setDoc(target,note());
  await assertSucceeds(setDoc(target,note({ text: 'Next', revision: 3, baseRevision: 0 })));
});
test('clause 3: idempotent re-push permits only updatedAt and baseRevision differences', async () => {
  const target = ref(); await setDoc(target,note({ revision: 3 }));
  await assertSucceeds(setDoc(target,note({ revision: 3, baseRevision: 2 })));
  await assertFails(setDoc(target,note({ text: 'Different text', revision: 3, baseRevision: 2 })));
  await assertFails(setDoc(target,note({ revision: 3, baseRevision: 2, deviceId: 'device-other' })));
});
test('stale update on another device cannot silently lose the newer edit', async () => {
  const target = ref(); await setDoc(target,note({ revision: 3 }));
  await assertFails(setDoc(target,note({ revision: 4, baseRevision: 1, deviceId: 'device-other' })));
  await assertFails(setDoc(target,note({ revision: 2, baseRevision: 1 })));
});
for (const patch of [{ createdAt: Timestamp.fromMillis(2000) },{ ownerId: 'bob' },{ source: 'transcript' }]) test(`immutable ${Object.keys(patch)[0]}`, async () => {
  const target = ref(); await setDoc(target,note()); await assertFails(setDoc(target,note({ revision: 2, baseRevision: 1, ...patch })));
});
test('tombstone is valid and stale other-device text cannot resurrect it', async () => {
  const target = ref(); await setDoc(target,note());
  await assertSucceeds(setDoc(target,note({ revision: 2, baseRevision: 1, deleted: true, text: '' })));
  await assertFails(setDoc(target,note({ revision: 3, baseRevision: 1, deviceId: 'device-other' })));
});
