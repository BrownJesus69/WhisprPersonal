import { getFirestore, collection, doc, setDoc, getDoc, getDocFromCache, updateDoc, query, where, orderBy, limit, onSnapshot, serverTimestamp, Timestamp } from '@react-native-firebase/firestore';
import { config } from '@/lib/config';
import { EVENT_STATUSES, LANGUAGES, type EventInput, type EventModel, type EventStatus } from '@/types/models';

export function validateEvent(input: EventInput) {
  if (!input.title.trim() || input.title.trim().length > 200)
    throw new Error('Enter a title of 1–200 characters');
  if (!['local_only', 'cloud_ai'].includes(input.privacyMode))
    throw new Error('Choose a privacy mode');
  if (input.languages.some(code => !LANGUAGES.some(l => l.code === code)) || !['auto', ...LANGUAGES.map(l => l.code)].includes(input.languageMode))
    throw new Error('Choose supported languages');
  if (input.startTime && input.endTime && input.endTime.toMillis() <= input.startTime.toMillis())
    throw new Error('End time must be after start time');
}

/** Reports a write the server later rejected (e.g. rules) after the UI already moved on. */
export type SyncErrorHandler = (error: Error) => void;

function background(write: Promise<unknown>, onSyncError?: SyncErrorHandler) {
  write.catch(error => onSyncError?.(error instanceof Error ? error : new Error('The change could not be saved to the cloud')));
}

/**
 * Creates the event in Firestore's local cache and returns its id immediately.
 *
 * Firestore write promises resolve only when the SERVER acknowledges the write, so awaiting
 * them hangs indefinitely offline (event-day venues often have no internet). The id is
 * generated on the device; the write syncs whenever connectivity returns. A later server-side
 * rejection is reported through `onSyncError`.
 */
export async function createEvent(uid: string, input: EventInput, onSyncError?: SyncErrorHandler) {
  validateEvent(input);
  if (!uid)
    throw new Error('Sign in to create an event');
  const { title, description, location, startTime, endTime, agenda, speakers, languages, languageMode, privacyMode } = input;
  const ref = doc(collection(getFirestore(), 'events'));
  background(setDoc(ref, {
    ownerId: uid,
    title: title.trim(),
    description,
    location,
    startTime,
    endTime,
    agenda,
    speakers,
    languages,
    languageMode,
    privacyMode,
    status: 'draft',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    consentVersion: config.consentVersion
  }), onSyncError);
  return ref.id;
}

/** Applies locally at once; syncs in the background (see createEvent for why). */
export function updateEventStatus(id: string, status: EventStatus, onSyncError?: SyncErrorHandler) {
  if (!EVENT_STATUSES.includes(status))
    throw new Error('Invalid event status');
  background(updateDoc(doc(getFirestore(), 'events', id), { status, updatedAt: serverTimestamp() }), onSyncError);
}

function timestamp(value: unknown): Timestamp | null {
  return value instanceof Timestamp ? value : null;
}

export function mapEvent(id: string, data: Record<string, unknown>): EventModel {
  return {
    id,
    ownerId: String(data.ownerId ?? ''),
    title: String(data.title ?? ''),
    description: String(data.description ?? ''),
    location: String(data.location ?? ''),
    startTime: timestamp(data.startTime),
    endTime: timestamp(data.endTime),
    agenda: String(data.agenda ?? ''),
    speakers: Array.isArray(data.speakers) ? data.speakers.filter((v): v is string => typeof v === 'string') : [],
    languages: Array.isArray(data.languages) ? LANGUAGES.filter(l => (data.languages as unknown[]).includes(l.code)).map(l => l.code) : [],
    languageMode: LANGUAGES.some(l => l.code === data.languageMode) ? data.languageMode as EventModel['languageMode'] : 'auto',
    status: EVENT_STATUSES.includes(data.status as EventStatus) ? data.status as EventStatus : 'draft',
    createdAt: timestamp(data.createdAt),
    updatedAt: timestamp(data.updatedAt),
    consentVersion: String(data.consentVersion ?? ''),
    privacyMode: data.privacyMode === 'cloud_ai' ? 'cloud_ai' : 'local_only'
  };
}

export function subscribeMyEvents(uid: string, next: (events: EventModel[], fromCache: boolean) => void, error: (error: Error) => void) {
  return onSnapshot(query(collection(getFirestore(), 'events'), where('ownerId', '==', uid), orderBy('updatedAt', 'desc'), limit(50)), { includeMetadataChanges: true }, snapshot => next(snapshot.docs.map(d => mapEvent(d.id, d.data())), snapshot.metadata.fromCache), error);
}

export async function getEvent(id: string, uid: string) {
  const snapshot = await getDoc(doc(getFirestore(), 'events', id));
  if (!snapshot.exists())
    return null;
  const event = mapEvent(snapshot.id, snapshot.data() ?? {});
  if (event.ownerId !== uid)
    throw new Error('Event is not available');
  return event;
}


/** Export must be usable with just the metadata already opened on this phone. */
export async function getCachedEvent(id: string, uid: string) {
  const snapshot = await getDocFromCache(doc(getFirestore(),'events',id));
  if (!snapshot.exists()) return null;
  const event = mapEvent(snapshot.id,snapshot.data() ?? {});
  if (event.ownerId !== uid) throw new Error('Event is not available');
  return event;
}
