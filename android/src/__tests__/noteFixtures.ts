import type { Note, RemoteNote } from '../lib/notes/model';
export function note(patch: Partial<Note> = {}): Note {
  return { id: 'note_12345678901234567890123456789012', event_id: 'event-1', owner_uid: 'owner',
    session_id: null, sequence: null, source: 'manual', text: 'Local note', search_text: 'local note ',
    timestamp_ms: null, speaker: null, language: null, deleted: 0, revision: 1, synced_revision: 0,
    remote_device: null, sync_state: 'pending', remote_json: null, last_error: null, attempts: 0,
    next_attempt_at: 0, created_at: '2026-11-15T00:00:00.000Z', updated_at: '2026-11-15T00:00:00.000Z', ...patch };
}
export function remote(patch: Partial<RemoteNote> = {}): RemoteNote {
  return { id: note().id, ownerId: 'owner', source: 'manual', text: 'Cloud note', timestampMs: null,
    speaker: null, sessionId: null, sequence: null, language: null, deleted: false, revision: 2,
    baseRevision: 1, deviceId: 'other-device', createdAt: note().created_at, updatedAt: note().updated_at, ...patch };
}
