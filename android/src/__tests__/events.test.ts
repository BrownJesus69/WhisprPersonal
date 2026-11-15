import { setDoc, where, orderBy, limit, onSnapshot, Timestamp } from '@react-native-firebase/firestore';
import { createEvent, mapEvent, subscribeMyEvents } from '@/lib/firebase/events';
import type { EventInput } from '@/types/models';
const input: EventInput = {
  title: ' Event ',
  description: '',
  location: 'Hall',
  startTime: Timestamp.fromDate(new Date('2026-11-15T10:00:00Z')),
  endTime: null,
  agenda: '',
  speakers: [],
  languages: ['kn'],
  languageMode: 'auto',
  privacyMode: 'local_only'
};

test('create uses explicit contract keys, uid, and timestamps', async () => {
  await expect(createEvent('owner', input)).resolves.toBe('event-1');
  const data = jest.mocked(setDoc).mock.calls[0][1] as Record<string, unknown>;
  expect(Object.keys(data).sort()).toEqual(['ownerId', 'title', 'description', 'location', 'startTime', 'endTime', 'agenda', 'speakers', 'languages', 'languageMode', 'privacyMode', 'status', 'createdAt', 'updatedAt', 'consentVersion'].sort());
  expect(data).toMatchObject({
    ownerId: 'owner',
    title: 'Event',
    status: 'draft',
    privacyMode: 'local_only',
    createdAt: { type: 'server-timestamp' },
    updatedAt: { type: 'server-timestamp' },
    consentVersion: '2026-11-15'
  });
  expect(data.startTime).toBeInstanceOf(Timestamp);
  expect(Object.keys(data)).not.toEqual(expect.arrayContaining(['apiKey', 'serverKey', 'privateKey', 'secret', 'token']));
});

test('rejects long or empty titles before writing', async () => {
  await expect(createEvent('owner', { ...input, title: 'x'.repeat(201) })).rejects.toThrow('1–200');
  await expect(createEvent('owner', { ...input, title: ' ' })).rejects.toThrow();
  expect(setDoc).not.toHaveBeenCalled();
});

test('query is owner constrained, sorted and limited', () => {
  subscribeMyEvents('owner', jest.fn(), jest.fn());
  expect(where).toHaveBeenCalledWith('ownerId', '==', 'owner');
  expect(orderBy).toHaveBeenCalledWith('updatedAt', 'desc');
  expect(limit).toHaveBeenCalledWith(50);
  expect(onSnapshot).toHaveBeenCalledWith(expect.anything(), { includeMetadataChanges: true }, expect.any(Function), expect.any(Function));
});

test('mapping missing optional fields', () => {
  expect(mapEvent('id', { ownerId: 'owner', title: 'Event' })).toMatchObject({
    id: 'id',
    description: '',
    location: '',
    startTime: null,
    endTime: null,
    speakers: [],
    languages: [],
    languageMode: 'auto',
    privacyMode: 'local_only',
    status: 'draft'
  });
});

test('extra input keys cannot reach Firestore', async () => {
  await createEvent('owner', { ...input, serverKey: 'never-write' } as EventInput);
  expect(jest.mocked(setDoc).mock.calls[0][1]).not.toHaveProperty('serverKey');
});

test('offline: returns the device-generated id without waiting for the server', async () => {
  // A Firestore write promise only settles when the server acknowledges it; offline it never does.
  jest.mocked(setDoc).mockImplementationOnce(() => new Promise<void>(() => undefined));
  await expect(createEvent('owner', input)).resolves.toBe('event-1');
});

test('a later server rejection is reported, not swallowed', async () => {
  jest.mocked(setDoc).mockImplementationOnce(async () => { throw new Error('permission-denied'); });
  const onSyncError = jest.fn();
  await createEvent('owner', input, onSyncError);
  await new Promise(resolve => setImmediate(resolve));
  expect(onSyncError).toHaveBeenCalledWith(expect.objectContaining({ message: 'permission-denied' }));
});
