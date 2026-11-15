import { validateNoteInput, normalizeSearch, escapeLike, newNoteId, mergeRemote, onRejected } from '../lib/notes/model';
import { note, remote } from './noteFixtures';
import { deviceId } from '../lib/notes/deviceId';
import { kv } from '../lib/storage/kv';

test.each(['', '  ', 'x'.repeat(5001)])('invalid text rejected (%#)', text => expect(() => validateNoteInput({ text })).toThrow());
test('validation trims and accepts boundary values', () => {
  expect(validateNoteInput({ text: ' hello ', speaker: 'x'.repeat(100) }).text).toBe('hello');
  expect(validateNoteInput({ text: 'x'.repeat(5000) }).text).toHaveLength(5000);
});
test.each([{ speaker: 'x'.repeat(101) },{ timestampMs: -1 },{ sequence: 0.5 },{ sessionId: 'x'.repeat(129) },{ language: 'x'.repeat(9) },{ source: 'bad' }])('invalid metadata %#', patch => {
  expect(() => validateNoteInput({ text: 'ok', ...patch } as Parameters<typeof validateNoteInput>[0])).toThrow();
});
test.each(['ಕನ್ನಡದ ಟಿಪ್ಪಣಿಗಳು', 'தமிழ் குறிப்புகள்', 'हिन्दी नोट्स', 'École ABC'])('NFC search preserves marks %s', text => {
  expect(normalizeSearch(text.normalize('NFD'))).toBe(text.normalize('NFC').toLocaleLowerCase());
});
test('LIKE escapes literals and ids use UUID hex', () => {
  expect(escapeLike('a%_\\b')).toBe('a\\%\\_\\\\b');
  expect(newNoteId()).toMatch(/^note_[a-f0-9]{32}$/);
});
test('per-install device id is persisted and concurrent requests share one value', async () => {
  const [first,second] = await Promise.all([deviceId(),deviceId()]);
  expect(first).toBe(second); expect(await kv.getItem('notes.deviceId')).toBe(first);
  expect(first.length).toBeGreaterThanOrEqual(8); expect(first.length).toBeLessThanOrEqual(64);
});
test('merge inserts unseen tombstones and ignores stale server versions', () => {
  expect(mergeRemote(null,remote({ deleted: true, text: '' }),'mine').type).toBe('apply');
  expect(mergeRemote(note({ synced_revision: 2 }),remote(),'mine').type).toBe('ignore');
  expect(mergeRemote(note(),remote({ ownerId: 'stranger' }),'mine').type).toBe('ignore');
});
test('merge acknowledges own device; applies clean copies; preserves pending, conflict and failed text', () => {
  expect(mergeRemote(note(),remote({ deviceId: 'mine' }),'mine')).toEqual({ type: 'ack', revision: 2 });
  expect(mergeRemote(note({ sync_state: 'synced', revision: 1, synced_revision: 1 }),remote(),'mine').type).toBe('apply');
  // Same safety net if a row claims synced while holding an unpublished revision.
  expect(mergeRemote(note({ sync_state: 'synced', revision: 2, synced_revision: 1 }),remote({ revision: 3 }),'mine').type).toBe('conflict');
  // A rejected (failed) edit is unpublished local text: another device's version must not erase it.
  for (const sync_state of ['pending','conflict','failed'] as const) expect(mergeRemote(note({ sync_state }),remote(),'mine').type).toBe('conflict');
});
test('rejected missing/wrong owner fails; own newer revision acks; others and own stale conflict', () => {
  expect(onRejected(note(),null,'mine')).toEqual({ type: 'failed', code: 'rejected' });
  expect(onRejected(note(),remote({ ownerId: 'stranger' }),'mine').type).toBe('failed');
  expect(onRejected(note(),remote({ deviceId: 'mine' }),'mine',2)).toEqual({ type: 'ack', revision: 2 });
  expect(onRejected(note(),remote({ deviceId: 'mine' }),'mine',3).type).toBe('conflict');
  expect(onRejected(note(),remote(),'mine').type).toBe('conflict');
});
test('a stale cloud snapshot cannot replace newer conflict evidence or its tombstone', () => {
  const local = note({ sync_state: 'conflict', remote_json: JSON.stringify(remote({ revision: 5, deleted: true, text: '' })) });
  expect(mergeRemote(local,remote({ revision: 4 }),'mine').type).toBe('ignore');
  expect(mergeRemote(local,remote({ revision: 6 }),'mine').type).toBe('conflict');
  expect(mergeRemote(local,remote({ revision: 4, deviceId: 'mine' }),'mine').type).toBe('ack');
});
