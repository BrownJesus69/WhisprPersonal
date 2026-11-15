import { test, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, deleteDoc, Timestamp, serverTimestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({ projectId: 'demo-whisprpersonal', firestore: { rules: readFileSync('../firestore.rules','utf8') } });
after(() => env.cleanup());
await env.withSecurityRulesDisabled(async context => { await setDoc(doc(context.firestore(),'events/brief-event'),{ ownerId: 'alice' }); });
const db = env.authenticatedContext('alice').firestore();
let seq = 0;
const ref = () => doc(db,`events/brief-event/briefs/b${++seq}`);
const brief = (patch: Record<string, unknown> = {}) => ({ ownerId: 'alice', type: 'summary', status: 'saved', provider: 'none', model: null,
  generatedText: 'Generated', finalText: 'Reviewed', edited: true, structuredBrief: null, incomplete: false, sessionIds: ['s1'],
  createdAt: Timestamp.fromMillis(1000), updatedAt: serverTimestamp(), ...patch });
test('owner creates reads updates deletes; other and anonymous cannot access', async () => {
  const target = ref(); await assertSucceeds(setDoc(target,brief())); await assertSucceeds(getDoc(target));
  await assertSucceeds(setDoc(target,brief({ finalText: 'Reviewed again' })));
  for (const context of [env.authenticatedContext('bob'),env.unauthenticatedContext()]) {
    const other = doc(context.firestore(),target.path);
    await assertFails(getDoc(other)); await assertFails(setDoc(other,brief())); await assertFails(deleteDoc(other));
  }
  await assertSucceeds(deleteDoc(target));
  await assertFails(setDoc(doc(db,'events/missing/briefs/b'),brief()));
});
for (const type of ['summary','action_items','decisions','follow_ups','full']) test(`brief type ${type}`, async () => { await assertSucceeds(setDoc(ref(),brief({ type }))); });
for (const provider of ['groq','sambanova','local_llm','none']) test(`brief provider ${provider}`, async () => { await assertSucceeds(setDoc(ref(),brief({ provider }))); });
test('maximum bounds and structured map accepted', async () => {
  await assertSucceeds(setDoc(ref(),brief({ model: 'x'.repeat(200), generatedText: 'x'.repeat(100000), finalText: 'x'.repeat(100000), sessionIds: Array(20).fill('s'), structuredBrief: { Summary: ['One'] }, incomplete: true })));
});
for (const key of Object.keys(brief())) test(`required brief field ${key}`, async () => {
  const value: Record<string,unknown> = brief(); delete value[key]; await assertFails(setDoc(ref(),value));
});
const invalid: Record<string,unknown>[] = [
  { ownerId: 'bob' },{ ownerId: 1 },{ type: 'unknown' },{ type: 1 },{ status: 'draft' },{ provider: 'unknown' },{ provider: 1 },
  { model: 1 },{ model: 'x'.repeat(201) },{ generatedText: 1 },{ generatedText: 'x'.repeat(100001) },{ finalText: '' },{ finalText: 1 },{ finalText: 'x'.repeat(100001) },
  { edited: 1 },{ structuredBrief: [] },{ structuredBrief: 'text' },{ incomplete: 1 },{ sessionIds: 's' },{ sessionIds: Array(21).fill('s') },
  { createdAt: 'date' },{ updatedAt: Timestamp.fromMillis(1) },{ extra: true },{ apiKey: 'test-only' },
];
for (const [i, patch] of invalid.entries()) test(`invalid brief case ${i}`, async () => { await assertFails(setDoc(ref(),brief(patch))); });
for (const patch of [{ ownerId: 'bob' },{ createdAt: Timestamp.fromMillis(2000) }]) test(`brief immutable ${Object.keys(patch)[0]}`, async () => {
  const target = ref(); await setDoc(target,brief()); await assertFails(setDoc(target,brief(patch)));
});
test('brief updates also validate the entire contract', async () => {
  const target = ref(); await setDoc(target,brief());
  for (const patch of invalid) await assertFails(setDoc(target,brief(patch)));
});
