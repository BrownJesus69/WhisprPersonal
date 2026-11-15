import { Timestamp, getDocFromServer, onSnapshot, setDoc } from '@react-native-firebase/firestore';
import { NOTE_KEYS, toFirestore, fromFirestore, noteRemote } from '../lib/firebase/notes';
import { note } from './noteFixtures';

const wire = () => ({ ...toFirestore(note(),'my-device'), updatedAt: Timestamp.fromDate(new Date(note().updated_at)) });
test('toFirestore emits exact full contract, fixed client creation time and server update time', async () => {
  expect(Object.keys(toFirestore(note(),'my-device')).sort()).toEqual([...NOTE_KEYS].sort());
  expect(toFirestore(note(),'my-device')).toMatchObject({ revision: 1, baseRevision: 0, deviceId: 'my-device', updatedAt: { type: 'server-timestamp' } });
  expect(toFirestore(note(),'my-device').createdAt.toMillis()).toBe(Date.parse(note().created_at));
  await noteRemote.push(note(),'my-device'); expect(jest.mocked(setDoc).mock.calls[0]).toHaveLength(2);
});
test('valid contract round-trips, including nullable values and tombstones', () => {
  expect(fromFirestore(note().id,wire())).toMatchObject({ id: note().id, text: note().text, createdAt: note().created_at, deleted: false });
  expect(fromFirestore(note().id,{ ...wire(), deleted: true, text: '', speaker: null })).toMatchObject({ deleted: true });
});
test.each(NOTE_KEYS)('missing key %s ignored', key => {
  const warn = jest.spyOn(console,'warn').mockImplementation(() => {});
  try { const data: Record<string, unknown> = wire(); delete data[key]; expect(fromFirestore('id',data)).toBeNull(); expect(warn).toHaveBeenCalledWith('invalid_remote_note'); } finally { warn.mockRestore(); }
});
test.each([
  { ownerId: 1 },{ source: 'unknown' },{ text: 1 },{ text: '' },{ text: 'x'.repeat(5001) },
  { speaker: 'x'.repeat(101) },{ speaker: 1 },{ sessionId: 'x'.repeat(129) },{ language: 'x'.repeat(9) },
  { timestampMs: -1 },{ timestampMs: 1.5 },{ sequence: '1' },{ deleted: 1 },{ deleted: true },
  { deleted: true, text: '', speaker: 'uncleared' },{ revision: 0 },{ revision: 1.1 },{ baseRevision: 1 },
  { baseRevision: -1 },{ deviceId: 'short' },{ deviceId: 'x'.repeat(65) },{ createdAt: 'date' },{ updatedAt: null },{ extra: true }
])('malformed doc %# ignored', patch => {
  const warn = jest.spyOn(console,'warn').mockImplementation(() => {});
  try { expect(fromFirestore('id',{ ...wire(), ...patch })).toBeNull(); } finally { warn.mockRestore(); }
});
test('server fetch is uncached and returns null for absent document', async () => {
  jest.mocked(getDocFromServer).mockResolvedValue({ exists: () => false } as never);
  expect(await noteRemote.fetchFromServer('event-1','id')).toBeNull();
  jest.mocked(getDocFromServer).mockResolvedValue({ exists: () => true, data: wire } as never);
  expect((await noteRemote.fetchFromServer('event-1','id'))?.text).toBe(note().text);
});
test('subscription retains both pending and server snapshots with metadata enabled', () => {
  const next = jest.fn(), error = jest.fn();
  noteRemote.subscribe('event-1',next,error);
  const call = jest.mocked(onSnapshot).mock.calls[0] as unknown as [unknown,unknown,(snapshot: unknown) => void,unknown];
  expect(call[1]).toEqual({ includeMetadataChanges: true }); expect(call[3]).toBe(error);
  call[2]({ docs: [true,false].map(pending => ({ id: 'id', data: wire, metadata: { hasPendingWrites: pending } })) });
  expect(next.mock.calls[0][0].map((d: { pending: boolean }) => d.pending)).toEqual([true,false]);
});
