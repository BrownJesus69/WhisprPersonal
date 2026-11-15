import { getFirestore, doc, collection, setDoc, getDocFromServer, onSnapshot, query, orderBy, limit, serverTimestamp, Timestamp } from '@react-native-firebase/firestore';
import type { NoteRemote } from '@/lib/notes/noteSync';
import type { Note, RemoteNote } from '@/lib/notes/model';

export const NOTE_KEYS = ['ownerId','source','text','timestampMs','speaker','sessionId','sequence','language','deleted','revision','baseRevision','deviceId','createdAt','updatedAt'] as const;
export function toFirestore(note: Note, deviceId: string) {
  return { ownerId: note.owner_uid, source: note.source, text: note.text, timestampMs: note.timestamp_ms,
    speaker: note.speaker, sessionId: note.session_id, sequence: note.sequence, language: note.language,
    deleted: !!note.deleted, revision: note.revision, baseRevision: note.synced_revision, deviceId,
    createdAt: Timestamp.fromDate(new Date(note.created_at)), updatedAt: serverTimestamp() };
}
const int = (v: unknown, minimum: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= minimum;
const nullableInt = (v: unknown) => v === null || int(v, 0);
const nullableString = (v: unknown, max: number) => v === null || typeof v === 'string' && v.length <= max;
export function fromFirestore(id: string, data: Record<string, unknown>): RemoteNote | null {
  const d = data;
  if (Object.keys(d).length !== NOTE_KEYS.length || !NOTE_KEYS.every(key => Object.hasOwn(d, key)) ||
      typeof d.ownerId !== 'string' || !['manual','transcript','ai'].includes(d.source as string) ||
      typeof d.text !== 'string' || d.text.length > 5000 || typeof d.deleted !== 'boolean' ||
      (d.deleted ? d.text !== '' || d.speaker !== null : d.text.length === 0) ||
      !nullableInt(d.timestampMs) || !nullableInt(d.sequence) || !nullableString(d.speaker,100) ||
      !nullableString(d.sessionId,128) || !nullableString(d.language,8) ||
      !int(d.revision,1) || !int(d.baseRevision,0) || d.baseRevision >= d.revision ||
      typeof d.deviceId !== 'string' || d.deviceId.length < 8 || d.deviceId.length > 64 ||
      !(d.createdAt instanceof Timestamp) || !(d.updatedAt instanceof Timestamp)) {
    console.warn('invalid_remote_note'); return null;
  }
  try {
    return { ...d, id, createdAt: d.createdAt.toDate().toISOString(), updatedAt: d.updatedAt.toDate().toISOString() } as RemoteNote;
  } catch { console.warn('invalid_remote_note'); return null; }
}
export const noteRemote: NoteRemote = {
  push: (note, deviceId) => setDoc(doc(getFirestore(), 'events', note.event_id, 'notes', note.id), toFirestore(note,deviceId)),
  async fetchFromServer(eventId, id) {
    const snapshot = await getDocFromServer(doc(getFirestore(),'events',eventId,'notes',id));
    return snapshot.exists() ? fromFirestore(id,snapshot.data() ?? {}) : null;
  },
  subscribe(eventId,next,error) {
    return onSnapshot(query(collection(getFirestore(),'events',eventId,'notes'),orderBy('createdAt'),limit(500)),
      { includeMetadataChanges: true }, snapshot => {
        next(snapshot.docs.flatMap(d => {
          const note = fromFirestore(d.id,d.data({ serverTimestamps: 'estimate' }));
          return note ? [{ note, pending: d.metadata.hasPendingWrites }] : [];
        }));
      }, error);
  }
};
