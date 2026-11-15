import { test, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, serverTimestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({ projectId: 'demo-whisprpersonal', firestore: { rules: readFileSync('../firestore.rules','utf8') } });
after(() => env.cleanup());
const alice = env.authenticatedContext('alice').firestore(), bob = env.authenticatedContext('bob').firestore();
const event = () => ({ ownerId: 'alice', title: 'Event', status: 'draft', createdAt: serverTimestamp(), privacyMode: 'local_only' });
test('existing event owner create/read/update and other-user denial', async () => {
  const target = doc(alice,'events/existing-owner');
  await assertSucceeds(setDoc(target,event())); await assertSucceeds(getDoc(target)); await assertSucceeds(updateDoc(target,{ title: 'Edited' }));
  await assertFails(getDoc(doc(bob,target.path))); await assertFails(updateDoc(doc(bob,target.path),{ title: 'Stolen' }));
  await assertFails(setDoc(doc(bob,'events/existing-other'),event()));
});
test('existing event rejects secret-like keys and changing owner', async () => {
  await assertFails(setDoc(doc(alice,'events/existing-secret'),{ ...event(), secret: 'not-a-secret' }));
  const target = doc(alice,'events/existing-immutable'); await setDoc(target,event());
  await assertFails(updateDoc(target,{ ownerId: 'bob' })); await assertFails(updateDoc(target,{ token: 'not-a-token' }));
});
test('existing chunks keep text limit and ownership checks', async () => {
  await setDoc(doc(alice,'events/existing-chunks'),event());
  const chunk = doc(alice,'events/existing-chunks/sessions/s/chunks/c');
  await assertSucceeds(setDoc(chunk,{ rawText: 'x'.repeat(20000), polishedText: '' }));
  await assertFails(updateDoc(chunk,{ rawText: 'x'.repeat(20001) }));
  await assertFails(updateDoc(chunk,{ polishedText: 'x'.repeat(20001) }));
  await assertFails(getDoc(doc(bob,chunk.path))); await assertFails(updateDoc(doc(bob,chunk.path),{ rawText: 'Stolen' }));
});
